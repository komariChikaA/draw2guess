"""Persistent, worker-independent Draw & Guess relay API (no app import)."""
import hashlib
import hmac
import json
import math
import random
import re
import secrets
import time
import zlib
from urllib.parse import parse_qs

MAX_BODY = 1024 * 1024
MAX_ROOM_DRAWING_BYTES = 16 * 1024 * 1024
MAX_ROOM_ARTIFACT_BYTES = 8 * 1024 * 1024
MAX_TOTAL_ARTIFACT_BYTES = 128 * 1024 * 1024
# A raw-byte cap alone permits millions of tiny point lists at reveal time.
MAX_ROOM_POINTS = 500000
MAX_ROOM_STROKES = 20000
MAX_POINTS = 100000
MAX_STROKES = 2000
ROOM_TTL = 24 * 60 * 60
EMPTY_TTL = 300
ONLINE_SECONDS = 45
SEEN_INTERVAL = 3
DISCONNECT_SECONDS = 12
RECONNECT_PAUSE_SECONDS = 40
# Reveal is server-driven so every player sees the same automatic playback.
REPLAY_PROMPT_SECONDS = 2.5
REPLAY_DRAW_SECONDS = 6.0
REPLAY_GUESS_SECONDS = 3.8
REPLAY_SKIP_SECONDS = 1.5
CHOICE_SECONDS = 15
LINEUP_SECONDS = 2.5
MATCH_SECONDS = 15
MATCH_RESULT_SECONDS = 3.0
FAVORITE_SECONDS = 10
FAVORITE_RESULT_SECONDS = 3.0
DEFAULT_SETTINGS = {"max_players": 8, "draw_seconds": 180, "guess_seconds": 60, "library_id": None}
CODE_RE = re.compile(r"[A-Z2-9]{6}")
COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}")
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43}")
BRUSHES = {"pen", "marker", "pencil", "brush", "crayon", "spray"}
LAYERS = 3


def packed(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class GameService:
    def __init__(self, app, error=None, cleaner=None, clock=None):
        self.app = app
        # Helpers are injected at construction; never import app (also works as __main__).
        self.error = error or app.game_error
        self.clean = cleaner or app.game_clean
        self.clock = clock or time.time
        self.seat_shuffle = None
        with app.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS game_rooms (
                    code TEXT PRIMARY KEY,
                    state TEXT NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS game_expiry ON game_rooms(expires_at);
                CREATE TABLE IF NOT EXISTS game_artifacts (
                    room_code TEXT NOT NULL REFERENCES game_rooms(code) ON DELETE CASCADE,
                    artifact_id TEXT NOT NULL,
                    drawing BLOB NOT NULL,
                    raw_size INTEGER NOT NULL,
                    stored_size INTEGER NOT NULL,
                    point_count INTEGER NOT NULL,
                    stroke_count INTEGER NOT NULL,
                    PRIMARY KEY(room_code, artifact_id)
                );
                CREATE TABLE IF NOT EXISTS game_members (
                    room_code TEXT NOT NULL REFERENCES game_rooms(code) ON DELETE CASCADE,
                    player_id INTEGER NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    account_id INTEGER NOT NULL DEFAULT 0,
                    last_seen REAL NOT NULL,
                    PRIMARY KEY(room_code, player_id)
                );
                CREATE TABLE IF NOT EXISTS game_rates (
                    client TEXT NOT NULL,
                    action TEXT NOT NULL,
                    bucket INTEGER NOT NULL,
                    count INTEGER NOT NULL,
                    PRIMARY KEY(client, action, bucket)
                );
                CREATE INDEX IF NOT EXISTS game_rate_expiry ON game_rates(bucket);
                CREATE TABLE IF NOT EXISTS game_demos (
                    id INTEGER PRIMARY KEY,
                    room_code TEXT NOT NULL,
                    game_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    player_count INTEGER NOT NULL,
                    chain_count INTEGER NOT NULL,
                    players TEXT NOT NULL,
                    payload BLOB NOT NULL,
                    UNIQUE(room_code, game_id)
                );
                CREATE TABLE IF NOT EXISTS gallery_artworks (
                    id INTEGER PRIMARY KEY,
                    account_id INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    drawing BLOB NOT NULL,
                    source_room TEXT NOT NULL DEFAULT '',
                    source_game INTEGER NOT NULL DEFAULT 0,
                    source_player TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS gallery_account ON gallery_artworks(account_id, updated_at DESC);
                CREATE TABLE IF NOT EXISTS game_tea (
                    id INTEGER PRIMARY KEY,
                    room_code TEXT NOT NULL,
                    player_id INTEGER NOT NULL,
                    stroke TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS game_tea_room ON game_tea(room_code, id);
            """)
            columns = {row[1] for row in db.execute("PRAGMA table_info(game_members)")}
            if "account_id" not in columns:
                db.execute("ALTER TABLE game_members ADD COLUMN account_id INTEGER NOT NULL DEFAULT 0")
            db.execute("CREATE INDEX IF NOT EXISTS game_member_account ON game_members(account_id)")

    def fail(self, status, message):
        raise self.error(status, message)

    def integer(self, value, minimum, maximum, label):
        if type(value) is not int or not minimum <= value <= maximum:
            self.fail(400, label + "无效")
        return value

    def boolean(self, value, label):
        if type(value) is not bool:
            self.fail(400, label + "需要是布尔值")
        return value

    def identity(self, data):
        return self.clean(data.get("name"), "昵称", 24, True), self.integer(data.get("avatar"), 0, 7, "头像")

    def settings(self, db, data, current=None, partial=False):
        if not isinstance(data, dict) or set(data) - set(DEFAULT_SETTINGS):
            self.fail(400, "房间设置无效")
        if not partial and set(data) != set(DEFAULT_SETTINGS):
            self.fail(400, "请提交完整的房间设置")
        if not partial and data.get("library_id") is None:
            self.fail(400, "请选择题库")
        result = dict(current or DEFAULT_SETTINGS)
        result.update(data)
        for key, lower, upper in (("max_players", 4, 16), ("draw_seconds", 30, 300), ("guess_seconds", 15, 120)):
            self.integer(result[key], lower, upper, "房间设置")
        library_id = result["library_id"]
        if library_id is not None:
            self.integer(library_id, 1, 2**63 - 1, "题库")
            if not db.execute("SELECT 1 FROM libraries WHERE id=?", (library_id,)).fetchone():
                self.fail(400, "请选择存在的题库")
            if not db.execute("SELECT 1 FROM words WHERE library_id=? LIMIT 1", (library_id,)).fetchone():
                self.fail(400, "题库不能为空")
        return result

    def drawing(self, value):
        if not isinstance(value, dict) or set(value) != {"strokes"}:
            self.fail(400, "画作需要是笔画对象")
        strokes = value["strokes"]
        if not isinstance(strokes, list) or len(strokes) > MAX_STROKES:
            self.fail(400, "画作最多支持2000个笔画")
        result, total = [], 0
        allowed_keys = {"tool", "color", "size", "points", "pressures", "brush", "layer", "opacity", "gradient", "angle"}
        for stroke in strokes:
            if (not isinstance(stroke, dict) or set(stroke) - allowed_keys
                    or not {"tool", "color", "size", "points"} <= set(stroke)):
                self.fail(400, "笔画格式无效")
            tool, color, size, points = (stroke[key] for key in ("tool", "color", "size", "points"))
            if not isinstance(tool, str) or tool not in {"pen", "eraser", "fill"}:
                self.fail(400, "画笔工具无效")
            if not isinstance(color, str) or not COLOR_RE.fullmatch(color):
                self.fail(400, "画笔颜色无效")
            self.number(size, 1, 64, "画笔大小")
            if not isinstance(points, list) or not points:
                self.fail(400, "笔画需要坐标")
            if tool == "fill" and len(points) != 1:
                self.fail(400, "填充需要一个起点")
            total += len(points)
            if total > MAX_POINTS:
                self.fail(400, "画作最多支持100000个坐标点")
            for point in points:
                if not isinstance(point, list) or len(point) != 2:
                    self.fail(400, "坐标格式无效")
                self.number(point[0], 0, 960, "横坐标")
                self.number(point[1], 0, 640, "纵坐标")
            item = {"tool": tool, "color": "#ffffff" if tool == "eraser" else color.lower(), "size": size, "points": points}
            if "opacity" in stroke:
                opacity = stroke["opacity"]
                if type(opacity) is not int or not 1 <= opacity <= 100:
                    self.fail(400, "不透明度无效")
                item["opacity"] = opacity
            if "gradient" in stroke:
                gradient = stroke["gradient"]
                if (tool == "eraser" or not isinstance(gradient, list) or len(gradient) != 2
                        or any(not isinstance(value, str) or not COLOR_RE.fullmatch(value) for value in gradient)):
                    self.fail(400, "渐变颜色无效")
                item["gradient"] = [value.lower() for value in gradient]
            if "angle" in stroke:
                if tool != "fill":
                    self.fail(400, "只有填充可以设置渐变方向")
                self.number(stroke["angle"], 0, 360, "渐变角度")
                item["angle"] = stroke["angle"]
            if "brush" in stroke:
                brush = stroke["brush"]
                if not isinstance(brush, str) or brush not in BRUSHES:
                    self.fail(400, "画笔笔触无效")
                item["brush"] = brush
            if "layer" in stroke:
                layer = stroke["layer"]
                if type(layer) is not int or not 0 <= layer < LAYERS:
                    self.fail(400, "图层无效")
                item["layer"] = layer
            if "pressures" in stroke:
                pressures = stroke["pressures"]
                if tool == "fill" or not isinstance(pressures, list) or len(pressures) != len(points):
                    self.fail(400, "压感数据无效")
                for pressure in pressures:
                    self.number(pressure, 0, 1, "压感")
                item["pressures"] = pressures
            # Erasers paint opaque white; fills remain replayable flood-fill commands.
            result.append(item)
        result = {"strokes": result}
        if len(packed(result).encode("utf-8")) > MAX_BODY - 1024:
            self.fail(413, "画作太大，请减少笔画")
        return result

    def number(self, value, minimum, maximum, label):
        # Never coerce an arbitrary JSON integer to float (huge ints can overflow).
        if (type(value) not in (int, float) or not minimum <= value <= maximum
                or type(value) is float and not math.isfinite(value)):
            self.fail(400, label + "无效")

    def drawing_items(self, state):
        for chain in state["chains"]:
            yield from chain["entries"]
        yield from state["drafts"].values()

    def prune_artifacts(self, db, state):
        refs = {item["drawing_ref"] for item in self.drawing_items(state) if item.get("drawing_ref")}
        # At most 128 completed drawings and 16 drafts, never vector payloads.
        if refs:
            placeholders = ",".join("?" for _ in refs)
            db.execute("DELETE FROM game_artifacts WHERE room_code=? AND artifact_id NOT IN (" + placeholders + ")", (state["code"], *refs))
        else:
            db.execute("DELETE FROM game_artifacts WHERE room_code=?", (state["code"],))

    def store_drawing(self, db, state, drawing, automatic=False):
        if not drawing["strokes"]:
            return None
        raw = packed(drawing).encode("utf-8")
        if len(raw) > MAX_BODY - 1024:
            self.fail(413, "画作太大，请减少笔画")
        # Each live drawing is counted even if identical to another player's.
        # Deadlines reuse a draft reference instead of making another artifact.
        artifact_id = secrets.token_hex(16)
        compressed = zlib.compress(raw, 6)
        points = sum(len(stroke["points"]) for stroke in drawing["strokes"])
        room = db.execute("SELECT COALESCE(SUM(raw_size),0),COALESCE(SUM(stored_size),0),COALESCE(SUM(point_count),0),COALESCE(SUM(stroke_count),0) FROM game_artifacts WHERE room_code=?", (state["code"],)).fetchone()
        total = db.execute("SELECT COALESCE(SUM(stored_size),0) FROM game_artifacts").fetchone()[0]
        exceeded = (room[0] + len(raw) > MAX_ROOM_DRAWING_BYTES
                    or room[1] + len(compressed) > MAX_ROOM_ARTIFACT_BYTES
                    or room[2] + points > MAX_ROOM_POINTS
                    or room[3] + len(drawing["strokes"]) > MAX_ROOM_STROKES
                    or total + len(compressed) > MAX_TOTAL_ARTIFACT_BYTES)
        if exceeded:
            if automatic:
                # Bots must never prevent deadline transitions under storage pressure.
                return None
            self.fail(507, "画作存储已满，请减少笔画后重试；房间最多16MiB或500000个坐标点")
        if automatic:
            try:
                self.app.check_storage()
            except self.error as exc:
                if exc.status != 507:
                    raise
                return None
        else:
            self.app.check_storage()
        db.execute("INSERT INTO game_artifacts(room_code,artifact_id,drawing,raw_size,stored_size,point_count,stroke_count) VALUES(?,?,?,?,?,?,?)", (state["code"], artifact_id, compressed, len(raw), len(compressed), points, len(drawing["strokes"])))
        return artifact_id

    def externalize_drawings(self, db, state):
        # Lazy migration of rooms saved by the previous inline-vector implementation.
        changed = False
        for item in self.drawing_items(state):
            if "drawing" in item:
                drawing = item.pop("drawing")
                item["drawing_ref"] = self.store_drawing(db, state, drawing)
                changed = True
        return changed

    def load_drawing(self, db, code, artifact_id):
        if not artifact_id:
            return {"strokes": []}
        row = db.execute("SELECT drawing,raw_size FROM game_artifacts WHERE room_code=? AND artifact_id=?", (code, artifact_id)).fetchone()
        if row is None or not 0 <= row["raw_size"] <= MAX_BODY - 1024:
            self.fail(500, "画作存储不完整")
        # Bound decompression even if the on-disk artifact has been corrupted.
        decoder = zlib.decompressobj()
        try:
            raw = decoder.decompress(row["drawing"], row["raw_size"] + 1)
            if len(raw) != row["raw_size"] or not decoder.eof or decoder.unused_data:
                self.fail(500, "画作存储不完整")
            return json.loads(raw)
        except (zlib.error, ValueError, UnicodeError, RecursionError):
            self.fail(500, "画作存储不完整")

    def hydrate(self, db, code, item):
        result = {key: value for key, value in item.items() if key != "drawing_ref"}
        if "drawing_ref" in item:
            result["drawing"] = self.load_drawing(db, code, item["drawing_ref"])
        return result

    def limit(self, db, env, action, now):
        maximum = {"create": 8, "join": 80, "chat": 120, "mutate": 1200}[action]
        bucket = int(now) // 60
        client = str(env.get("REMOTE_ADDR", "unknown"))[:128]
        db.execute("DELETE FROM game_rates WHERE rowid IN (SELECT rowid FROM game_rates WHERE bucket < ? LIMIT 100)", (bucket - 2,))
        db.execute("INSERT INTO game_rates(client,action,bucket,count) VALUES(?,?,?,1) ON CONFLICT(client,action,bucket) DO UPDATE SET count=count+1", (client, action, bucket))
        count = db.execute("SELECT count FROM game_rates WHERE client=? AND action=? AND bucket=?", (client, action, bucket)).fetchone()[0]
        if count > maximum:
            self.fail(429, "操作有点快，请一分钟后再试")

    def add_player(self, db, state, name, avatar, now, bot=False, account_id=0):
        player_id = state["next_id"]
        state["next_id"] += 1
        state["players"].append({"id": player_id, "name": name, "avatar": avatar, "ready": bot, "is_bot": bot, "active": True})
        if bot:
            return None
        token = secrets.token_urlsafe(32)
        db.execute("INSERT INTO game_members(room_code,player_id,token_hash,account_id,last_seen) VALUES(?,?,?,?,?)", (state["code"], player_id, hashlib.sha256(token.encode("ascii")).hexdigest(), account_id, now))
        return token

    def authenticate(self, db, code, env):
        token = env.get("HTTP_X_GAME_TOKEN", "")
        if isinstance(token, str) and TOKEN_RE.fullmatch(token):
            hashed = hashlib.sha256(token.encode("ascii")).hexdigest()
            row = db.execute("SELECT player_id,token_hash,last_seen FROM game_members WHERE room_code=? AND token_hash=?", (code, hashed)).fetchone()
            if row is not None and hmac.compare_digest(row["token_hash"], hashed):
                return row
        # A logged-in account can reclaim its seat from another device without the old game token.
        account = self.app.current_account(db, env)
        if account is not None:
            row = db.execute("SELECT player_id,token_hash,last_seen FROM game_members WHERE room_code=? AND account_id=? ORDER BY last_seen DESC LIMIT 1", (code, account["id"])).fetchone()
            if row is not None:
                return row
        self.fail(401, "房间身份无效，请重新登录或加入房间")

    def save(self, db, state, now):
        self.prune_artifacts(db, state)
        expires = now + (ROOM_TTL if any(p["active"] and not p["is_bot"] for p in state["players"]) else EMPTY_TTL)
        db.execute("UPDATE game_rooms SET state=?,expires_at=? WHERE code=?", (packed(state), expires, state["code"]))

    def message(self, state, name, text, system=False):
        state["chat_seq"] += 1
        state["chat"].append({"id": state["chat_seq"], "name": name, "text": text, "system": system})
        state["chat"] = state["chat"][-80:]

    def host(self, state, player_id):
        if state["host_id"] != player_id:
            self.fail(403, "只有房主可以操作")

    def phase(self, state, required):
        if state["phase"] != required:
            self.fail(409, "当前阶段不能进行此操作")

    def assignment(self, state, player_id):
        return (state["seats"].index(player_id) - state["round"]) % len(state["seats"])

    def entry(self, state, player):
        chain = state["chains"][self.assignment(state, player["id"])]
        return chain, len(chain["entries"]) > state["round"]

    def source_entry(self, chain, before=None):
        entries = chain["entries"] if before is None else chain["entries"][:before]
        return next((item for item in reversed(entries) if item["kind"] != "skip"), None)

    def task_kind(self, state, player_id):
        chain = state["chains"][self.assignment(state, player_id)]
        previous = self.source_entry(chain, state["round"])
        return "guess" if previous and previous["kind"] == "draw" else "draw"

    def finish(self, db, state, player, data=None, timed_out=False):
        chain, submitted = self.entry(state, player)
        if submitted:
            return
        kind = self.task_kind(state, player["id"])
        data = data or state["drafts"].get(str(player["id"]), {})
        disconnected = not player["active"] or player.get("away")
        valid_draft = bool(data.get("drawing_ref")) if kind == "draw" else bool(data.get("text"))
        if disconnected and not valid_draft:
            chain["entries"].append({"player_id": player["id"], "player_name": player["name"],
                                     "kind": "skip", "timed_out": True,
                                     "text": "掉线，已跳过；沿用最后一份有效内容"})
            state["drafts"].pop(str(player["id"]), None)
            return
        item = {"player_id": player["id"], "player_name": player["name"], "kind": kind, "timed_out": timed_out}
        if kind == "draw":
            item["drawing_ref"] = (self.store_drawing(db, state, data["drawing"], automatic=True)
                                   if "drawing" in data else data.get("drawing_ref"))
            strokes = data.get("stroke_count")
            if strokes is None:
                strokes = len((data.get("drawing") or {}).get("strokes") or [])
            item["reveal_seconds"] = max(4.0, min(8.0, 4.0 + float(strokes) * 0.08))
            if state["round"] == 0:
                chain["prompt"] = chain.get("prompt") or data.get("text") or chain["choices"][0]
                item["text"] = chain["prompt"]
        else:
            item["text"] = data.get("text") or "（未猜出）"
        chain["entries"].append(item)
        # The completed entry now owns the draft reference; do not keep a copy.
        state["drafts"].pop(str(player["id"]), None)

    def bot_data(self, state, player):
        seed = player["id"] * 31 + state["round"]
        if self.task_kind(state, player["id"]) == "guess":
            return {"text": ("正在跳舞的猫", "坐火箭的西瓜", "戴帽子的企鹅")[(seed % 3)]}
        x = 300 + seed % 120
        return {"drawing": {"strokes": [
            {"tool": "pen", "color": "#7357d9", "size": 7, "points": [[x, 190], [x + 100, 190], [x + 130, 300], [x + 50, 370], [x - 30, 300], [x, 190]]},
            {"tool": "pen", "color": "#ee7d55", "size": 10, "points": [[x + 15, 260], [x + 20, 260]]},
            {"tool": "pen", "color": "#ee7d55", "size": 10, "points": [[x + 75, 260], [x + 80, 260]]},
            {"tool": "pen", "color": "#7357d9", "size": 6, "points": [[x + 10, 310], [x + 45, 335], [x + 80, 310]]},
        ]}}

    def connection_tick(self, db, state, now):
        if state["phase"] != "playing":
            return False
        seen = {r["player_id"]: r["last_seen"] for r in db.execute(
            "SELECT player_id,last_seen FROM game_members WHERE room_code=?", (state["code"],))}
        changed = False
        for player in state["players"]:
            if player.get("away") and player["active"] and now - seen.get(player["id"], 0) < DISCONNECT_SECONDS:
                player["away"] = False
                changed = True
                self.message(state, "系统", player["name"] + "已重连，后续继续参与", True)
        pause = state.get("pause")
        if pause:
            waiting = [p for p in state["players"] if p["id"] in pause["players"] and p["active"]
                       and now - seen.get(p["id"], 0) >= DISCONNECT_SECONDS]
            if not waiting or now >= pause["until"]:
                self.end_pause(state, now, waiting)
                changed = True
            return changed
        if now >= state["deadline"]:
            return changed
        missing = [p for p in state["players"] if p["active"] and not p["is_bot"] and not p.get("away")
                   and now - seen.get(p["id"], now) >= DISCONNECT_SECONDS]
        if missing:
            state["pause_seq"] = state.get("pause_seq", 0) + 1
            state["pause"] = {"id": state["pause_seq"], "started": now,
                              "until": now + RECONNECT_PAUSE_SECONDS,
                              "players": [p["id"] for p in missing]}
            self.message(state, "系统", "、".join(p["name"] for p in missing) + "掉线，本局暂停 40 秒等待重连", True)
            changed = True
        return changed

    def end_pause(self, state, now, waiting):
        pause = state.get("pause")
        if not pause:
            return
        elapsed = max(0, min(now, pause["until"]) - pause["started"])
        state["deadline"] += elapsed
        state["bot_due"] += elapsed
        if state.get("choice_deadline"):
            state["choice_deadline"] += elapsed
        for player in waiting:
            player["away"] = True
        state["pause"] = None
        self.message(state, "系统", "等待结束：离线席位将被跳过，最后一份有效内容继续传递" if waiting else "玩家已重连，计时继续", True)

    def tick(self, db, state, now):
        if state.get("pause"):
            return False
        if state["phase"] == "lobby":
            return self.lobby_tick(db, state, now)
        changed = False
        if (state["phase"] == "playing" and state.get("round") == 0
                and state.get("choice_deadline") and now >= state["choice_deadline"]):
            for chain in state["chains"]:
                if not chain.get("prompt"):
                    draft = state["drafts"].get(str(chain["owner_id"]), {})
                    preferred = draft.get("text")
                    chain["prompt"] = preferred if preferred in chain["choices"] else chain["choices"][0]
            state["choice_deadline"] = None
            changed = True
        while state["phase"] == "playing":
            for player in state["players"]:
                _, submitted = self.entry(state, player)
                if submitted:
                    continue
                if not player["active"] or player.get("away"):
                    self.finish(db, state, player, timed_out=True)
                    changed = True
                elif player["is_bot"] and now >= state["bot_due"]:
                    self.finish(db, state, player, self.bot_data(state, player))
                    changed = True
                elif now >= state["deadline"]:
                    self.finish(db, state, player, timed_out=True)
                    changed = True
            if not all(len(c["entries"]) > state["round"] for c in state["chains"]):
                break
            expired = now >= state["deadline"]
            started = state["deadline"] if expired else now
            changed = True
            state["drafts"] = {}
            if state["round"] + 1 == state.get("total_rounds", len(state["seats"])):
                state["phase"], state["deadline"] = "reveal", None
                state["pause"] = None
                state["choice_deadline"] = None
                state["reveal_stage"] = "lineup"
                state["reveal_chain"], state["reveal_step"] = 0, 0
                state["reveal_deadline"] = now + LINEUP_SECONDS
                self.message(state, "系统", "接龙完成，回放已生成。", True)
                break
            state["round"] += 1
            state["choice_deadline"] = None
            seconds = state["settings"]["guess_seconds" if state["round"] % 2 else "draw_seconds"]
            state["deadline"], state["bot_due"] = started + seconds, started + 3
        if state["phase"] == "reveal":
            changed = self.reveal_tick(state, now) or changed
        return changed

    def lobby_tick(self, db, state, now):
        players = state.get("players", [])
        library_id = state.get("settings", {}).get("library_id")
        count = db.execute("SELECT COUNT(*) FROM words WHERE library_id=?", (library_id,)).fetchone()[0] if library_id is not None else 0
        if count <= self.app.min_library_words or count < len(players) * 3:
            if state.get("lobby_deadline"):
                state["lobby_deadline"] = None
                state["lobby_next"] = None
                self.message(state, "系统", "题库词条不足，无法开始；请房主更换题库", True)
                return True
            return False
        humans = [p for p in players if p["active"] and not p.get("is_bot")]
        all_ready = (len(players) >= 4 and bool(humans)
                     and all(p["ready"] for p in humans)
                     and all(p["ready"] or p.get("is_bot") for p in players))
        if not all_ready:
            if state.get("lobby_deadline"):
                state["lobby_deadline"] = None
                state["lobby_next"] = None
                self.message(state, "系统", "倒计时取消：等待所有人准备", True)
                return True
            return False
        if not state.get("lobby_deadline"):
            state["lobby_deadline"] = now + 5
            state["lobby_next"] = 5
            self.message(state, "系统", "5", True)
            return True
        deadline = state["lobby_deadline"]
        current = state.get("lobby_next") or 5
        target = max(1, 5 - int(max(0, now - (deadline - 5))))
        changed = False
        while current > target:
            current -= 1
            self.message(state, "系统", str(current), True)
            changed = True
        state["lobby_next"] = current
        if now >= deadline:
            state["lobby_deadline"] = None
            state["lobby_next"] = None
            starter = next((p for p in humans if p["id"] == state.get("host_id")), humans[0])
            self.start(db, state, starter["id"], now)
            changed = True
        return changed

    def reveal_tick(self, state, now):
        """Advance the shared reveal: replay -> match vote -> best artwork -> next chain."""
        if state.get("phase") != "reveal":
            return False
        chains = state.get("chains") or []
        if not chains:
            return False
        changed = False
        while True:
            stage = state.get("reveal_stage", "replay")
            if stage == "scores":
                break
            index = min(max(int(state.get("reveal_chain", 0)), 0), len(chains) - 1)
            chain = chains[index]
            deadline = state.get("reveal_deadline")
            if stage == "lineup":
                if deadline is None:
                    state["reveal_deadline"] = now + LINEUP_SECONDS
                    return True
                if now < deadline:
                    break
                state["reveal_stage"] = "replay"
                state["reveal_step"] = 0
                state["reveal_deadline"] = now + REPLAY_PROMPT_SECONDS
                return True
            if stage == "replay":
                if deadline is None:
                    state["reveal_deadline"] = now + REPLAY_PROMPT_SECONDS
                    return True
                if now < deadline:
                    break
                entries = chain["entries"]
                step = int(state.get("reveal_step", 0))
                if step < len(entries):
                    step += 1
                    state["reveal_step"] = step
                    entry = entries[step - 1]
                    kind = entry.get("kind")
                    if kind == "draw":
                        delay = max(4.0, min(8.0, float(entry.get("reveal_seconds", REPLAY_DRAW_SECONDS))))
                    else:
                        delay = REPLAY_GUESS_SECONDS if kind == "guess" else REPLAY_SKIP_SECONDS
                    state["reveal_deadline"] = now + delay
                    return True
                state["reveal_stage"] = "match"
                state["reveal_deadline"] = now + MATCH_SECONDS
                self.reveal_bot_votes(state, index)
                changed = True
                continue
            if stage == "match":
                self.reveal_bot_votes(state, index)
                if deadline is None:
                    state["reveal_deadline"] = now + MATCH_SECONDS
                    return True
                complete = self.reveal_match_complete(state, chain)
                if complete or now >= deadline:
                    state["reveal_stage"] = "match_result"
                    state["reveal_deadline"] = now + MATCH_RESULT_SECONDS
                    changed = True
                    continue
                break
            if stage == "match_result":
                if deadline is None:
                    state["reveal_deadline"] = now + MATCH_RESULT_SECONDS
                    return True
                if now < deadline:
                    break
                state["reveal_stage"] = "favorite"
                state["reveal_deadline"] = now + FAVORITE_SECONDS
                self.reveal_bot_favorite(state, index, now)
                changed = True
                continue
            if stage == "favorite":
                if deadline is None:
                    state["reveal_deadline"] = now + FAVORITE_SECONDS
                    self.reveal_bot_favorite(state, index, now)
                    return True
                awarded = str(index) in state.get("awards", {})
                if awarded:
                    if now < deadline:
                        break
                elif now < deadline:
                    break
                if index + 1 >= len(chains):
                    state["reveal_stage"] = "scores"
                    state["reveal_deadline"] = None
                else:
                    state["reveal_chain"] = index + 1
                    state["reveal_step"] = 0
                    state["reveal_stage"] = "lineup"
                    state["reveal_deadline"] = now + LINEUP_SECONDS
                return True
            break
        return changed

    def reveal_bot_votes(self, state, index):
        bots = [p for p in state["players"] if p["is_bot"] and p["active"]]
        for position, bot in enumerate(bots):
            # Keep the demo interesting: all but the last demo player say "same".
            vote = "changed" if len(bots) > 1 and position == len(bots) - 1 else "same"
            state["chains"][index]["votes"].setdefault(str(bot["id"]), vote)

    def reveal_match_complete(self, state, chain):
        voters = [p for p in state["players"] if p["active"] and not p["is_bot"] and not p.get("away")]
        return all(str(p["id"]) in chain["votes"] for p in voters)

    def reveal_bot_favorite(self, state, index, now):
        chain = state["chains"][index]
        owner = next((p for p in state["players"] if p["id"] == chain["owner_id"]), None)
        if owner is None or not owner["is_bot"]:
            return
        candidates = [entry for entry in chain["entries"]
                      if entry["kind"] == "draw" and entry["player_id"] != chain["owner_id"]]
        if candidates:
            state.setdefault("awards", {})[str(index)] = candidates[0]["player_id"]
            state["reveal_deadline"] = now + FAVORITE_RESULT_SECONDS
        else:
            state["reveal_deadline"] = now + REPLAY_SKIP_SECONDS

    def save_demo(self, db, state, now, force=False):
        if (state.get("demo_saved") and not force) or not state.get("chains"):
            return 0
        players = [{"id": p["id"], "name": p["name"], "avatar": p["avatar"]} for p in state["players"]]
        chains = []
        for chain_index, c in enumerate(state["chains"]):
            entries = []
            for item in c["entries"]:
                entry = self.hydrate(db, state["code"], item)
                entry.pop("reveal_seconds", None)
                entries.append(entry)
            same = list(c["votes"].values()).count("same")
            changed = list(c["votes"].values()).count("changed")
            chains.append({
                "owner_id": c["owner_id"], "owner_name": c["owner_name"], "prompt": c["prompt"],
                "entries": entries, "votes": {"same": same, "changed": changed},
                "success": same + changed > 0 and same * 4 >= (same + changed) * 3,
                "award": state.get("awards", {}).get(str(chain_index)),
            })
        demo = {
            "code": state["code"], "game_id": state.get("game_id", 0),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            "settings": state["settings"], "players": players, "chains": chains,
        }
        raw = json.dumps(demo, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        payload = zlib.compress(raw, 9)
        if len(payload) > 16 * 1024 * 1024:
            return 0
        db.execute("INSERT INTO game_demos(room_code,game_id,created_at,player_count,chain_count,players,payload) VALUES(?,?,?,?,?,?,?) ON CONFLICT(room_code,game_id) DO UPDATE SET player_count=excluded.player_count, chain_count=excluded.chain_count, players=excluded.players, payload=excluded.payload",
                   (state["code"], demo["game_id"], demo["created_at"], len(players), len(chains), json.dumps(players, ensure_ascii=False, separators=(",", ":")), payload))
        db.execute("DELETE FROM game_demos WHERE id NOT IN (SELECT id FROM game_demos ORDER BY id DESC LIMIT 100)")
        state["demo_saved"] = True
        return len(payload)

    def start(self, db, state, player_id, now):
        self.host(state, player_id)
        self.phase(state, "lobby")
        players = list(state["players"])
        if len(players) < 4 or any(not p["ready"] and p["id"] != player_id and not p["is_bot"] for p in players):
            self.fail(409, "至少需要4位玩家，且其他真人玩家全部准备")
        if getattr(self.app, "randomize_seats", True):
            if self.seat_shuffle:
                self.seat_shuffle(players)
            else:
                random.SystemRandom().shuffle(players)
            state["players"] = players
        self.settings(db, state["settings"])
        library_id = state["settings"]["library_id"]
        if library_id is None:
            self.fail(400, "请先在房间设置中选择题库")
        count = db.execute("SELECT COUNT(*) FROM words WHERE library_id=?", (library_id,)).fetchone()[0]
        if count <= self.app.min_library_words:
            self.fail(400, "题库至少需要 {} 个词条才能开始".format(self.app.min_library_words + 1))
        pool = [r[0] for r in db.execute("SELECT text FROM words WHERE library_id=? ORDER BY id LIMIT 100000", (library_id,))]
        # Draw unique prompts for the whole table so no two players receive the same word.
        state["chains"] = []
        rng = random.SystemRandom()
        needed = len(players) * 3
        shared = rng.sample(pool, needed) if len(pool) >= needed else None
        for index, player in enumerate(players):
            choices = shared[index * 3:index * 3 + 3] if shared else (rng.sample(pool, 3) if len(pool) >= 3 else [rng.choice(pool) for _ in range(3)])
            state["chains"].append({"owner_id": player["id"], "owner_name": player["name"], "prompt": "", "choices": choices, "entries": [], "votes": {}})
        state["seats"] = [p["id"] for p in players]
        state["total_rounds"] = len(state["seats"]) if len(state["seats"]) % 2 == 0 else len(state["seats"]) - 1
        state["game_id"] = state.get("game_id", 0) + 1
        state["phase"], state["round"] = "playing", 0
        state["lobby_deadline"], state["lobby_next"] = None, None
        state["choice_deadline"] = now + CHOICE_SECONDS
        state["deadline"], state["bot_due"] = state["choice_deadline"] + state["settings"]["draw_seconds"], now + 3
        state["demo_saved"] = False
        state["drafts"] = {}
        state["pause"] = None
        state["favorites"] = {}
        state["awards"] = {}
        state["reveal_stage"] = "lineup"
        state["reveal_chain"], state["reveal_step"] = 0, 0
        state["reveal_deadline"] = None
        for player in players:
            player["away"] = False
        self.message(state, "系统", "单人试玩开始。三位演示玩家会自动完成作画与猜词。" if state["practice"] else "游戏开始。每一棒只显示上一位的内容。", True)

    def choose(self, state, player, data):
        self.phase(state, "playing")
        if state.get("round") != 0 or self.task_kind(state, player["id"]) != "draw":
            self.fail(409, "当前不能选择题目")
        chain = state["chains"][self.assignment(state, player["id"])]
        if chain.get("prompt"):
            self.fail(409, "题目已经选好，不能更改")
        word = self.clean(data.get("word"), "题目", 100, True)
        if word not in chain["choices"]:
            self.fail(400, "请选择本轮提供的词语")
        chain["prompt"] = word
        if all(item.get("prompt") for item in state["chains"]):
            state["choice_deadline"] = None
        return True

    def submission(self, db, state, player, data, final):
        # A retry from a previous game must never overwrite a new round-zero task.
        if "game_id" in data and data["game_id"] != state.get("game_id", 0):
            self.fail(409, "这局游戏已经结束，请刷新房间")
        round_number = self.integer(data.get("round"), 0, 15, "轮次")
        if round_number != state["round"]:
            self.fail(409, "这一轮已经结束，请刷新房间")
        self.phase(state, "playing")
        kind = self.task_kind(state, player["id"])
        if state.get("pause") and final:
            self.fail(409, "本局正在等待掉线玩家重连，恢复后再提交")
        if data.get("kind") != kind:
            self.fail(400, "提交类型与任务不符")
        chain, submitted = self.entry(state, player)
        if submitted:
            return False
        result = {}
        if state["round"] == 0:
            chosen = chain.get("prompt")
            if chosen:
                if data.get("text") and data.get("text") != chosen:
                    self.fail(409, "题目已经锁定，不能更改")
                result["text"] = chosen
        if "text" in data or final and kind == "guess":
            text = self.clean(data.get("text"), "答案", 100, final and kind == "guess")
            if state["round"] == 0 and text and text not in chain["choices"]:
                self.fail(400, "请选择本轮提供的词语")
            if kind == "guess" or (state["round"] == 0 and text):
                result["text"] = text
            elif text:
                self.fail(400, "后续画画轮不能修改词语")
        if kind == "draw":
            if final and state["round"] == 0 and not result.get("text"):
                self.fail(400, "请选择本轮提供的词语")
            if "drawing" in data:
                result["drawing"] = self.drawing(data["drawing"])
                result["stroke_count"] = len(result["drawing"]["strokes"])
            elif final:
                self.fail(400, "请提交画作")
        elif "drawing" in data:
            self.fail(400, "猜词轮不能提交画作")
        if "drawing" in result:
            drawing = result.pop("drawing")
            old = state["drafts"].get(str(player["id"]), {})
            # Release a replaced draft before checking cumulative quotas. A failed
            # request rolls back both this deletion and any new artifact insert.
            if old.get("drawing_ref"):
                old.pop("drawing_ref")
                self.prune_artifacts(db, state)
            result["drawing_ref"] = self.store_drawing(db, state, drawing)
        if final:
            self.finish(db, state, player, result)
        else:
            # Partial autosaves merge so a text-only update does not erase the canvas.
            result.pop("stroke_count", None)
            old = state["drafts"].setdefault(str(player["id"]), {})
            old.update(result)
        return True

    def reveal(self, state, player_id, data, now):
        self.phase(state, "reveal")
        stage = state.get("reveal_stage", "replay")
        chain_number = int(state.get("reveal_chain", 0))
        if "chain" in data:
            chain_number = self.integer(data.get("chain"), 0, len(state["chains"]) - 1, "接龙链")
            if chain_number != state.get("reveal_chain", 0):
                self.fail(409, "当前正在回放另一条接龙")
        vote = data.get("vote")
        if vote == "favorite":
            if stage != "favorite":
                self.fail(409, "还没到题主评选阶段")
            chain = state["chains"][chain_number]
            artist = self.integer(data.get("artist"), 1, 2**31 - 1, "作品作者")
            if chain["owner_id"] != player_id:
                self.fail(403, "只有题主可以评选最佳作品")
            if artist == chain["owner_id"]:
                self.fail(400, "不能选择自己的作品")
            if not any(item["player_id"] == artist and item["kind"] == "draw" for item in chain["entries"]):
                self.fail(400, "请选择本链中其他玩家的画作")
            state.setdefault("awards", {})[str(chain_number)] = artist
            state["reveal_deadline"] = now + FAVORITE_RESULT_SECONDS
            return
        if not isinstance(vote, str) or vote not in {"same", "changed"}:
            self.fail(400, "投票无效")
        if stage != "match":
            self.fail(409, "匹配投票已经结束")
        state["chains"][chain_number]["votes"][str(player_id)] = vote
        self.reveal_tick(state, now)

    def brief(self, state, player_id):
        for player in state["players"]:
            if player["id"] == player_id:
                return {"id": player["id"], "name": player["name"], "avatar": player["avatar"]}
        return None

    def active_room(self, db, account_id, now):
        rows = db.execute(
            "SELECT gm.room_code,gm.player_id,gr.state,gr.expires_at FROM game_members gm JOIN game_rooms gr ON gr.code=gm.room_code WHERE gm.account_id=? AND gr.expires_at>? ORDER BY gm.last_seen DESC LIMIT 10",
            (account_id, now),
        ).fetchall()
        for row in rows:
            try:
                state = json.loads(row["state"])
            except (ValueError, TypeError):
                continue
            player = next((item for item in state.get("players", []) if item["id"] == row["player_id"] and item.get("active")), None)
            if player is not None:
                return {"code": row["room_code"], "player_id": row["player_id"], "phase": state.get("phase", "lobby")}
        return None

    def recover_host(self, db, state, now):
        host_id = state.get("host_id")
        if host_id is None or state.get("pause"):
            return False
        seen = {row["player_id"]: row["last_seen"] for row in db.execute("SELECT player_id,last_seen FROM game_members WHERE room_code=?", (state["code"],))}
        host = next((item for item in state["players"] if item["id"] == host_id), None)
        if host is not None and host.get("active") and now - seen.get(host_id, 0) < DISCONNECT_SECONDS:
            return False
        candidates = [
            item for item in state["players"]
            if item["id"] != host_id and item.get("active") and not item.get("is_bot") and not item.get("away")
            and now - seen.get(item["id"], 0) < DISCONNECT_SECONDS
        ]
        if not candidates:
            return False
        state["host_id"] = candidates[0]["id"]
        self.message(state, "系统", f"房主长时间未响应，{candidates[0]['name']}接任房主", True)
        return True

    def room(self, db, state, player_id, now, include_payload=True):
        seen = {r["player_id"]: r["last_seen"] for r in db.execute("SELECT player_id,last_seen FROM game_members WHERE room_code=?", (state["code"],))}
        players = []
        for p in state["players"]:
            submitted = state["phase"] == "playing" and self.entry(state, p)[1]
            players.append({"id": p["id"], "name": p["name"], "avatar": p["avatar"], "ready": p["ready"], "submitted": bool(submitted), "online": p["active"] and (p["is_bot"] or now - seen.get(p["id"], 0) <= ONLINE_SECONDS), "is_bot": p["is_bot"], "away": bool(p.get("away"))})
        task, reveal = None, None
        if include_payload and state["phase"] == "playing" and player_id in state["seats"]:
            chain = state["chains"][self.assignment(state, player_id)]
            kind = self.task_kind(state, player_id)
            previous = self.source_entry(chain, state["round"])
            if previous is None:
                source = {"text": chain["choices"][0] if state["round"] == 0 else chain["prompt"] or chain["choices"][0]}
            else:
                source = {"drawing": self.load_drawing(db, state["code"], previous.get("drawing_ref"))} if kind == "guess" else {"text": previous["text"]}
            task = {"kind": kind, "chain_id": self.assignment(state, player_id), "source": source}
            seats = state["seats"]
            owner_index = seats.index(chain["owner_id"])
            current_index = (owner_index + state["round"]) % len(seats)
            previous_id = chain["entries"][state["round"] - 1]["player_id"] if state["round"] > 0 else chain["owner_id"]
            task["from"] = self.brief(state, previous_id)
            task["to"] = self.brief(state, seats[(current_index + 1) % len(seats)]) if state["round"] + 1 < len(seats) else None
            if state["round"] == 0:
                task["choices"] = chain["choices"]
                task["choice"] = chain.get("prompt") or ""
                task["choice_deadline"] = state.get("choice_deadline")
            if str(player_id) in state["drafts"]:
                task["draft"] = self.hydrate(db, state["code"], state["drafts"][str(player_id)])
        if include_payload and state["phase"] == "reveal":
            awards = state.get("awards", {})
            chains = []
            scores = {str(p["id"]): 0 for p in state["players"]}
            for index, c in enumerate(state["chains"]):
                same = list(c["votes"].values()).count("same")
                changed = list(c["votes"].values()).count("changed")
                guesses = [item["text"] for item in c["entries"] if item["kind"] == "guess"]
                final_text = guesses[-1] if guesses else ""
                success = same + changed > 0 and same * 4 >= (same + changed) * 3
                if success:
                    scores[str(c["owner_id"])] += 1
                artist = awards.get(str(index))
                if artist is not None and str(artist) in scores:
                    scores[str(artist)] += 1
                award_player = self.brief(state, artist) if artist is not None else None
                public_entries = []
                for item in c["entries"]:
                    public_entry = self.hydrate(db, state["code"], item)
                    public_entry.pop("reveal_seconds", None)
                    public_entries.append(public_entry)
                chains.append({"owner_id": c["owner_id"], "owner_name": c["owner_name"], "prompt": c["prompt"], "entries": public_entries, "votes": {"same": same, "changed": changed}, "my_vote": c["votes"].get(str(player_id)), "vote_map": [{"player_id": int(key), "vote": value} for key, value in c["votes"].items()], "success": success, "award": artist, "award_name": award_player["name"] if award_player else None})
            reveal = {"chain": state["reveal_chain"], "step": state["reveal_step"], "stage": state.get("reveal_stage", "replay"), "deadline": state.get("reveal_deadline"), "chains": chains, "scores": scores}
        result = {"code": state["code"], "phase": state["phase"], "host_id": state["host_id"], "settings": state["settings"], "round": state["round"], "total_rounds": state.get("total_rounds", len(state["seats"])), "deadline": state["deadline"], "server_time": now, "version": state["version"], "game_id": state.get("game_id", 0), "players": players, "me": {"id": player_id, "host": player_id == state["host_id"]}, "chat": state["chat"]}
        result["pause"] = state.get("pause")
        if include_payload:
            result.update(task=task, reveal=reveal)
        return result

    def api(self, env, path, method):
        if method not in {"GET", "HEAD", "POST"}:
            self.fail(405, "此操作暂不支持")
        match = re.fullmatch(r"/api/game/rooms(?:/([A-Za-z2-9]{6})(?:/(join|ready|settings|start|choose|submit|draft|chat|leave|replay|reveal|pause|tea|tea_undo|tea_clear|tea_delete))?)?", path)
        if not match:
            self.fail(404, "没有找到这个游戏接口")
        code = match[1].upper() if match[1] else None
        action = match[2] or ("get" if code else "create")
        if action == "tea":
            if method not in {"GET", "HEAD", "POST"}:
                self.fail(405, "此操作暂不支持")
        elif (action == "get" and method not in {"GET", "HEAD"}) or (action != "get" and method != "POST"):
            self.fail(405, "此操作暂不支持")
        if method == "POST":
            self.app.check_origin(env)
            try:
                data = self.app.body(env, maximum=MAX_BODY)
            except RecursionError:
                self.fail(400, "提交内容层级过多")
        else:
            data = {}
        since_version = None
        if action == "get":
            query = parse_qs(env.get("QUERY_STRING", ""))
            if "since_version" in query:
                value = query["since_version"][0]
                if not value.isascii() or not value.isdigit() or len(value) > 18:
                    self.fail(400, "版本参数无效")
                since_version = int(value)
        now = self.clock()
        # All state transitions (including deadline/bot polling) serialize across workers.
        with self.app.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM game_tea WHERE room_code IN (SELECT code FROM game_rooms WHERE expires_at <= ? ORDER BY expires_at LIMIT 20)", (now,))
            db.execute("DELETE FROM game_rooms WHERE code IN (SELECT code FROM game_rooms WHERE expires_at <= ? ORDER BY expires_at LIMIT 20)", (now,))
            if action == "create":
                name, avatar = self.identity(data)
                practice = self.boolean(data.get("practice", False), "练习模式")
                settings = self.settings(db, data.get("settings", {}), partial=True)
                if settings["library_id"] is None:
                    row = db.execute("SELECT library_id FROM words GROUP BY library_id HAVING COUNT(*) > ? ORDER BY library_id LIMIT 1", (self.app.min_library_words,)).fetchone()
                    if row is None:
                        self.fail(400, "至少需要一个词条数超过 {} 的题库".format(self.app.min_library_words))
                    settings["library_id"] = row[0]
                self.app.check_storage()
                self.limit(db, env, "create", now)
                account = self.app.current_account(db, env)
                if self.app.require_accounts and account is None:
                    self.fail(401, "请先登录或注册账号，再创建房间")
                account_id = account["id"] if account else 0
                if db.execute("SELECT COUNT(*) FROM game_rooms").fetchone()[0] >= 200:
                    self.fail(503, "房间暂时已满，请稍后再试")
                while True:
                    code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
                    if not db.execute("SELECT 1 FROM game_rooms WHERE code=?", (code,)).fetchone():
                        break
                state = {"code": code, "phase": "lobby", "host_id": 1, "settings": settings, "round": 0, "deadline": None, "version": 1, "players": [], "next_id": 1, "seats": [], "chains": [], "drafts": {}, "chat": [], "chat_seq": 0, "practice": practice, "favorites": {}, "awards": {}, "reveal_stage": "lineup", "lobby_deadline": None, "lobby_next": None}
                db.execute("INSERT INTO game_rooms(code,state,expires_at) VALUES(?,?,?)", (code, "{}", now + ROOM_TTL))
                token = self.add_player(db, state, name, avatar, now, account_id=account_id)
                if practice:
                    for i, name in enumerate(("演示玩家 A", "演示玩家 B", "演示玩家 C")):
                        self.add_player(db, state, name, i + 1, now, bot=True)
                    self.message(state, "系统", "单人试玩房间：三位演示玩家会自动完成作画与猜词。", True)
                self.save(db, state, now)
                return 201, {"token": token, "room": self.room(db, state, 1, now)}
            member = None if action == "join" else self.authenticate(db, code, env)
            row = db.execute("SELECT state,expires_at FROM game_rooms WHERE code=?", (code,)).fetchone()
            if row is None or row["expires_at"] <= now:
                self.fail(404, "房间不存在或已过期")
            state = json.loads(row["state"])
            if action == "join":
                name, avatar = self.identity(data)
                self.phase(state, "lobby")
                if len(state["players"]) >= state["settings"]["max_players"]:
                    self.fail(409, "房间已经满员")
                self.limit(db, env, "join", now)
                account = self.app.current_account(db, env)
                if self.app.require_accounts and account is None:
                    self.fail(401, "请先登录或注册账号，再加入房间")
                account_id = account["id"] if account else 0
                if account_id and db.execute("SELECT 1 FROM game_members WHERE room_code=? AND account_id=?", (code, account_id)).fetchone():
                    self.fail(409, "你已经在这个房间，请从首页继续上次的房间")
                token = self.add_player(db, state, name, avatar, now, account_id=account_id)
                player_id = state["players"][-1]["id"]
                if not any(p["id"] == state["host_id"] and p["active"] for p in state["players"]):
                    state["host_id"] = player_id
                self.message(state, "系统", name + "加入了房间", True)
                state["version"] += 1
                self.save(db, state, now)
                return 201, {"token": token, "room": self.room(db, state, player_id, now)}
            player_id = member["player_id"]
            player = next((p for p in state["players"] if p["id"] == player_id and p["active"]), None)
            if player is None:
                self.fail(401, "房间身份无效，请重新加入")
            if now - member["last_seen"] >= SEEN_INTERVAL:
                db.execute("UPDATE game_members SET last_seen=? WHERE room_code=? AND player_id=?", (now, code, player_id))
                db.execute("UPDATE game_rooms SET expires_at=? WHERE code=?", (now + ROOM_TTL, code))
            if action == "tea" and method in {"GET", "HEAD"}:
                query = parse_qs(env.get("QUERY_STRING", ""))
                since = query.get("since", ["0"])[0]
                if not since.isdigit() or len(since) > 18:
                    self.fail(400, "茶绘版本参数无效")
                rows = db.execute("SELECT id,player_id,stroke FROM game_tea WHERE room_code=? AND id>? ORDER BY id LIMIT 2000", (code, int(since))).fetchall()
                strokes = [{"id": row["id"], "player_id": row["player_id"], "stroke": json.loads(row["stroke"])} for row in rows]
                return 200, {"strokes": strokes, "last_id": strokes[-1]["id"] if strokes else int(since)}
            changed = self.externalize_drawings(db, state)
            changed = self.connection_tick(db, state, now) or changed
            changed = self.tick(db, state, now) or changed
            changed = self.recover_host(db, state, now) or changed
            if state["phase"] == "reveal" and not state.get("demo_saved"):
                changed = bool(self.save_demo(db, state, now)) or changed
            # Persist clock-driven transitions even when the requested stale mutation fails.
            if changed:
                state["version"] += 1
                self.save(db, state, now)
                db.commit()
                db.execute("BEGIN IMMEDIATE")
                # A leave request may revoke this token while the lock is released.
                member = self.authenticate(db, code, env)
                row = db.execute("SELECT state,expires_at FROM game_rooms WHERE code=?", (code,)).fetchone()
                if row is None or row["expires_at"] <= now:
                    self.fail(404, "房间不存在或已过期")
                state = json.loads(row["state"])
                player = next((p for p in state["players"] if p["id"] == player_id and p["active"]), None)
                if player is None:
                    self.fail(401, "房间身份无效，请重新加入")
            changed = False
            if action != "get":
                self.limit(db, env, "chat" if action == "chat" else "mutate", now)
                if action == "ready":
                    self.phase(state, "lobby")
                    player["ready"] = self.boolean(data.get("ready"), "准备状态")
                elif action == "settings":
                    self.host(state, player_id)
                    self.phase(state, "lobby")
                    settings = self.settings(db, data)
                    if settings["max_players"] < len(state["players"]):
                        self.fail(409, "人数上限不能小于现有玩家数")
                    state["settings"] = settings
                    for p in state["players"]:
                        p["ready"] = p["is_bot"]
                elif action == "start":
                    self.start(db, state, player_id, now)
                elif action == "tea":
                    self.phase(state, "lobby")
                    self.limit(db, env, "mutate", now)
                    stroke = data.get("stroke")
                    normalized = self.drawing({"strokes": [stroke]})["strokes"][0]
                    if normalized["tool"] in {"eraser", "fill"}:
                        self.fail(400, "茶绘只能提交笔迹；请用自己的线条橡皮")
                    total = db.execute("SELECT COUNT(*) FROM game_tea WHERE room_code=?", (code,)).fetchone()[0]
                    if total >= 5000:
                        self.fail(409, "茶绘笔画已经很多，请先清理自己的线条")
                    db.execute("INSERT INTO game_tea(room_code,player_id,stroke,created_at) VALUES(?,?,?,?)",
                               (code, player_id, json.dumps(normalized, ensure_ascii=False, separators=(",", ":")), now))
                elif action == "tea_undo":
                    self.phase(state, "lobby")
                    self.limit(db, env, "mutate", now)
                    row = db.execute("SELECT id FROM game_tea WHERE room_code=? AND player_id=? ORDER BY id DESC LIMIT 1", (code, player_id)).fetchone()
                    if row:
                        db.execute("DELETE FROM game_tea WHERE id=?", (row["id"],))
                elif action == "tea_clear":
                    self.phase(state, "lobby")
                    self.limit(db, env, "mutate", now)
                    db.execute("DELETE FROM game_tea WHERE room_code=? AND player_id=?", (code, player_id))
                elif action == "tea_delete":
                    self.phase(state, "lobby")
                    self.limit(db, env, "mutate", now)
                    stroke_id = self.integer(data.get("id"), 1, 2**63 - 1, "线条")
                    db.execute("DELETE FROM game_tea WHERE id=? AND room_code=? AND player_id=?", (stroke_id, code, player_id))
                elif action == "choose":
                    self.choose(state, player, data)
                elif action in {"submit", "draft"}:
                    changed = self.submission(db, state, player, data, action == "submit")
                elif action == "pause":
                    self.host(state, player_id)
                    self.phase(state, "playing")
                    pause = state.get("pause")
                    if not pause:
                        self.fail(409, "当前没有掉线暂停")
                    if data.get("cancel") is True:
                        seen = {r["player_id"]: r["last_seen"] for r in db.execute("SELECT player_id,last_seen FROM game_members WHERE room_code=?", (code,))}
                        waiting = [p for p in state["players"] if p["id"] in pause["players"] and now - seen.get(p["id"], 0) >= DISCONNECT_SECONDS]
                        self.end_pause(state, now, waiting)
                    else:
                        seconds = self.integer(data.get("seconds"), 1, 120, "增加暂停时长")
                        if pause["until"] - pause["started"] + seconds > 600:
                            self.fail(400, "单次等待最多延长到10分钟")
                        pause["until"] += seconds
                elif action == "chat":
                    text = self.clean(data.get("text"), "聊天内容", 300, True)
                    self.message(state, player["name"], text)
                elif action == "leave":
                    player["active"], player["ready"] = False, False
                    db.execute("DELETE FROM game_members WHERE room_code=? AND player_id=?", (code, player_id))
                    if state["phase"] == "lobby":
                        state["players"].remove(player)
                    humans = [p for p in state["players"] if p["active"] and not p["is_bot"]]
                    if state["host_id"] == player_id:
                        state["host_id"] = humans[0]["id"] if humans else None
                    if not humans:
                        for p in state["players"]:
                            p["active"] = False
                    self.message(state, "系统", player["name"] + "离开了房间", True)
                elif action == "replay":
                    self.host(state, player_id)
                    self.phase(state, "reveal")
                    state["players"] = [p for p in state["players"] if p["active"]]
                    for p in state["players"]:
                        p["ready"] = p["is_bot"]
                    state.update(phase="lobby", round=0, total_rounds=0, deadline=None, seats=[], chains=[], drafts={}, pause=None, favorites={}, awards={}, reveal_stage="lineup", reveal_chain=0, reveal_step=0, reveal_deadline=None, choice_deadline=None, lobby_deadline=None, lobby_next=None)
                    self.message(state, "系统", "回到大厅，可以再来一局！", True)
                elif action == "reveal":
                    self.reveal(state, player_id, data, now)
                    if state["phase"] == "reveal":
                        self.save_demo(db, state, now, force=True)
                if action not in {"submit", "draft"}:
                    changed = True
                changed = self.tick(db, state, now) or changed
                if state["phase"] == "reveal" and not state.get("demo_saved"):
                    changed = bool(self.save_demo(db, state, now)) or changed
            if changed:
                state["version"] += 1
                self.save(db, state, now)
            unchanged = action == "get" and since_version == state["version"]
            result = {"room": self.room(db, state, player_id, now, include_payload=not unchanged)}
            if unchanged:
                result["unchanged"] = True
            return 200, result
