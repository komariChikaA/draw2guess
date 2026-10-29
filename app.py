"""Shared drawing-game word banks. Python 3.10+, SQLite, WSGI."""
import argparse
from contextlib import contextmanager
import hashlib
import hmac
import json
import logging
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import time
import unicodedata
import zlib
from urllib.parse import parse_qs

ROOT = Path(__file__).resolve().parent
MAX_BODY = 65536
COLORS = {"mint", "peach", "lavender", "blue", "yellow"}
MAX_LIBRARIES = 2000
MAX_WORDS = 100000
OWNER_RE = re.compile(r"^[A-Za-z0-9_-]{32,64}$")
SIMILAR_LIMIT = 12
KANA_FOLD = str.maketrans({chr(code): chr(code - 0x60) for code in range(0x30A1, 0x30F7)})
LATIN_TOKEN_RE = re.compile(r"[a-z0-9]+")
COOKIE_NAME = "huacai_session"
COOKIE_MAX_AGE = 30 * 24 * 60 * 60
PBKDF2_ITERATIONS = 200000
USERNAME_RE = re.compile(r"[A-Za-z0-9_\-\u4e00-\u9fff]{3,24}")
LOG = logging.getLogger("huacai")


class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def clean(value, label, maximum, required=False):
    if not isinstance(value, str):
        raise APIError(400, label + "需要是文字")
    value = " ".join(unicodedata.normalize("NFKC", value).split())
    if any(unicodedata.category(c).startswith("C") for c in value):
        raise APIError(400, label + "含有不支持的字符")
    if len(value) > maximum or (required and not value):
        raise APIError(400, label + "请填写" + ("1～" if required else "不超过") + str(maximum) + "个字")
    return value


def owner_key(value, required=False):
    if value in (None, ""):
        if required:
            raise APIError(400, "缺少身份凭证")
        return ""
    if not isinstance(value, str) or not OWNER_RE.fullmatch(value):
        raise APIError(400, "身份凭证无效")
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def owned_by(stored, given):
    return bool(stored) and bool(given) and hmac.compare_digest(stored, given)


def edit_distance(left, right, limit):
    if left == right:
        return 0
    if abs(len(left) - len(right)) > limit:
        return limit + 1
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for i, left_char in enumerate(left, 1):
        current = [i]
        lowest = i
        for j, right_char in enumerate(right, 1):
            insert = current[-1] + 1
            delete = previous[j] + 1
            replace = previous[j - 1] + (left_char != right_char)
            value = insert if insert < delete else delete
            if replace < value:
                value = replace
            current.append(value)
            if value < lowest:
                lowest = value
        if lowest > limit:
            return limit + 1
        previous = current
    return previous[-1]


def comparison_key(value):
    """Fold width, case, accents, kana, whitespace and punctuation for matching."""
    value = unicodedata.normalize("NFKD", value).casefold().translate(KANA_FOLD)
    return "".join(
        char
        for char in value
        if not unicodedata.combining(char) and unicodedata.category(char)[0] in "LN"
    )


def latin_tokens(value):
    value = unicodedata.normalize("NFKD", value).casefold()
    value = "".join(char for char in value if not unicodedata.combining(char))
    return LATIN_TOKEN_RE.findall(value)


def similar_score(query, word, word_key=None, query_key=None, query_tokens=None):
    if query.casefold() == word.casefold():
        return 1.0, "完全相同"

    query_key = comparison_key(query) if query_key is None else query_key
    word_key = comparison_key(word) if word_key is None else word_key
    if query_key and query_key == word_key:
        return 0.99, "仅写法不同（大小写/空格/符号）"

    if query_key and word_key:
        if query_key in word_key or word_key in query_key:
            query_shorter = len(query_key) <= len(word_key)
            short, long = (query_key, word_key) if query_shorter else (word_key, query_key)
            if len(short) > 1 or len(long) <= 3:
                # Three letters or fewer are too noisy as bare substrings.
                boundary_ok = not (len(short) <= 3 and short.isascii() and short.isalnum())
                if not boundary_ok:
                    longer_text = word if query_shorter else query
                    boundary_ok = short in latin_tokens(longer_text)
                if boundary_ok:
                    score = min(0.97, round(0.8 + 0.17 * len(short) / len(long), 4))
                    return score, "现有词条包含该词" if query_shorter else "该词包含现有词条"

        query_tokens = latin_tokens(query) if query_tokens is None else query_tokens
        if len(query_tokens) >= 2:
            word_tokens = latin_tokens(word)
        else:
            word_tokens = []
        if len(word_tokens) >= 2:
            query_join, word_join = "".join(query_tokens), "".join(word_tokens)
            if (
                len(query_join) >= 0.8 * len(query_key)
                and len(word_join) >= 0.8 * len(word_key)
                and (set(query_tokens) <= set(word_tokens) or set(word_tokens) <= set(query_tokens))
            ):
                return 0.9, "词序不同或名称相近"

    query_len, word_len = len(query_key), len(word_key)
    if min(query_len, word_len) < 2:
        return 0, ""
    longest = max(query_len, word_len)
    limit = 1 if longest <= 4 else max(1, longest // 4)
    if abs(query_len - word_len) > limit or not set(query_key) & set(word_key):
        return 0, ""
    distance = edit_distance(query_key, word_key, limit)
    if distance > limit:
        return 0, ""
    score = round(1 - distance / longest, 4)
    if distance == 1 or score >= 0.72:
        return score, "字形相近"
    return 0, ""


def similar_matches(query, rows, word_keys):
    ranked = []
    query_key = comparison_key(query)
    query_tokens = latin_tokens(query)
    for row, word_key in zip(rows, word_keys):
        score, reason = similar_score(query, row["text"], word_key, query_key, query_tokens)
        if score <= 0:
            continue
        ranked.append((score, -len(word_key), row["id"], {
            "id": row["id"],
            "text": row["text"],
            "contributor": row["contributor"],
            "score": score,
            "reason": reason,
        }))
    ranked.sort(reverse=True)
    return [item[3] for item in ranked[:SIMILAR_LIMIT]]


class Application:
    def __init__(self, db_path, seed=False, randomize_seats=True, require_accounts=True, min_library_words=50):
        self.db_path = str(db_path)
        self.randomize_seats = randomize_seats
        self.require_accounts = require_accounts
        self.min_library_words = min_library_words
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS libraries (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    name_key TEXT NOT NULL UNIQUE,
                    description TEXT NOT NULL DEFAULT '',
                    color TEXT NOT NULL DEFAULT 'mint',
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                );
                CREATE TABLE IF NOT EXISTS words (
                    id INTEGER PRIMARY KEY,
                    library_id INTEGER NOT NULL REFERENCES libraries(id),
                    text TEXT NOT NULL,
                    text_key TEXT NOT NULL,
                    contributor TEXT NOT NULL DEFAULT '',
                    owner_key TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                    UNIQUE(library_id, text_key)
                );
                CREATE INDEX IF NOT EXISTS words_library ON words(library_id, id DESC);
                CREATE TABLE IF NOT EXISTS rate_limits (
                    client TEXT NOT NULL,
                    action TEXT NOT NULL,
                    bucket INTEGER NOT NULL,
                    count INTEGER NOT NULL,
                    PRIMARY KEY(client, action, bucket)
                );
                CREATE TABLE IF NOT EXISTS accounts (
                    id INTEGER PRIMARY KEY,
                    username TEXT NOT NULL,
                    username_key TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                );
                CREATE TABLE IF NOT EXISTS account_sessions (
                    token_hash TEXT PRIMARY KEY,
                    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                    created_at REAL NOT NULL,
                    last_seen REAL NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS account_session_expiry ON account_sessions(expires_at);
            """)
            if seed and not db.execute("SELECT 1 FROM libraries LIMIT 1").fetchone():
                samples = [
                    ("galgame题库", "", "mint", []),
                    ("小众宝藏题库", "", "mint", []),
                ]
                for name, description, color, words in samples:
                    cursor = db.execute("INSERT INTO libraries(name,name_key,description,color) VALUES(?,?,?,?)", (name, name.casefold(), description, color))
                    db.executemany("INSERT INTO words(library_id,text,text_key,contributor) VALUES(?,?,?,?)", [(cursor.lastrowid, w, w.casefold(), "初始词条") for w in words])
            columns = {row[1] for row in db.execute("PRAGMA table_info(words)")}
            if "owner_key" not in columns:
                db.execute("ALTER TABLE words ADD COLUMN owner_key TEXT NOT NULL DEFAULT ''")
        from game import GameService
        self.game_error, self.game_clean = APIError, clean
        self.game = GameService(self)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=15000")
        db.execute("PRAGMA max_page_count=65536")
        db.execute("PRAGMA journal_size_limit=8388608")
        db.execute("PRAGMA wal_autocheckpoint=1000")
        try:
            with db:
                yield db
        finally:
            db.close()

    def library(self, db, library_id):
        row = db.execute("SELECT l.id,l.name,l.description,l.color,l.created_at,COUNT(w.id) word_count FROM libraries l LEFT JOIN words w ON w.library_id=l.id WHERE l.id=? GROUP BY l.id", (library_id,)).fetchone()
        if row is None:
            raise APIError(404, "这个题库不存在，返回首页看看吧")
        return dict(row)

    def body(self, env, maximum=MAX_BODY):
        if env.get("CONTENT_TYPE", "").split(";")[0].strip().lower() != "application/json":
            raise APIError(415, "请使用 JSON 提交")
        try:
            length = int(env.get("CONTENT_LENGTH") or 0)
        except (TypeError, ValueError):
            raise APIError(400, "请求长度无效")
        if length < 0 or length > maximum:
            raise APIError(413, "这次提交太长了，请分几次添加")
        try:
            data = json.loads(env["wsgi.input"].read(length).decode("utf-8"))
        except (ValueError, UnicodeError):
            raise APIError(400, "提交内容格式有误")
        if not isinstance(data, dict):
            raise APIError(400, "提交内容需要是对象")
        return data

    def check_origin(self, env):
        if env.get("HTTP_SEC_FETCH_SITE") == "cross-site":
            raise APIError(403, "请从本站页面操作")
        origin = env.get("HTTP_ORIGIN")
        if origin:
            expected = env.get("wsgi.url_scheme", "http") + "://" + env.get("HTTP_HOST", env.get("SERVER_NAME", "localhost"))
            if origin.rstrip("/").lower() != expected.lower():
                raise APIError(403, "请从本站页面操作")

    def limit(self, db, env, action):
        # SQLite coordinates limits across all worker processes. Never trust X-Forwarded-For.
        client = env.get("REMOTE_ADDR", "unknown")
        bucket = int(time.time()) // 60
        maximum = {"library": 5, "auth": 30}.get(action, 30)
        db.execute("DELETE FROM rate_limits WHERE bucket < ?", (bucket - 2,))
        db.execute("INSERT INTO rate_limits(client,action,bucket,count) VALUES(?,?,?,1) ON CONFLICT(client,action,bucket) DO UPDATE SET count=count+1", (client, action, bucket))
        count = db.execute("SELECT count FROM rate_limits WHERE client=? AND action=? AND bucket=?", (client, action, bucket)).fetchone()[0]
        if count > maximum:
            raise APIError(429, "操作有点快，请一分钟后再试")

    def request_owner(self, env, data=None, required=False):
        value = ""
        if isinstance(data, dict):
            value = data.get("owner", "")
        if value in (None, ""):
            value = env.get("HTTP_X_HUACAI_OWNER", "")
        try:
            return owner_key(value, required=required)
        except APIError:
            if required:
                raise
            return ""

    def check_storage(self):
        if shutil.disk_usage(Path(self.db_path).parent).free < 512 * 1024 * 1024:
            raise APIError(507, "存储空间暂时不足，请联系站点维护者")

    def cookies(self, env):
        result = {}
        for part in (env.get("HTTP_COOKIE") or "").split(";"):
            if "=" in part:
                key, value = part.split("=", 1)
                result[key.strip()] = value.strip()
        return result

    def session_token(self, env):
        value = self.cookies(env).get(COOKIE_NAME, "")
        return value if OWNER_RE.fullmatch(value) else ""

    def session_cookie(self, token):
        return f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={COOKIE_MAX_AGE}"

    def clear_cookie(self):
        return f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"

    def current_account(self, db, env):
        token = self.session_token(env)
        if not token:
            return None
        hashed = hashlib.sha256(token.encode("ascii")).hexdigest()
        row = db.execute(
            "SELECT a.id,a.username,s.expires_at,s.last_seen FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=?",
            (hashed,),
        ).fetchone()
        if row is None:
            return None
        now = time.time()
        if row["expires_at"] <= now:
            db.execute("DELETE FROM account_sessions WHERE token_hash=?", (hashed,))
            return None
        if now - row["last_seen"] > 300:
            db.execute("UPDATE account_sessions SET last_seen=? WHERE token_hash=?", (now, hashed))
        return {"id": row["id"], "username": row["username"]}

    def new_session(self, db, account_id):
        now = time.time()
        token = secrets.token_urlsafe(32)
        hashed = hashlib.sha256(token.encode("ascii")).hexdigest()
        db.execute("DELETE FROM account_sessions WHERE expires_at <= ?", (now,))
        db.execute(
            "INSERT INTO account_sessions(token_hash,account_id,created_at,last_seen,expires_at) VALUES(?,?,?,?,?)",
            (hashed, account_id, now, now, now + COOKIE_MAX_AGE),
        )
        return token

    def password_digest(self, password, salt):
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS).hex()

    def auth_payload(self, db, account):
        return {
            "account": {"id": account["id"], "username": account["username"]},
            "active_room": self.game.active_room(db, account["id"], self.game.clock()),
        }

    def auth_api(self, env, path, method):
        if path not in {"/api/auth/me", "/api/auth/register", "/api/auth/login", "/api/auth/logout"}:
            raise APIError(404, "没有找到这个账号接口")
        if path == "/api/auth/me":
            if method not in {"GET", "HEAD"}:
                raise APIError(405, "此操作暂不支持")
            with self.connect() as db:
                account = self.current_account(db, env)
                if account is None:
                    return 200, {"account": None, "active_room": None}
                return 200, self.auth_payload(db, account)
        if method != "POST":
            raise APIError(405, "此操作暂不支持")
        self.check_origin(env)
        with self.connect() as db:
            if path == "/api/auth/logout":
                token = self.session_token(env)
                if token:
                    db.execute("DELETE FROM account_sessions WHERE token_hash=?", (hashlib.sha256(token.encode("ascii")).hexdigest(),))
                return 200, {"logged_out": True, "__set_cookie__": self.clear_cookie()}
            self.limit(db, env, "auth")
            data = self.body(env)
            username = clean(data.get("username"), "账号", 24, True)
            if not USERNAME_RE.fullmatch(username):
                raise APIError(400, "账号需为 3～24 位中文、字母、数字、下划线或短横线")
            password = data.get("password")
            if not isinstance(password, str) or not 6 <= len(password) <= 72 or any(unicodedata.category(char).startswith("C") for char in password):
                raise APIError(400, "密码需为 6～72 个字符，且不能包含控制字符")
            key = username.casefold()
            if path == "/api/auth/register":
                salt = secrets.token_hex(16)
                try:
                    cursor = db.execute("INSERT INTO accounts(username,username_key,password_hash,salt) VALUES(?,?,?,?)", (username, key, self.password_digest(password, salt), salt))
                except sqlite3.IntegrityError:
                    raise APIError(409, "这个账号已经注册，请直接登录")
                account = {"id": cursor.lastrowid, "username": username}
                token = self.new_session(db, account["id"])
                result = self.auth_payload(db, account)
                result["__set_cookie__"] = self.session_cookie(token)
                return 201, result
            row = db.execute("SELECT id,username,password_hash,salt FROM accounts WHERE username_key=?", (key,)).fetchone()
            if row is None or not hmac.compare_digest(row["password_hash"], self.password_digest(password, row["salt"])):
                raise APIError(401, "账号或密码不正确")
            account = {"id": row["id"], "username": row["username"]}
            token = self.new_session(db, account["id"])
            result = self.auth_payload(db, account)
            result["__set_cookie__"] = self.session_cookie(token)
            return 200, result

    def api(self, env, path, method):
        if method not in {"GET", "HEAD", "POST", "DELETE"}:
            raise APIError(405, "此操作暂不支持")
        if method in {"POST", "DELETE"}:
            self.check_origin(env)
        with self.connect() as db:
            if path == "/api/libraries":
                if method in {"GET", "HEAD"}:
                    rows = db.execute("SELECT l.id,l.name,l.description,l.color,l.created_at,COUNT(w.id) word_count FROM libraries l LEFT JOIN words w ON w.library_id=l.id GROUP BY l.id ORDER BY l.id ASC").fetchall()
                    return 200, {"libraries": [dict(r) for r in rows], "total_words": sum(r["word_count"] for r in rows)}
                if method != "POST":
                    raise APIError(405, "此操作暂不支持")
                data = self.body(env)
                name = clean(data.get("name"), "题库名称", 40, True)
                description = clean(data.get("description", ""), "题库简介", 160)
                color = data.get("color", "mint")
                if not isinstance(color, str) or color not in COLORS:
                    raise APIError(400, "请选择有效的题库颜色")
                self.check_storage()
                self.limit(db, env, "library")
                if db.execute("SELECT COUNT(*) FROM libraries").fetchone()[0] >= MAX_LIBRARIES:
                    raise APIError(507, "题库数量已达上限，请联系站点维护者")
                try:
                    cursor = db.execute("INSERT INTO libraries(name,name_key,description,color) VALUES(?,?,?,?)", (name, name.casefold(), description, color))
                except sqlite3.IntegrityError:
                    raise APIError(409, "已经有同名题库了，可以直接进入添加词条")
                return 201, {"library": self.library(db, cursor.lastrowid)}
            word_item = re.fullmatch(r"/api/libraries/([0-9]+)/words/([0-9]+)", path)
            if word_item:
                if len(word_item[1]) > 18 or len(word_item[2]) > 18:
                    raise APIError(404, "这个词条不存在")
                if method != "DELETE":
                    raise APIError(405, "此操作暂不支持")
                library_id, word_id = int(word_item[1]), int(word_item[2])
                self.library(db, library_id)
                data = self.body(env)
                given = self.request_owner(env, data, required=True)
                self.limit(db, env, "delete")
                row = db.execute("SELECT id,owner_key FROM words WHERE id=? AND library_id=?", (word_id, library_id)).fetchone()
                if row is None:
                    raise APIError(404, "这个词条不存在，可能已经删过了")
                if not owned_by(row["owner_key"], given):
                    raise APIError(403, "只能删除自己添加的词条")
                deleted = db.execute("DELETE FROM words WHERE id=? AND library_id=? AND owner_key=?", (word_id, library_id, given)).rowcount
                if not deleted:
                    raise APIError(403, "只能删除自己添加的词条")
                total = db.execute("SELECT COUNT(*) FROM words WHERE library_id=?", (library_id,)).fetchone()[0]
                return 200, {"deleted": True, "total": total}
            match = re.fullmatch(r"/api/libraries/([0-9]+)/(words|export|similar)", path)
            if not match:
                raise APIError(404, "没有找到这个接口")
            if len(match[1]) > 18:
                raise APIError(404, "这个题库不存在")
            library_id, action = int(match[1]), match[2]
            library = self.library(db, library_id)
            if action == "export":
                if method not in {"GET", "HEAD"}:
                    raise APIError(405, "此操作暂不支持")
                rows = db.execute("SELECT text FROM words WHERE library_id=? ORDER BY id ASC", (library_id,)).fetchall()
                return 200, "\n".join(r["text"] for r in rows) + ("\n" if rows else "")
            if action == "similar":
                if method in {"GET", "HEAD"}:
                    query = parse_qs(env.get("QUERY_STRING", ""))
                    q = clean(query.get("q", [""])[0], "词条", 50, True)
                    queries = [q]
                elif method == "POST":
                    data = self.body(env)
                    words = data.get("words")
                    if not isinstance(words, list) or not 1 <= len(words) <= 20:
                        raise APIError(400, "每次请查重 1～20 个词条")
                    queries = []
                    seen = set()
                    for word in words:
                        cleaned = clean(word, "词条", 50, True)
                        key = cleaned.casefold()
                        if key not in seen:
                            seen.add(key)
                            queries.append(cleaned)
                else:
                    raise APIError(405, "此操作暂不支持")
                rows = db.execute("SELECT id,text,text_key,contributor FROM words WHERE library_id=?", (library_id,)).fetchall()
                word_keys = [comparison_key(row["text"]) for row in rows]
                results = [{"word": word, "matches": similar_matches(word, rows, word_keys)} for word in queries]
                if method in {"GET", "HEAD"}:
                    return 200, {"query": queries[0], "matches": results[0]["matches"]}
                return 200, {"results": results}
            if method in {"GET", "HEAD"}:
                query = parse_qs(env.get("QUERY_STRING", ""))
                q = clean(query.get("q", [""])[0], "搜索词", 100)
                try:
                    page = int(query.get("page", ["1"])[0])
                    page_size = int(query.get("page_size", ["60"])[0])
                    if not 1 <= page <= 1000000 or not 1 <= page_size <= 200:
                        raise ValueError()
                except ValueError:
                    raise APIError(400, "分页参数无效")
                escaped = q.casefold().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                where = "library_id=? AND text_key LIKE ? ESCAPE '\\'"
                args = (library_id, "%" + escaped + "%")
                total = db.execute("SELECT COUNT(*) FROM words WHERE " + where, args).fetchone()[0]
                rows = db.execute("SELECT id,text,contributor,created_at,owner_key FROM words WHERE " + where + " ORDER BY id DESC LIMIT ? OFFSET ?", args + (page_size, (page - 1) * page_size)).fetchall()
                given = self.request_owner(env)
                words = []
                for row in rows:
                    item = dict(row)
                    item["owned"] = owned_by(item.pop("owner_key"), given)
                    words.append(item)
                return 200, {"library": library, "words": words, "total": total, "page": page, "page_size": page_size}
            if method != "POST":
                raise APIError(405, "此操作暂不支持")
            data = self.body(env)
            words = data.get("words")
            if not isinstance(words, list) or not 1 <= len(words) <= 200:
                raise APIError(400, "每次请添加 1～200 个词条")
            words = [clean(w, "词条", 50, True) for w in words]
            contributor = clean(data.get("contributor", ""), "昵称", 24)
            given = self.request_owner(env, data)
            self.check_storage()
            self.limit(db, env, "words")
            global_words = db.execute("SELECT COUNT(*) FROM words").fetchone()[0]
            added, duplicates = 0, []
            for word in words:
                cursor = db.execute("INSERT OR IGNORE INTO words(library_id,text,text_key,contributor,owner_key) VALUES(?,?,?,?,?)", (library_id, word, word.casefold(), contributor, given))
                if cursor.rowcount:
                    added += 1
                    if global_words + added > MAX_WORDS:
                        raise APIError(507, "词条数量已达上限，请联系站点维护者")
                else:
                    duplicates.append(word)
            total = db.execute("SELECT COUNT(*) FROM words WHERE library_id=?", (library_id,)).fetchone()[0]
            return 200, {"added": added, "duplicates": duplicates, "total": total}

    def library_api(self, env, path, method):
        if method not in {"GET", "HEAD", "POST", "DELETE"}:
            raise APIError(405, "此操作暂不支持")
        if method in {"POST", "DELETE"}:
            self.check_origin(env)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            account = self.current_account(db, env)
            if account is None:
                raise APIError(401, "请先登录账号")
            account_id = account["id"]
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            if path == "/api/library/gallery":
                if method in {"GET", "HEAD"}:
                    rows = db.execute("SELECT id,title,source_room,source_game,source_player,created_at,updated_at,drawing FROM gallery_artworks WHERE account_id=? ORDER BY updated_at DESC LIMIT 60", (account_id,)).fetchall()
                    items = []
                    for row in rows:
                        try:
                            drawing = json.loads(zlib.decompress(row["drawing"]).decode("utf-8"))
                        except (ValueError, TypeError, zlib.error):
                            continue
                        items.append({"id": row["id"], "title": row["title"], "drawing": drawing,
                                      "source_room": row["source_room"], "source_game": row["source_game"],
                                      "source_player": row["source_player"], "created_at": row["created_at"],
                                      "updated_at": row["updated_at"]})
                    return 200, {"artworks": items}
                if method == "POST":
                    data = self.body(env, maximum=1024 * 1024)
                    self.limit(db, env, "gallery")
                    title = clean(data.get("title", "未命名画作"), "标题", 80) or "未命名画作"
                    drawing = self.game.drawing(data.get("drawing"))
                    payload = zlib.compress(json.dumps(drawing, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9)
                    cursor = db.execute("INSERT INTO gallery_artworks(account_id,title,drawing,created_at,updated_at) VALUES(?,?,?,?,?)",
                                        (account_id, title, payload, now, now))
                    db.execute("DELETE FROM gallery_artworks WHERE account_id=? AND id NOT IN (SELECT id FROM gallery_artworks WHERE account_id=? ORDER BY updated_at DESC LIMIT 200)", (account_id, account_id))
                    return 201, {"artwork": {"id": cursor.lastrowid, "title": title, "drawing": drawing, "created_at": now, "updated_at": now}}
            gallery_match = re.fullmatch(r"/api/library/gallery/(\d+)", path)
            if gallery_match:
                artwork_id = int(gallery_match.group(1))
                row = db.execute("SELECT id,title,drawing,source_room,source_game,source_player,created_at,updated_at FROM gallery_artworks WHERE id=? AND account_id=?", (artwork_id, account_id)).fetchone()
                if row is None:
                    raise APIError(404, "画作不存在")
                if method in {"GET", "HEAD"}:
                    drawing = json.loads(zlib.decompress(row["drawing"]).decode("utf-8"))
                    return 200, {"artwork": {"id": row["id"], "title": row["title"], "drawing": drawing,
                                            "source_room": row["source_room"], "source_game": row["source_game"],
                                            "source_player": row["source_player"], "created_at": row["created_at"],
                                            "updated_at": row["updated_at"]}}
                if method == "DELETE":
                    db.execute("DELETE FROM gallery_artworks WHERE id=? AND account_id=?", (artwork_id, account_id))
                    return 200, {"deleted": True}
                data = self.body(env, maximum=1024 * 1024)
                self.limit(db, env, "gallery")
                title = clean(data.get("title", row["title"]), "标题", 80) or row["title"]
                current_drawing = json.loads(zlib.decompress(row["drawing"]).decode("utf-8"))
                drawing = self.game.drawing(data.get("drawing", current_drawing))
                payload = zlib.compress(json.dumps(drawing, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9)
                db.execute("UPDATE gallery_artworks SET title=?,drawing=?,updated_at=? WHERE id=? AND account_id=?", (title, payload, now, artwork_id, account_id))
                return 200, {"artwork": {"id": artwork_id, "title": title, "drawing": drawing, "updated_at": now}}
            if path == "/api/library/replays":
                rows = db.execute("SELECT id,room_code,game_id,created_at,player_count,chain_count,players FROM game_demos ORDER BY id DESC LIMIT 100").fetchall()
                replays = []
                for row in rows:
                    try:
                        players = json.loads(row["players"])
                    except ValueError:
                        players = []
                    replays.append({"id": row["id"], "code": row["room_code"], "game_id": row["game_id"],
                                    "created_at": row["created_at"], "player_count": row["player_count"],
                                    "chain_count": row["chain_count"], "players": players})
                return 200, {"replays": replays}
            replay_match = re.fullmatch(r"/api/library/replays/(\d+)(?:/favorite)?", path)
            if replay_match:
                replay_id = int(replay_match.group(1))
                row = db.execute("SELECT id,room_code,game_id,created_at,payload FROM game_demos WHERE id=?", (replay_id,)).fetchone()
                if row is None:
                    raise APIError(404, "回放不存在")
                try:
                    demo = json.loads(zlib.decompress(row["payload"]).decode("utf-8"))
                except (ValueError, TypeError, zlib.error):
                    raise APIError(500, "回放数据损坏")
                if path.endswith("/favorite"):
                    if method != "POST":
                        raise APIError(405, "此操作暂不支持")
                    data = self.body(env, maximum=65536)
                    chain_index = self.game.integer(data.get("chain"), 0, len(demo.get("chains", [])) - 1, "接龙链")
                    entry_index = self.game.integer(data.get("entry"), 0, 10**9, "步骤")
                    chain = demo["chains"][chain_index]
                    if entry_index >= len(chain.get("entries", [])):
                        raise APIError(400, "步骤无效")
                    entry = chain["entries"][entry_index]
                    if entry.get("kind") != "draw" or not entry.get("drawing"):
                        raise APIError(400, "只能收藏画作")
                    title = f"{chain.get('prompt') or '接龙画作'} · {entry.get('player_name') or '玩家'}"[:80]
                    drawing = self.game.drawing(entry["drawing"])
                    payload = zlib.compress(json.dumps(drawing, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9)
                    cursor = db.execute("INSERT INTO gallery_artworks(account_id,title,drawing,source_room,source_game,source_player,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                                        (account_id, title, payload, demo.get("code", ""), demo.get("game_id", 0), entry.get("player_name", ""), now, now))
                    db.execute("DELETE FROM gallery_artworks WHERE account_id=? AND id NOT IN (SELECT id FROM gallery_artworks WHERE account_id=? ORDER BY updated_at DESC LIMIT 200)", (account_id, account_id))
                    return 201, {"artwork": {"id": cursor.lastrowid, "title": title}}
                if method not in {"GET", "HEAD"}:
                    raise APIError(405, "此操作暂不支持")
                return 200, {"replay": demo}
            raise APIError(404, "没有找到这个作品库接口")

    def __call__(self, env, start_response):
        from http import HTTPStatus
        path, method = env.get("PATH_INFO", "/"), env.get("REQUEST_METHOD", "GET")
        extra = []
        content_type = "application/json; charset=utf-8"
        cache = "no-store"
        try:
            if path == "/healthz":
                if method not in {"GET", "HEAD"}:
                    raise APIError(405, "此操作暂不支持")
                with self.connect() as db:
                    db.execute("SELECT 1 FROM libraries LIMIT 1").fetchone()
                status, data = 200, {"status": "ok"}
            elif path.startswith("/api/auth/"):
                status, data = self.auth_api(env, path, method)
            elif path.startswith("/api/library/"):
                status, data = self.library_api(env, path, method)
            elif path.startswith("/api/game/"):
                status, data = self.game.api(env, path, method)
            elif path.startswith("/api/"):
                status, data = self.api(env, path, method)
                if isinstance(data, str):
                    content_type = "text/plain; charset=utf-8"
                    extra.append(("Content-Disposition", 'attachment; filename="huacai-words.txt"'))
            else:
                if method not in {"GET", "HEAD"}:
                    raise APIError(405, "此操作暂不支持")
                # Explicit allowlist: application source and SQLite data are never public.
                files = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css", "/favicon.svg": "favicon.svg", "/game": "game.html", "/game.html": "game.html", "/library": "library.html", "/library.html": "library.html", "/library.js": "library.js", "/library.css": "library.css", "/game.js": "game.js", "/game-recovery.js": "game-recovery.js", "/game-sound.js": "game-sound.js", "/game.css": "game.css", "/game-assets/game-scene-day.webp": "game-assets/game-scene-day.webp", "/game-assets/game-scene-night.webp": "game-assets/game-scene-night.webp", "/game-assets/avatars/avatar-1.png": "game-assets/avatars/avatar-1.png", "/game-assets/avatars/avatar-2.png": "game-assets/avatars/avatar-2.png", "/game-assets/avatars/avatar-3.png": "game-assets/avatars/avatar-3.png", "/game-assets/avatars/avatar-4.png": "game-assets/avatars/avatar-4.png", "/game-assets/avatars/avatar-5.png": "game-assets/avatars/avatar-5.png", "/game-assets/avatars/avatar-6.png": "game-assets/avatars/avatar-6.png", "/game-assets/avatars/avatar-7.png": "game-assets/avatars/avatar-7.png", "/game-assets/avatars/avatar-8.png": "game-assets/avatars/avatar-8.png"}
                for index in range(1, 7):
                    name = "game-assets/bgm/bgm-{:02d}.mp3".format(index)
                    files["/" + name] = name
                if path not in files:
                    raise APIError(404, "没有找到这个页面")
                target = ROOT / "static" / files[path]
                if not target.is_file():
                    raise APIError(404, "页面暂未就绪")
                data = target.read_bytes()
                status = 200
                content_type = (mimetypes.guess_type(str(target))[0] or "application/octet-stream") + "; charset=utf-8"
                cache = "no-cache"
            if isinstance(data, dict) and "__set_cookie__" in data:
                extra.append(("Set-Cookie", data.pop("__set_cookie__")))
            if isinstance(data, dict):
                payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            elif isinstance(data, str):
                payload = data.encode("utf-8")
            else:
                payload = data
        except APIError as error:
            status = error.status
            content_type = "application/json; charset=utf-8"
            payload = json.dumps({"error": error.message}, ensure_ascii=False).encode("utf-8")
            if status == 429:
                extra.append(("Retry-After", "60"))
        except Exception:
            LOG.exception("Request failed: %s", path)
            status = 500
            content_type = "application/json; charset=utf-8"
            payload = json.dumps({"error": "服务器开了个小差，请稍后再试"}, ensure_ascii=False).encode("utf-8")
        headers = [("Content-Type", content_type), ("Content-Length", str(len(payload))), ("Cache-Control", cache), ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "same-origin"), ("X-Frame-Options", "DENY"), ("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"), ("Permissions-Policy", "camera=(), microphone=(), geolocation=()")] + extra
        start_response(str(status) + " " + HTTPStatus(status).phrase, headers)
        return [b"" if method == "HEAD" else payload]


def create_app(db_path=None, seed=False, randomize_seats=True, require_accounts=True, min_library_words=50):
    return Application(db_path or os.environ.get("HUACAI_DB", str(ROOT / "data" / "huacai.sqlite3")), seed=seed, randomize_seats=randomize_seats, require_accounts=require_accounts, min_library_words=min_library_words)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8088)
    parser.add_argument("--db", default=str(ROOT / "data" / "huacai.sqlite3"))
    parser.add_argument("--seed", action="store_true")
    args = parser.parse_args()
    from wsgiref.simple_server import make_server
    app = create_app(args.db, seed=args.seed)
    print("Huacai running at http://" + args.host + ":" + str(args.port), flush=True)
    make_server(args.host, args.port, app).serve_forever()
