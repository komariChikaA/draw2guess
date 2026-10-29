"""Real WSGI/SQLite integration tests for the persistent relay game API.

Run with ``python -m unittest discover -s tests -v``. Only the game clock is
replaced: requests, transactions, credentials, validation and races are real.
"""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import urlsplit

from app import create_app
from game import EMPTY_TTL, MAX_BODY, MAX_POINTS, MAX_STROKES, ROOM_TTL


class GameApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.db_path = str(Path(self.temp_dir.name) / "game.sqlite3")
        self.now = 1_700_000_000.0
        self.app = self.new_worker()
        with self.app.connect() as db:
            row = db.execute("INSERT INTO libraries(name,name_key) VALUES('测试题库','测试题库')")
            self.library_id = row.lastrowid
            for index in range(60):
                word = "测试词{:02d}".format(index)
                db.execute("INSERT INTO words(library_id,text,text_key) VALUES(?,?,?)", (self.library_id, word, word))

    def new_worker(self):
        worker = create_app(self.db_path, seed=False, randomize_seats=False, require_accounts=False, min_library_words=0)
        worker.game.clock = lambda: self.now
        return worker

    def request(self, method, target, payload=None, token=None, headers=None,
                raw=None, app=None, client="127.0.0.1"):
        parts = urlsplit(target)
        body = raw if raw is not None else (
            json.dumps(payload, ensure_ascii=False).encode("utf-8")
            if payload is not None else b""
        )
        environ = {
            "REQUEST_METHOD": method, "SCRIPT_NAME": "", "PATH_INFO": parts.path,
            "QUERY_STRING": parts.query, "SERVER_NAME": "localhost",
            "SERVER_PORT": "8080", "SERVER_PROTOCOL": "HTTP/1.1",
            "HTTP_HOST": "localhost:8080", "REMOTE_ADDR": client,
            "CONTENT_LENGTH": str(len(body)), "wsgi.version": (1, 0),
            "wsgi.url_scheme": "http", "wsgi.input": io.BytesIO(body),
            "wsgi.errors": io.StringIO(), "wsgi.multithread": True,
            "wsgi.multiprocess": True, "wsgi.run_once": False,
        }
        if payload is not None:
            environ["CONTENT_TYPE"] = "application/json"
        if token is not None:
            environ["HTTP_X_GAME_TOKEN"] = token
        for name, value in (headers or {}).items():
            key = name.upper().replace("-", "_")
            environ[key if key in {"CONTENT_TYPE", "CONTENT_LENGTH"} else "HTTP_" + key] = value
        response = {}

        def start_response(status, response_headers, exc_info=None):
            response["status"] = int(status.split(" ", 1)[0])
            response["headers"] = {k.lower(): v for k, v in response_headers}

        iterable = (app or self.app)(environ, start_response)
        try:
            response["body"] = b"".join(iterable)
        finally:
            if hasattr(iterable, "close"):
                iterable.close()
        return response

    def api(self, method, target, payload=None, expected=200, **kwargs):
        response = self.request(method, target, payload, **kwargs)
        self.assertEqual(response["status"], expected, response["body"][:1000])
        self.assertIn("application/json", response["headers"]["content-type"])
        self.assertEqual(response["headers"]["cache-control"], "no-store")
        self.assertEqual(int(response["headers"]["content-length"]), len(response["body"]))
        result = json.loads(response["body"])
        if expected >= 400:
            self.assertIsInstance(result.get("error"), str)
            self.assertTrue(result["error"].strip())
        return result

    def create(self, name="房主", avatar=0, settings=None, practice=False, **kwargs):
        payload = {"name": name, "avatar": avatar, "practice": practice}
        if settings is not None:
            payload["settings"] = settings
        result = self.api("POST", "/api/game/rooms", payload, expected=201, **kwargs)
        room = result["room"]
        return {"code": room["code"], "id": room["me"]["id"], "token": result["token"]}, room

    def join(self, host, name="玩家", avatar=1, **kwargs):
        result = self.api("POST", "/api/game/rooms/" + host["code"] + "/join",
                          {"name": name, "avatar": avatar}, expected=201, **kwargs)
        return {"code": host["code"], "id": result["room"]["me"]["id"],
                "token": result["token"]}, result["room"]

    def action(self, player, action, payload=None, expected=200, **kwargs):
        return self.api("POST", "/api/game/rooms/" + player["code"] + "/" + action,
                        {} if payload is None else payload, token=player["token"],
                        expected=expected, **kwargs)

    def poll(self, player, **kwargs):
        result = self.api("GET", "/api/game/rooms/" + player["code"],
                          token=player["token"], **kwargs)
        return result.get("room", result)

    def lobby(self, count=4, settings=None):
        host, room = self.create(settings=settings)
        players = [host]
        for i in range(1, count):
            player, room = self.join(host, name="玩家" + str(i), avatar=i % 8)
            players.append(player)
        return players, room

    def playing(self, settings=None):
        players, _ = self.lobby(settings=settings)
        for player in players[1:]:
            self.action(player, "ready", {"ready": True})
        room = self.action(players[0], "start")["room"]
        return players, room

    @staticmethod
    def drawing(marker=1):
        return {"strokes": [{"tool": "pen", "color": "#abcdef", "size": 3,
                             "points": [[marker, 10], [marker + 1, 20]]}]}

    def final_payload(self, room, marker=None):
        payload = {"round": room["round"], "kind": room["task"]["kind"]}
        if payload["kind"] == "draw":
            payload["drawing"] = self.drawing(marker or room["me"]["id"])
            if room["round"] == 0:
                payload["text"] = room["task"].get("choice") or room["task"]["choices"][1]
        else:
            payload["text"] = "猜测-{}-{}".format(room["round"], room["me"]["id"])
        return payload

    def complete_round(self, players):
        for player in players:
            room = self.poll(player)
            self.action(player, "submit", self.final_payload(room))
        return self.poll(players[0])

    def revealed(self):
        players, _ = self.playing()
        for _ in range(4):
            room = self.complete_round(players)
        self.assertEqual(room["phase"], "reveal")
        return players, room

    def reveal_stage(self, player, stage, limit=100):
        for _ in range(limit):
            reveal = self.poll(player)["reveal"]
            if reveal["stage"] == stage:
                return reveal
            deadline = reveal.get("deadline")
            self.now = (deadline if deadline is not None else self.now) + 0.05
        self.fail("reveal did not reach " + stage)

    def settle_chain(self, players, index, votes, award=True):
        reveal = self.reveal_stage(players[0], "match")
        self.assertEqual(reveal["chain"], index)
        for player, vote in zip(players, votes):
            self.action(player, "reveal", {"vote": vote, "chain": index})
        reveal = self.poll(players[0])["reveal"]
        self.assertEqual(reveal["stage"], "match_result")
        self.now = (reveal.get("deadline") or self.now) + 0.05
        reveal = self.poll(players[0])["reveal"]
        self.assertEqual(reveal["stage"], "favorite")
        chain = reveal["chains"][index]
        if award:
            owner = next(player for player in players if player["id"] == chain["owner_id"])
            candidates = [entry for entry in chain["entries"]
                          if entry["kind"] == "draw" and entry["player_id"] != chain["owner_id"]]
            if candidates:
                self.action(owner, "reveal", {"vote": "favorite", "chain": index, "artist": candidates[0]["player_id"]})
        self.now += 3.2
        self.poll(players[0])

    def skip_chain(self, players, index):
        reveal = self.reveal_stage(players[0], "match")
        self.assertEqual(reveal["chain"], index)
        self.now = (reveal.get("deadline") or self.now) + 0.05
        reveal = self.poll(players[0])["reveal"]
        self.assertEqual(reveal["stage"], "match_result")
        self.now = (reveal.get("deadline") or self.now) + 0.05
        reveal = self.poll(players[0])["reveal"]
        self.assertEqual(reveal["stage"], "favorite")
        self.now = (reveal.get("deadline") or self.now) + 0.05
        self.poll(players[0])

    def persisted(self, code):
        with self.app.connect() as db:
            row = db.execute("SELECT state,expires_at FROM game_rooms WHERE code=?", (code,)).fetchone()
        return None if row is None else (json.loads(row["state"]), row["expires_at"])

    def assert_private(self, room, expected_task=None):
        self.assertEqual(room["phase"], "playing")
        self.assertIsNone(room["reveal"])
        self.assertEqual(set(room), {"code", "phase", "host_id", "settings", "round",
                                    "total_rounds", "deadline", "server_time", "version",
                                    "players", "me", "task", "chat", "reveal", "game_id", "pause"})
        if expected_task is not None:
            actual = {key: value for key, value in room["task"].items() if key not in {"from", "to"}}
            self.assertEqual(actual, expected_task)
            self.assertIn("from", room["task"]); self.assertIn("to", room["task"])
        for player in room["players"]:
            self.assertEqual(set(player), {"id", "name", "avatar", "ready", "submitted", "online", "is_bot", "away"})
        def inspect(value):
            if isinstance(value, dict):
                self.assertFalse(set(value) & {"token", "token_hash", "last_seen", "chains", "entries",
                                              "seats", "drafts", "prompt", "owner_id", "owner_name"})
                for child in value.values():
                    inspect(child)
            elif isinstance(value, list):
                for child in value:
                    inspect(child)
        inspect(room)

    def test_four_player_full_relay_unique_chains_and_private_each_stage(self):
        players, room = self.playing()
        seats = [p["id"] for p in players]
        entries = [[] for _ in players]
        prompts = {}
        assignments = {p["id"]: [] for p in players}
        self.assertEqual(room["total_rounds"], 4)
        for round_number in range(4):
            self.assertEqual(room["round"], round_number)
            self.assertEqual(room["deadline"], self.now + (15 if round_number == 0 else 0) + (60 if round_number % 2 else 180))
            for index, player in enumerate(players):
                current = self.poll(player)
                chain_id = (index - round_number) % 4
                assignments[player["id"]].append(chain_id)
                kind = "guess" if round_number % 2 else "draw"
                expected = {"kind": kind, "chain_id": chain_id}
                if round_number == 0:
                    expected["source"] = {"text": current["task"]["choices"][0]}
                    expected["choices"] = current["task"]["choices"]
                    expected["choice"] = current["task"]["choice"]
                    expected["choice_deadline"] = current["task"]["choice_deadline"]
                    self.assertIsNotNone(current["task"]["choice_deadline"])
                    self.assertEqual(len(expected["choices"]), 3)
                elif kind == "guess":
                    expected["source"] = {"drawing": entries[chain_id][-1]["drawing"]}
                else:
                    expected["source"] = {"text": entries[chain_id][-1]["text"]}
                self.assert_private(current, expected)
                self.assertFalse(next(p for p in current["players"] if p["id"] == player["id"])["submitted"])
                payload = self.final_payload(current, marker=100 * (round_number + 1) + player["id"])
                entry = {"player_id": player["id"], "player_name": "房主" if index == 0 else "玩家" + str(index),
                         "kind": kind, "timed_out": False}
                if kind == "draw":
                    entry["drawing"] = payload["drawing"]
                    if round_number == 0:
                        entry["text"] = payload["text"]
                        prompts[chain_id] = payload["text"]
                else:
                    entry["text"] = payload["text"]
                entries[chain_id].append(entry)
                updated = self.action(player, "submit", payload)["room"]
                if index < 3:
                    if round_number == 0: expected["choice"] = updated["task"].get("choice", "")
                    self.assert_private(updated, expected)
                    self.assertTrue(next(p for p in updated["players"] if p["id"] == player["id"])["submitted"])
                    # Another player's answer/canvas never joins this player's private task.
                    observer = players[(index + 1) % 4]
                    observed = self.poll(observer)
                    self.assert_private(observed)
                    self.assertNotIn("draft", observed["task"])
            room = self.poll(players[0])
        self.assertEqual(room["phase"], "reveal")
        self.assertEqual(room["round"], 3)
        self.assertIsNone(room["task"])
        self.assertIsNone(room["deadline"])
        self.assertEqual((room["reveal"]["chain"], room["reveal"]["step"]), (0, 0))
        for index, chain in enumerate(room["reveal"]["chains"]):
            self.assertEqual(chain["owner_id"], seats[index])
            self.assertEqual(chain["prompt"], prompts[index])
            self.assertEqual(chain["entries"], entries[index])
            self.assertEqual([e["kind"] for e in chain["entries"]], ["draw", "guess", "draw", "guess"])
            self.assertEqual([e["player_id"] for e in chain["entries"]], seats[index:] + seats[:index])
            self.assertEqual(chain["votes"], {"same": 0, "changed": 0})
        for visited in assignments.values():
            self.assertEqual(set(visited), set(range(4)))

    def test_match_requires_at_least_75_percent_yes(self):
        players, room = self.revealed()
        host, second, third, fourth = players
        # Chain 0: 3 yes / 1 no = 75%, passes; its owner is the host.
        self.settle_chain(players, 0, ["same", "same", "same", "changed"])
        # Chain 1: 2 yes / 2 no = 50%, fails; its owner is the second player.
        self.settle_chain(players, 1, ["same", "same", "changed", "changed"])
        self.skip_chain(players, 2)
        self.skip_chain(players, 3)
        final = self.reveal_stage(host, "scores")
        self.assertTrue(final["chains"][0]["success"])
        self.assertEqual(final["chains"][0]["votes"], {"same": 3, "changed": 1})
        self.assertFalse(final["chains"][1]["success"])
        self.assertEqual(final["chains"][1]["votes"], {"same": 2, "changed": 2})
        self.assertFalse(final["chains"][2]["success"])
        self.assertEqual(final["scores"][str(host["id"])], 1)
        self.assertEqual(final["scores"][str(second["id"])], 0)

    def test_start_rejects_library_with_only_fifty_words(self):
        with self.app.connect() as db:
            row = db.execute("INSERT INTO libraries(name,name_key) VALUES('五十词库','五十词库')")
            library_id = row.lastrowid
            for index in range(50):
                word = "五十词{:02d}".format(index)
                db.execute("INSERT INTO words(library_id,text,text_key) VALUES(?,?,?)", (library_id, word, word))
        self.app.min_library_words = 50
        players, _ = self.create(settings={"library_id": library_id})
        others = [self.join(players, name="五十玩家" + str(i))[0] for i in range(1, 4)]
        for player in others:
            self.action(player, "ready", {"ready": True})
        self.action(players, "start", expected=400)
        self.app.min_library_words = 0

    def test_all_players_receive_three_unique_prompts_without_overlap(self):
        players, _ = self.playing()
        offered = [self.poll(player)["task"]["choices"] for player in players]
        self.assertTrue(all(len(set(choices)) == 3 for choices in offered))
        flattened = [word for choices in offered for word in choices]
        self.assertEqual(len(flattened), len(set(flattened)))

    def test_odd_player_count_shortens_chains_and_ends_with_a_guess(self):
        players, room = self.lobby(count=5)
        for player in players[1:]:
            self.action(player, "ready", {"ready": True})
        started = self.action(players[0], "start")["room"]
        self.assertEqual(started["total_rounds"], 4)
        self.assertEqual(started["round"], 0)
        for _ in range(4):
            self.complete_round(players)
        final = self.poll(players[0])
        self.assertEqual(final["phase"], "reveal")
        self.assertEqual(final["total_rounds"], 4)
        seats = [p["id"] for p in players]
        for chain in final["reveal"]["chains"]:
            self.assertEqual(len(chain["entries"]), 4)
            self.assertEqual([entry["kind"] for entry in chain["entries"]], ["draw", "guess", "draw", "guess"])
            self.assertEqual(len({entry["player_id"] for entry in chain["entries"]}), 4)
            missing = set(seats) - {entry["player_id"] for entry in chain["entries"]}
            self.assertEqual(len(missing), 1)

    def auth_request(self, path, payload=None, cookie=None, method="POST"):
        headers = {"Cookie": cookie} if cookie else None
        return self.request(method, path, payload, headers=headers)

    def test_tea_drawing_is_shared_and_only_own_strokes_can_be_removed(self):
        players, room = self.lobby()
        host, guest = players[:2]
        stroke = self.drawing(7)["strokes"][0]
        self.action(host, "tea", {"stroke": stroke})
        result = self.api("GET", f"/api/game/rooms/{host['code']}/tea?since=0", token=guest["token"])
        self.assertEqual(len(result["strokes"]), 1)
        stroke_id = result["strokes"][0]["id"]
        self.assertEqual(result["strokes"][0]["player_id"], host["id"])
        self.action(guest, "tea_delete", {"id": stroke_id})
        still = self.api("GET", f"/api/game/rooms/{host['code']}/tea?since=0", token=guest["token"])
        self.assertEqual(len(still["strokes"]), 1)
        self.action(guest, "tea", {"stroke": self.drawing(8)["strokes"][0]})
        self.action(guest, "tea_undo")
        after_undo = self.api("GET", f"/api/game/rooms/{host['code']}/tea?since=0", token=guest["token"])
        self.assertEqual([item["player_id"] for item in after_undo["strokes"]], [host["id"]])
        self.action(host, "tea_clear")
        empty = self.api("GET", f"/api/game/rooms/{host['code']}/tea?since=0", token=guest["token"])
        self.assertEqual(empty["strokes"], [])
        for player in players[1:]:
            self.action(player, "ready", {"ready": True})
        self.action(host, "start")
        self.action(guest, "tea", {"stroke": stroke}, expected=409)

    def test_gallery_and_replay_library_round_trip(self):
        self.revealed()
        with self.app.connect() as db:
            demo = db.execute("SELECT id FROM game_demos ORDER BY id DESC LIMIT 1").fetchone()
        self.assertIsNotNone(demo)
        registered = self.auth_request("/api/auth/register", {"username": "作品库玩家", "password": "secret123"})
        self.assertEqual(registered["status"], 201, registered["body"])
        cookie = registered["headers"]["set-cookie"].split(";", 1)[0]
        replays = self.api("GET", "/api/library/replays", headers={"Cookie": cookie})
        self.assertGreaterEqual(len(replays["replays"]), 1)
        replay = self.api("GET", "/api/library/replays/" + str(demo[0]), headers={"Cookie": cookie})["replay"]
        self.assertEqual(len(replay["chains"]), 4)
        draw_step = next(index for index, entry in enumerate(replay["chains"][0]["entries"]) if entry["kind"] == "draw")
        favorite = self.api("POST", "/api/library/replays/" + str(demo[0]) + "/favorite",
                            {"chain": 0, "entry": draw_step}, expected=201, headers={"Cookie": cookie})
        self.assertIn("artwork", favorite)
        gallery = self.api("GET", "/api/library/gallery", headers={"Cookie": cookie})["artworks"]
        self.assertEqual(len(gallery), 1)
        created = self.api("POST", "/api/library/gallery", {"title": "我的画", "drawing": self.drawing(9)},
                           expected=201, headers={"Cookie": cookie})["artwork"]
        self.assertEqual(created["title"], "我的画")
        updated = self.api("POST", "/api/library/gallery/" + str(created["id"]),
                           {"title": "改名后的画", "drawing": self.drawing(10)}, headers={"Cookie": cookie})["artwork"]
        self.assertEqual(updated["title"], "改名后的画")
        self.api("DELETE", "/api/library/gallery/" + str(created["id"]), headers={"Cookie": cookie})
        remaining = self.api("GET", "/api/library/gallery", headers={"Cookie": cookie})["artworks"]
        self.assertEqual(len(remaining), 1)
        self.api("GET", "/api/library/gallery", expected=401)

    def test_account_cookie_login_and_cookie_only_cross_device_reclaim(self):
        registered = self.auth_request("/api/auth/register", {"username": "跨设备玩家", "password": "secret123"})
        self.assertEqual(registered["status"], 201, registered["body"])
        set_cookie = registered["headers"]["set-cookie"]
        self.assertIn("HttpOnly", set_cookie)
        self.assertIn("SameSite=Lax", set_cookie)
        self.assertIn("Path=/", set_cookie)
        cookie = set_cookie.split(";", 1)[0]
        body = json.loads(registered["body"])
        self.assertEqual(body["account"]["username"], "跨设备玩家")
        self.assertIsNone(body["active_room"])
        me = self.auth_request("/api/auth/me", method="GET", cookie=cookie)
        self.assertEqual(me["status"], 200)
        self.assertEqual(json.loads(me["body"])["account"]["username"], "跨设备玩家")
        with self.app.connect() as db:
            stored = db.execute("SELECT password_hash,salt FROM accounts WHERE username_key=?", ("跨设备玩家",)).fetchone()
            self.assertNotEqual(stored["password_hash"], "secret123")
            self.assertNotIn("secret123", stored["password_hash"])

        created = self.request("POST", "/api/game/rooms", {"name": "跨设备玩家", "avatar": 0, "settings": {"draw_seconds": 90, "guess_seconds": 45}}, headers={"Cookie": cookie})
        self.assertEqual(created["status"], 201, created["body"])
        created_room = json.loads(created["body"])
        code, host_token, host_id = created_room["room"]["code"], created_room["token"], created_room["room"]["me"]["id"]
        host = {"code": code, "token": host_token, "id": host_id}
        others = [self.join(host, name="玩家" + str(i))[0] for i in range(1, 4)]
        for player in others:
            self.action(player, "ready", {"ready": True})
        self.action(host, "start")

        login = self.auth_request("/api/auth/login", {"username": "跨设备玩家", "password": "secret123"})
        self.assertEqual(login["status"], 200)
        new_cookie = login["headers"]["set-cookie"].split(";", 1)[0]
        cross = self.auth_request("/api/auth/me", method="GET", cookie=new_cookie)
        cross_body = json.loads(cross["body"])
        self.assertEqual(cross_body["account"]["username"], "跨设备玩家")
        self.assertEqual(cross_body["active_room"]["code"], code)
        cookie_room = self.auth_request("/api/game/rooms/" + code, method="GET", cookie=new_cookie)
        self.assertEqual(cookie_room["status"], 200, cookie_room["body"])
        self.assertEqual(json.loads(cookie_room["body"])["room"]["me"]["id"], host_id)
        # The registered cookie also still works on the old device.
        old_room = self.auth_request("/api/game/rooms/" + code, method="GET", cookie=cookie)
        self.assertEqual(old_room["status"], 200)
        self.assertEqual(json.loads(old_room["body"])["room"]["me"]["id"], host_id)

        logout = self.auth_request("/api/auth/logout", {}, cookie=new_cookie)
        self.assertEqual(logout["status"], 200)
        self.assertIn("Max-Age=0", logout["headers"]["set-cookie"])
        after = self.auth_request("/api/auth/me", method="GET", cookie=new_cookie)
        self.assertIsNone(json.loads(after["body"])["account"])

    def test_account_validation_duplicate_login_and_rate_limit(self):
        for payload, expected in [
            ({"username": "ab", "password": "secret123"}, 400),
            ({"username": "bad name", "password": "secret123"}, 400),
            ({"username": "正常账号", "password": "123"}, 400),
            ({"username": "正常账号", "password": "a" * 73}, 400),
            ({"username": "正常账号", "password": 123456}, 400),
        ]:
            response = self.auth_request("/api/auth/register", payload)
            self.assertEqual(response["status"], expected, response["body"])
        first = self.auth_request("/api/auth/register", {"username": "CaseUser", "password": "secret123"})
        self.assertEqual(first["status"], 201)
        duplicate = self.auth_request("/api/auth/register", {"username": "caseuser", "password": "secret123"})
        self.assertEqual(duplicate["status"], 409)
        wrong = self.auth_request("/api/auth/login", {"username": "CaseUser", "password": "wrong123"})
        self.assertEqual(wrong["status"], 401)
        missing = self.auth_request("/api/auth/login", {"username": "NoSuchUser", "password": "secret123"})
        self.assertEqual(missing["status"], 401)

    def test_account_registration_is_required_for_create_and_join(self):
        strict = create_app(self.db_path, seed=False, randomize_seats=False, require_accounts=True)
        strict.game.clock = lambda: self.now
        guest_create = self.request("POST", "/api/game/rooms", {"name": "游客", "avatar": 0}, app=strict)
        self.assertEqual(guest_create["status"], 401)
        self.assertIn("登录", json.loads(guest_create["body"])["error"])
        registered = self.request("POST", "/api/auth/register", {"username": "严格玩家", "password": "secret123"}, app=strict)
        self.assertEqual(registered["status"], 201, registered["body"])
        cookie = registered["headers"]["set-cookie"].split(";", 1)[0]
        created = self.request("POST", "/api/game/rooms", {"name": "严格玩家", "avatar": 0},
                               headers={"Cookie": cookie}, app=strict)
        self.assertEqual(created["status"], 201, created["body"])
        code = json.loads(created["body"])["room"]["code"]
        guest_join = self.request("POST", f"/api/game/rooms/{code}/join", {"name": "游客", "avatar": 1}, app=strict)
        self.assertEqual(guest_join["status"], 401)
        self.assertIn("登录", json.loads(guest_join["body"])["error"])

    def test_host_migrates_when_disconnected_in_lobby_and_reveal(self):
        players, _ = self.lobby()
        self.now += 13
        migrated = self.poll(players[1])
        self.assertEqual(migrated["host_id"], players[1]["id"])
        self.assertTrue(migrated["me"]["host"])
        old_host = self.poll(players[0])
        self.assertFalse(old_host["me"]["host"])

        players, _ = self.revealed()
        self.now += 13
        migrated = self.poll(players[1])
        self.assertEqual(migrated["host_id"], players[1]["id"])
        self.assertTrue(migrated["me"]["host"])

    def test_start_randomizes_members_into_one_fixed_circle(self):
        players, lobby = self.lobby()
        join_order = [p["id"] for p in lobby["players"]]
        self.app.randomize_seats = True
        self.app.game.seat_shuffle = lambda rows: rows.reverse()
        for player in players[1:]:
            self.action(player, "ready", {"ready": True})
        started = self.action(players[0], "start")["room"]
        circle = [p["id"] for p in started["players"]]
        self.assertEqual(circle, list(reversed(join_order)))
        for index, player in enumerate(players):
            room = self.poll(player)
            expected_to = started["players"][(circle.index(player["id"]) + 1) % len(circle)]["id"]
            self.assertEqual(room["task"]["to"]["id"], expected_to)
            self.assertEqual(room["task"]["from"]["id"], player["id"])
        self.app.game.seat_shuffle = None

    def test_credentials_are_persistent_hashed_unique_and_room_scoped(self):
        players, _ = self.lobby()
        tokens = [p["token"] for p in players]
        self.assertEqual(len(set(tokens)), 4)
        for token in tokens:
            self.assertRegex(token, r"^[A-Za-z0-9_-]{43}$")
        worker = self.new_worker()
        for player in players:
            self.assertEqual(self.poll(player, app=worker)["me"]["id"], player["id"])
        self.action(players[1], "ready", {"ready": True}, app=worker)
        self.assertTrue(self.poll(players[0])["players"][1]["ready"])
        with self.app.connect() as db:
            hashes = [r[0] for r in db.execute("SELECT token_hash FROM game_members ORDER BY player_id")]
        self.assertEqual(hashes, [hashlib.sha256(t.encode("ascii")).hexdigest() for t in tokens])
        state, _ = self.persisted(players[0]["code"])
        for token in tokens:
            self.assertNotIn(token, json.dumps(state))
        other, _ = self.create(name="另一个房间")
        path = "/api/game/rooms/" + players[0]["code"]
        for token in [None, "", "bad", "a" * 43, other["token"], hashes[0]]:
            self.api("GET", path, token=token, expected=401)
        # Lowercase room codes normalize; credentials are never accepted in query/body.
        self.assertEqual(self.api("GET", path.lower(), token=tokens[0])["room"]["code"], players[0]["code"])
        self.api("GET", path + "?token=" + tokens[0], expected=401)
        self.api("POST", path + "/ready", {"ready": True, "token": tokens[0]}, expected=401)

    def test_host_permissions_ready_minimum_players_and_reset_after_settings(self):
        host, _ = self.create()
        self.action(host, "start", expected=409)
        others = [self.join(host, name="玩家" + str(i))[0] for i in range(3)]
        self.action(others[0], "start", expected=403)
        self.action(others[0], "settings", dict(self.poll(host)["settings"]), expected=403)
        self.action(host, "start", expected=409)
        self.action(others[0], "ready", {"ready": 1}, expected=400)
        self.action(others[0], "ready", {}, expected=400)
        for player in others:
            self.action(player, "ready", {"ready": True})
        self.action(others[0], "ready", {"ready": False})
        self.action(host, "start", expected=409)
        self.action(others[0], "ready", {"ready": True})
        settings = dict(self.poll(host)["settings"], max_players=4, draw_seconds=30, guess_seconds=15)
        changed = self.action(host, "settings", settings)["room"]
        self.assertEqual(changed["settings"], settings)
        self.assertFalse(any(p["ready"] for p in changed["players"]))
        self.action(host, "start", expected=409)
        for player in others:
            self.action(player, "ready", {"ready": True})
        # The host need not explicitly ready themselves.
        started = self.action(host, "start")["room"]
        self.assertEqual(started["phase"], "playing")
        self.assertEqual(started["deadline"], self.now + 15 + 30)
        self.assertEqual(started["task"]["choice_deadline"], self.now + 15)
        for action, payload in [("start", {}), ("ready", {"ready": True}), ("settings", settings),
                                ("replay", {}), ("reveal", {"step": 0})]:
            self.action(host, action, payload, expected=409)
        self.api("POST", "/api/game/rooms/" + host["code"] + "/join",
                 {"name": "迟到玩家", "avatar": 2}, expected=409)

    def test_lobby_auto_starts_after_five_second_chat_countdown(self):
        players, _ = self.lobby()
        for player in players:
            self.action(player, "ready", {"ready": True})
        room = self.poll(players[0])
        self.assertEqual(room["phase"], "lobby")
        self.assertEqual([message["text"] for message in room["chat"] if message["text"] in {"5", "4", "3", "2", "1"}][-1], "5")
        for expected in ("4", "3", "2", "1"):
            self.now += 1
            room = self.poll(players[0])
            self.assertEqual(room["phase"], "lobby")
            self.assertIn(expected, [message["text"] for message in room["chat"]])
        self.now += 1
        room = self.poll(players[0])
        self.assertEqual(room["phase"], "playing")
        self.assertEqual(room["round"], 0)
        self.assertIsNotNone(room["task"]["choice_deadline"])

    def test_settings_require_full_valid_payload_and_respect_capacity(self):
        players, _ = self.lobby(count=5)
        host = players[0]
        settings = self.poll(host)["settings"]
        invalid = [{}, {"draw_seconds": 30}, dict(settings, unknown=True),
                   dict(settings, max_players=True), dict(settings, max_players=3),
                   dict(settings, max_players=17), dict(settings, draw_seconds=29),
                   dict(settings, draw_seconds=301), dict(settings, guess_seconds=14),
                   dict(settings, guess_seconds=121), dict(settings, library_id=True),
                   dict(settings, library_id=0), dict(settings, library_id=999999), []]
        for payload in invalid:
            with self.subTest(payload=payload):
                self.action(host, "settings", payload, expected=400)
                self.assertEqual(self.poll(host)["settings"], settings)
        self.action(host, "settings", dict(settings, max_players=4), expected=409)
        full = self.action(host, "settings", dict(settings, max_players=5, draw_seconds=300, guess_seconds=120))["room"]
        self.assertEqual(full["settings"]["max_players"], 5)
        self.api("POST", "/api/game/rooms/" + host["code"] + "/join",
                 {"name": "超额玩家", "avatar": 0}, expected=409)
        self.action(players[-1], "leave")
        replacement, joined = self.join(host, name="补位")
        self.assertGreater(replacement["id"], players[-1]["id"])
        self.assertEqual(len(joined["players"]), 5)

    def test_create_and_join_identity_validation_is_atomic(self):
        invalid = [{}, {"name": "", "avatar": 0}, {"name": "字" * 25, "avatar": 0},
                   {"name": 123, "avatar": 0}, {"name": "正常", "avatar": True},
                   {"name": "正常", "avatar": -1}, {"name": "正常", "avatar": 8},
                   {"name": "正常", "avatar": "0"}, {"name": "坏\x00昵称", "avatar": 0}]
        for payload in invalid + [{"name": "正常", "avatar": 0, "practice": 1},
                                  {"name": "正常", "avatar": 0, "settings": None}]:
            self.api("POST", "/api/game/rooms", payload, expected=400)
        with self.app.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM game_rooms").fetchone()[0], 0)
        host, room = self.create(name="  Ａ  玩家\t", avatar=7, settings={"max_players": 4})
        self.assertEqual(room["players"][0]["name"], "A 玩家")
        self.assertEqual(room["settings"]["max_players"], 4)
        for payload in invalid:
            self.api("POST", "/api/game/rooms/" + host["code"] + "/join", payload, expected=400)
        self.assertEqual(len(self.poll(host)["players"]), 1)

    def test_duplicate_submissions_are_idempotent_and_stale_retries_cannot_overwrite(self):
        players, _ = self.playing()
        host = players[0]
        payload = self.final_payload(self.poll(host))
        first = self.action(host, "submit", payload)["room"]
        duplicate = self.action(host, "submit", dict(payload, drawing=self.drawing(999)))["room"]
        self.assertEqual(duplicate["version"], first["version"])
        self.assertEqual(self.action(host, "draft", dict(payload, drawing=self.drawing(998)))["room"]["version"], first["version"])
        for player in players[1:]:
            self.action(player, "submit", self.final_payload(self.poll(player)))
        current = self.poll(host)
        self.assertEqual(current["round"], 1)
        self.action(host, "submit", payload, expected=409)
        self.action(host, "draft", payload, expected=409)
        self.assertEqual(self.poll(host)["version"], current["version"])
        state, _ = self.persisted(host["code"])
        with self.app.connect() as db:
            entry = self.app.game.hydrate(db, host["code"], state["chains"][0]["entries"][0])
        self.assertEqual(entry["drawing"], payload["drawing"])
        self.assertTrue(all(len(c["entries"]) == 1 for c in state["chains"]))

    def test_concurrent_duplicate_submissions_write_one_entry(self):
        players, _ = self.playing()
        host = players[0]
        before = self.poll(host)["version"]
        payload = self.final_payload(self.poll(host))
        workers = [self.new_worker() for _ in range(6)]
        barrier = threading.Barrier(6)
        def submit(index):
            barrier.wait(timeout=10)
            return self.request("POST", "/api/game/rooms/" + host["code"] + "/submit",
                                payload, token=host["token"], app=workers[index])
        with ThreadPoolExecutor(max_workers=6) as executor:
            responses = list(executor.map(submit, range(6)))
        self.assertEqual([r["status"] for r in responses], [200] * 6)
        room = self.poll(host)
        self.assertEqual(room["round"], 0)
        self.assertEqual(room["version"], before + 1)
        state, _ = self.persisted(host["code"])
        self.assertEqual([len(c["entries"]) for c in state["chains"]], [1, 0, 0, 0])

    def test_concurrent_last_players_advance_exactly_once_across_workers(self):
        players, _ = self.playing()
        workers = [self.new_worker(), self.new_worker()]
        for round_number in range(4):
            for player in players[:2]:
                self.action(player, "submit", self.final_payload(self.poll(player)))
            before = self.poll(players[0])["version"]
            payloads = [self.final_payload(self.poll(p)) for p in players[2:]]
            barrier = threading.Barrier(2)
            def submit(index):
                player = players[index + 2]
                barrier.wait(timeout=10)
                return self.request("POST", "/api/game/rooms/" + player["code"] + "/submit",
                                    payloads[index], token=player["token"], app=workers[index])
            with ThreadPoolExecutor(max_workers=2) as executor:
                responses = list(executor.map(submit, range(2)))
            self.assertEqual([r["status"] for r in responses], [200, 200])
            room = self.poll(players[0])
            self.assertEqual(room["version"], before + 2)
            self.assertEqual(room["phase"], "reveal" if round_number == 3 else "playing")
            self.assertEqual(room["round"], min(round_number + 1, 3))
            state, _ = self.persisted(players[0]["code"])
            for chain in state["chains"]:
                self.assertEqual(len(chain["entries"]), round_number + 1)
                self.assertEqual(len({e["player_id"] for e in chain["entries"]}), round_number + 1)

    def test_partial_drafts_merge_are_private_and_timeouts_keep_saved_work(self):
        players, started = self.playing(settings={"draw_seconds": 30, "guess_seconds": 15})
        host = players[0]
        choice = started["task"]["choices"][2]
        drawing = self.drawing(321)
        self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": drawing})
        saved = self.action(host, "draft", {"round": 0, "kind": "draw", "text": choice})["room"]
        self.assertEqual(saved["task"]["draft"], {"drawing": drawing, "text": choice})
        worker = self.new_worker()
        self.assertEqual(self.poll(host, app=worker)["task"]["draft"], saved["task"]["draft"])
        self.assertNotIn("draft", self.poll(players[1])["task"])
        self.now = started["deadline"] - 0.001
        with self.app.connect() as db:
            db.execute("UPDATE game_members SET last_seen=?", (self.now,))
        self.assertEqual(self.poll(host)["round"], 0)
        self.now += 0.001
        next_room = self.poll(players[1], app=worker)
        self.assertEqual(next_room["round"], 1)
        self.assertEqual(next_room["task"]["source"], {"drawing": drawing})
        self.assertNotIn("draft", next_room["task"])
        guessed = "保存的猜测"
        self.action(players[1], "draft", {"round": 1, "kind": "guess", "text": guessed})
        self.action(players[1], "draft", {"round": 1, "kind": "guess"})
        self.assertEqual(self.poll(players[1])["task"]["draft"], {"text": guessed})
        self.now = next_room["deadline"]
        round_two = self.poll(players[2])
        self.assertEqual(round_two["round"], 2)
        self.assertEqual(round_two["task"]["source"], {"text": guessed})
        self.now = started["deadline"] + 15 + 30 + 15
        final = self.poll(host)
        self.assertEqual(final["phase"], "reveal")
        chain = final["reveal"]["chains"][0]
        self.assertEqual(chain["prompt"], choice)
        self.assertEqual(chain["entries"][0]["drawing"], drawing)
        self.assertEqual(chain["entries"][1]["text"], guessed)
        self.assertEqual(chain["entries"][3]["text"], "（未猜出）")
        self.assertTrue(all(e["timed_out"] for c in final["reveal"]["chains"] for e in c["entries"]))

    def test_stale_mutation_at_deadline_commits_tick_despite_error(self):
        players, started = self.playing(settings={"draw_seconds": 30, "guess_seconds": 15})
        host = players[0]
        stale = self.final_payload(started)
        self.now = started["deadline"]
        self.action(host, "submit", stale, expected=409)
        # Inspect immediately, before a second request could incidentally re-tick.
        state, _ = self.persisted(host["code"])
        self.assertEqual(state["round"], 1)
        self.assertTrue(all(len(c["entries"]) == 1 for c in state["chains"]))
        self.assertEqual(state["version"], started["version"] + 1)
        with self.app.connect() as db:
            db.execute("UPDATE game_members SET last_seen=?", (self.now,))
        self.assertEqual(self.poll(host)["version"], state["version"])
        self.now = started["deadline"] + 60
        self.action(host, "draft", {"round": 1, "kind": "guess", "text": "太迟了"}, expected=409)
        state, _ = self.persisted(host["code"])
        self.assertEqual(state["phase"], "reveal")
        self.assertTrue(all(len(c["entries"]) == 4 for c in state["chains"]))

    def test_long_clock_jump_finishes_all_rounds_with_nonblank_fallback_guesses(self):
        players, room = self.playing(settings={"draw_seconds": 30, "guess_seconds": 15})
        self.now += 1000
        revealed = self.poll(players[0])
        self.assertEqual(revealed["phase"], "reveal")
        for chain in revealed["reveal"]["chains"]:
            self.assertTrue(chain["prompt"])
            self.assertEqual(len(chain["entries"]), 4)
            for entry in chain["entries"]:
                self.assertTrue(entry["timed_out"])
                if entry["kind"] == "draw":
                    self.assertEqual(entry["drawing"], {"strokes": []})
                else:
                    self.assertEqual(entry["text"], "（未猜出）")
        self.assertEqual(self.poll(players[0])["version"], revealed["version"])

    def test_submission_validation_and_no_blank_final_guess(self):
        players, room = self.playing()
        host = players[0]
        base = self.final_payload(room)
        invalid = [{}, dict(base, round=True), dict(base, round=-1), dict(base, round=16),
                   dict(base, round="0"), dict(base, round=1), dict(base, kind="guess"),
                   dict(base, text="不在候选词中"), dict(base, text=""),
                   {"round": 0, "kind": "draw", "drawing": self.drawing()},
                   {"round": 0, "kind": "draw", "text": base["text"]}]
        for payload in invalid:
            self.action(host, "submit", payload, expected=409 if payload.get("round") == 1 and type(payload.get("round")) is int else 400)
        self.assertEqual(self.poll(host)["version"], room["version"])
        self.action(host, "draft", {"round": 0, "kind": "draw", "text": ""})
        self.complete_round(players)
        guess_room = self.poll(host)
        for text in [None, "", "  \t", "字" * 101, True, []]:
            self.action(host, "submit", {"round": 1, "kind": "guess", "text": text}, expected=400)
        self.action(host, "submit", {"round": 1, "kind": "guess"}, expected=400)
        self.action(host, "submit", {"round": 1, "kind": "guess", "text": "有效", "drawing": self.drawing()}, expected=400)
        self.action(host, "draft", {"round": 1, "kind": "guess", "text": ""})
        self.assertFalse(next(p for p in self.poll(host)["players"] if p["id"] == host["id"])["submitted"])
        self.complete_round(players)
        self.action(host, "draft", {"round": 2, "kind": "draw", "text": "偷偷改词"}, expected=400)
        self.assertEqual(self.poll(host)["task"]["kind"], "draw")

    def test_selected_library_snapshot_survives_word_deletion_and_addition(self):
        owner = "x" * 32
        library = self.api("POST", "/api/libraries", {"name": "快照题库"}, expected=201)["library"]
        path = "/api/libraries/{}/words".format(library["id"])
        self.api("POST", path, {"words": ["旧词一", "旧词二", "旧词三"], "owner": owner})
        players, _ = self.playing(settings={"library_id": library["id"]})
        choices = [self.poll(p)["task"]["choices"] for p in players]
        for offered in choices:
            self.assertEqual(set(offered), {"旧词一", "旧词二", "旧词三"})
        words = self.api("GET", path)["words"]
        for word in words:
            self.api("DELETE", path + "/" + str(word["id"]), {"owner": owner})
        self.api("POST", path, {"words": ["新词一", "新词二", "新词三"]})
        for index, player in enumerate(players):
            self.assertEqual(self.poll(player)["task"]["choices"], choices[index])
            self.action(player, "submit", self.final_payload(self.poll(player)))
        for _ in range(3):
            final = self.complete_round(players)
        self.assertTrue(all(c["prompt"] in {"旧词一", "旧词二", "旧词三"} for c in final["reveal"]["chains"]))
        self.action(players[0], "replay")
        for player in players[1:]:
            self.action(player, "ready", {"ready": True})
        restarted = self.action(players[0], "start")["room"]
        self.assertEqual(set(restarted["task"]["choices"]), {"新词一", "新词二", "新词三"})

    def test_empty_library_rejected_and_start_rechecks_current_words(self):
        library = self.api("POST", "/api/libraries", {"name": "空题库"}, expected=201)["library"]
        host, _ = self.create()
        settings = dict(self.poll(host)["settings"], library_id=library["id"])
        self.action(host, "settings", settings, expected=400)
        self.api("POST", "/api/game/rooms", {"name": "房主", "avatar": 0, "settings": {"library_id": library["id"]}}, expected=400)
        owner = "y" * 32
        path = "/api/libraries/{}/words".format(library["id"])
        self.api("POST", path, {"words": ["仅一个词"], "owner": owner})
        self.action(host, "settings", settings)
        others = [self.join(host, name="玩家" + str(i))[0] for i in range(3)]
        for player in others:
            self.action(player, "ready", {"ready": True})
        word_id = self.api("GET", path)["words"][0]["id"]
        self.api("DELETE", path + "/" + str(word_id), {"owner": owner})
        self.action(host, "start", expected=400)
        self.assertEqual(self.poll(host)["phase"], "lobby")
        self.api("POST", path, {"words": ["新独词"]})
        started = self.action(host, "start")["room"]
        self.assertEqual(started["task"]["choices"], ["新独词"] * 3)

    def test_drawing_validation_rejects_shapes_tools_colors_booleans_and_nonfinite(self):
        players, _ = self.playing()
        host = players[0]
        stroke = self.drawing()["strokes"][0]
        invalid = [None, [], {}, {"strokes": [] , "extra": True}, {"strokes": {}},
                   {"strokes": [None]}, {"strokes": [dict(stroke, extra=1)]},
                   {"strokes": [{"tool": "pen"}]}]
        for field, values in {
            "tool": [None, [], "line", "Pen", True],
            "color": [None, [], "red", "#fff", "#gggggg", "#1234567", "#123456\n"],
            "size": [True, False, None, "2", 0, 65, -1, float("nan"), float("inf"), -float("inf")],
            "points": [None, [], [[1]], [[1, 2, 3]], [[True, 2]], [[1, False]],
                       [[-1, 0]], [[961, 0]], [[0, -1]], [[0, 641]], [["1", 2]],
                       [[float("nan"), 2]], [[1, float("inf")]], [[-float("inf"), 1]]],
        }.items():
            invalid.extend({"strokes": [dict(stroke, **{field: value})]} for value in values)
        invalid.append({"strokes": [dict(stroke, tool="fill", points=[[1, 2], [3, 4]])]})
        before = self.poll(host)["version"]
        for index, drawing in enumerate(invalid):
            with self.subTest(case=index):
                self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": drawing}, expected=400)
        room = self.poll(host)
        self.assertEqual(room["version"], before)
        self.assertNotIn("draft", room["task"])

    def test_choice_locks_after_selection_and_auto_selects_at_deadline(self):
        players, _ = self.playing()
        host = players[0]
        room = self.poll(host)
        choices = room["task"]["choices"]
        self.assertEqual(room["task"]["choice"], "")
        self.assertIsNotNone(room["task"]["choice_deadline"])
        chosen = self.action(host, "choose", {"word": choices[1]})["room"]["task"]
        self.assertEqual(chosen["choice"], choices[1])
        self.action(host, "choose", {"word": choices[0]}, expected=409)
        payload = self.final_payload(self.poll(host))
        payload["text"] = choices[0]
        self.action(host, "submit", payload, expected=409)
        payload["text"] = choices[1]
        self.action(host, "submit", payload)
        other = self.poll(players[1])
        self.now = other["task"]["choice_deadline"] + 0.1
        self.heartbeat_except(players, {"id": -1})
        auto = self.poll(players[1])
        self.assertIn(auto["task"]["choice"], auto["task"]["choices"])
        self.assertIsNone(auto["task"]["choice_deadline"])

    def test_opacity_and_gradient_are_validated_and_preserved(self):
        players, _ = self.playing()
        host = players[0]
        stroke = {"tool": "pen", "color": "#123456", "size": 8, "points": [[1, 2], [3, 4]],
                  "opacity": 55, "gradient": ["#FF0000", "#00FF00"]}
        draft = self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": [stroke]}})["room"]["task"]["draft"]["drawing"]["strokes"][0]
        self.assertEqual(draft["opacity"], 55)
        self.assertEqual(draft["gradient"], ["#ff0000", "#00ff00"])
        for field, value in [("opacity", 0), ("opacity", 101), ("opacity", True), ("opacity", None), ("opacity", "50"),
                             ("gradient", ["#ff0000"]), ("gradient", ["#ff0000", "red"]),
                             ("gradient", ["#ff0000", "#00ff00", "#0000ff"]), ("gradient", None)]:
            with self.subTest(field=field, value=value):
                self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": [dict(stroke, **{field: value})]}}, expected=400)
        bad = dict(stroke, tool="eraser", points=[[1, 2]])
        self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": [bad]}}, expected=400)
        fill = {"tool": "fill", "color": "#123456", "size": 6, "points": [[1, 2]],
                "gradient": ["#FF0000", "#00FF00"], "angle": 45}
        saved_fill = self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": [fill]}})["room"]["task"]["draft"]["drawing"]["strokes"][0]
        self.assertEqual(saved_fill["gradient"], ["#ff0000", "#00ff00"])
        self.assertEqual(saved_fill["angle"], 45)
        for field, value in [("angle", -1), ("angle", 361), ("angle", True)]:
            self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": [dict(fill, **{field: value})]}}, expected=400)
        angled_pen = dict(stroke, angle=45)
        self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": [angled_pen]}}, expected=400)

    def test_drawing_normalizes_colors_eraser_and_accepts_fill_and_boundary_points(self):
        players, _ = self.playing()
        host = players[0]
        drawing = {"strokes": [
            {"tool": "pen", "color": "#ABCDEF", "size": 1, "points": [[0, 0], [960, 640]]},
            {"tool": "eraser", "color": "#123456", "size": 64, "points": [[10.5, 20.5]]},
            {"tool": "fill", "color": "#FE12AB", "size": 3.5, "points": [[960, 0]]},
        ]}
        expected = deepcopy(drawing)
        expected["strokes"][0]["color"] = "#abcdef"
        expected["strokes"][1]["color"] = "#ffffff"
        expected["strokes"][2]["color"] = "#fe12ab"
        result = self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": drawing})["room"]
        self.assertEqual(result["task"]["draft"]["drawing"], expected)
        self.assertEqual(drawing["strokes"][1]["color"], "#123456")
        empty = self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": []}})["room"]
        self.assertEqual(empty["task"]["draft"]["drawing"], {"strokes": []})

    def test_brush_and_layer_are_validated_and_preserved(self):
        players, _ = self.playing()
        host = players[0]
        stroke = {"tool": "pen", "color": "#123456", "size": 8, "points": [[1, 2], [3, 4]],
                  "brush": "marker", "layer": 2, "pressures": [0.4, 0.8]}
        draft = self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": [stroke]}})["room"]["task"]["draft"]["drawing"]["strokes"][0]
        self.assertEqual((draft["brush"], draft["layer"], draft["pressures"]), ("marker", 2, [0.4, 0.8]))
        for field, value in [("brush", "airbrush"), ("brush", "Pen"), ("brush", None),
                             ("layer", -1), ("layer", 3), ("layer", True), ("layer", "1")]:
            with self.subTest(field=field, value=value):
                self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": [dict(stroke, **{field: value})]}}, expected=400)
        no_layer = dict(stroke); no_layer.pop("layer"); no_layer.pop("brush")
        saved = self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": [no_layer]}})["room"]["task"]["draft"]["drawing"]["strokes"][0]
        self.assertNotIn("brush", saved); self.assertNotIn("layer", saved)

    def test_drawing_pressure_is_validated_and_preserved(self):
        players, _ = self.playing()
        host = players[0]
        stroke = {"tool": "pen", "color": "#123456", "size": 8,
                  "points": [[10, 10], [20, 30]], "pressures": [0.2, 1]}
        saved = self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": [stroke]}})["room"]
        self.assertEqual(saved["task"]["draft"]["drawing"]["strokes"][0]["pressures"], [0.2, 1])
        invalid = [
            dict(stroke, pressures=[0.2]),
            dict(stroke, pressures=[0.2, True]),
            dict(stroke, pressures=[-0.1, 1]),
            dict(stroke, pressures=[0, 1.1]),
            dict(stroke, pressures=[float("nan"), 1]),
            dict(stroke, tool="fill", points=[[10, 10]], pressures=[0.5]),
        ]
        for drawing in invalid:
            with self.subTest(pressures=drawing.get("pressures")):
                self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": [drawing]}}, expected=400)

    def test_drawing_stroke_point_and_serialized_byte_limits(self):
        players, _ = self.playing()
        host = players[0]
        stroke = {"tool": "pen", "color": "#123456", "size": 1, "points": [[0, 0]]}
        self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": [stroke] * MAX_STROKES}})
        self.action(host, "draft", {"round": 0, "kind": "draw", "drawing": {"strokes": [stroke] * (MAX_STROKES + 1)}}, expected=400)
        # Compact JSON stays below the transport limit, exercising the actual point cap.
        points = dict(stroke, points=[[0, 0]] * MAX_POINTS)
        raw = json.dumps({"round": 0, "kind": "draw", "drawing": {"strokes": [points]}}, separators=(",", ":")).encode()
        self.assertLess(len(raw), MAX_BODY)
        self.api("POST", "/api/game/rooms/" + host["code"] + "/draft", token=host["token"], raw=raw,
                 headers={"Content-Type": "application/json"})
        points["points"].append([0, 0])
        raw = json.dumps({"round": 0, "kind": "draw", "drawing": {"strokes": [points]}}, separators=(",", ":")).encode()
        self.api("POST", "/api/game/rooms/" + host["code"] + "/draft", token=host["token"], raw=raw,
                 headers={"Content-Type": "application/json"}, expected=400)
        # The drawing has a safety margin independent of the enclosing body limit.
        big = dict(stroke, points=[[123.123456, 456.123456]] * 43650)
        raw = json.dumps({"round": 0, "kind": "draw", "drawing": {"strokes": [big]}}, separators=(",", ":")).encode()
        self.assertGreater(len(raw), MAX_BODY - 1024)
        self.assertLessEqual(len(raw), MAX_BODY)
        self.api("POST", "/api/game/rooms/" + host["code"] + "/draft", token=host["token"], raw=raw,
                 headers={"Content-Type": "application/json"}, expected=413)

    def test_wsgi_body_limit_json_content_type_and_recursive_input(self):
        host, _ = self.create()
        path = "/api/game/rooms/" + host["code"] + "/chat"
        for raw, headers, expected in [
            (b'{"text":"hello"}', {}, 415),
            (b'{"text":"hello"}', {"Content-Type": "text/plain"}, 415),
            (b'{"text":', {"Content-Type": "application/json"}, 400),
            (b"\xff", {"Content-Type": "application/json"}, 400),
            (b"[]", {"Content-Type": "application/json"}, 400),
            (b'{}', {"Content-Type": "application/json", "Content-Length": "bad"}, 400),
            (b'{}', {"Content-Type": "application/json", "Content-Length": "-1"}, 413),
            (b'{}', {"Content-Type": "application/json", "Content-Length": str(MAX_BODY + 1)}, 413),
            (b'{"nested":' + b"[" * 1500 + b"0" + b"]" * 1500 + b"}", {"Content-Type": "application/json"}, 400),
        ]:
            self.api("POST", path, raw=raw, headers=headers, token=host["token"], expected=expected)
        self.api("POST", path, {"text": "字" * (MAX_BODY // 3 + 1)}, token=host["token"], expected=413)
        self.assertFalse(any(not m["system"] for m in self.poll(host)["chat"]))
        accepted = self.action(host, "chat", {"text": "合法内容"}, headers={"Content-Type": "application/json; charset=utf-8"})
        self.assertEqual(accepted["room"]["chat"][-1]["text"], "合法内容")

    def test_chat_preserves_untrusted_names_as_data_and_ignores_spoofed_author(self):
        host, _ = self.create(name="<b>房主</b>")
        player, _ = self.join(host, name="<svg/onload=alert(1)>")
        text = "<img src=x onerror=alert(1)> '); DROP TABLE game_rooms;--"
        room = self.action(player, "chat", {"text": text, "name": "系统", "system": True, "id": 999})["room"]
        message = room["chat"][-1]
        self.assertEqual(message["name"], "<svg/onload=alert(1)>")
        self.assertEqual(message["text"], text)
        self.assertFalse(message["system"])
        self.assertNotEqual(message["id"], 999)
        self.assertEqual(self.poll(host)["players"][0]["name"], "<b>房主</b>")
        for invalid in [None, "", "  ", "字" * 301, 1, [], "含\x00字符"]:
            self.action(player, "chat", {"text": invalid}, expected=400)
        self.assertEqual(self.poll(host)["chat"][-1], message)

    def test_chat_history_is_bounded_ids_monotonic_and_online_heartbeat_persists(self):
        host, _ = self.create()
        player, _ = self.join(host)
        for i in range(85):
            self.action(host, "chat", {"text": "消息" + str(i)})
        room = self.poll(host)
        self.assertEqual(len(room["chat"]), 80)
        self.assertEqual([m["id"] for m in room["chat"]], list(range(7, 87)))
        self.assertEqual(room["chat"][0]["text"], "消息5")
        self.now += 46
        room = self.poll(host)
        self.assertTrue(room["players"][0]["online"])
        self.assertFalse(room["players"][1]["online"])
        version = room["version"]
        self.poll(player, app=self.new_worker())
        room = self.poll(host)
        self.assertTrue(all(p["online"] for p in room["players"]))
        self.assertEqual(room["version"], version)
        _, expiration = self.persisted(host["code"])
        self.assertEqual(expiration, self.now + ROOM_TTL)

    def test_reveal_is_automatic_and_votes_replace_without_host_controls(self):
        players, room = self.revealed()
        host, guest = players[:2]
        reveal = room["reveal"]
        self.assertEqual((reveal["stage"], reveal["chain"], reveal["step"]), ("lineup", 0, 0))
        # Playback progress is server-driven; clients cannot seek or switch stages.
        for payload in [{"step": 1}, {"stage": "favorite"}, {}]:
            self.action(guest, "reveal", payload, expected=400)
        self.action(guest, "reveal", {"chain": 1}, expected=409)
        self.action(guest, "reveal", {"vote": "same", "chain": 0}, expected=409)
        matched = self.reveal_stage(host, "match")
        self.assertEqual(matched["chain"], 0)
        self.action(guest, "reveal", {"vote": "same", "chain": 0})
        vote = self.action(guest, "reveal", {"vote": "changed", "chain": 0})["room"]["reveal"]
        self.assertEqual(vote["chains"][0]["my_vote"], "changed")
        self.assertEqual(vote["chains"][0]["votes"], {"same": 0, "changed": 1})
        self.action(host, "reveal", {"vote": "same", "chain": 0})
        self.action(players[2], "reveal", {"vote": "same", "chain": 0})
        last = self.action(players[3], "reveal", {"vote": "same", "chain": 0})["room"]["reveal"]
        self.assertEqual(last["stage"], "match_result")
        self.assertEqual(last["chains"][0]["votes"], {"same": 3, "changed": 1})
        self.assertTrue(last["chains"][0]["success"])
        self.now = last["deadline"] + 0.05
        self.assertEqual(self.poll(host)["reveal"]["stage"], "favorite")
        # Only the current chain owner may award, and only after the vote stage.
        self.action(guest, "reveal", {"vote": "favorite", "chain": 0, "artist": players[2]["id"]}, expected=403)
        self.action(host, "reveal", {"vote": "favorite", "chain": 0, "artist": host["id"]}, expected=400)
        self.action(host, "reveal", {"vote": "favorite", "chain": 0, "artist": guest["id"]}, expected=400)
        self.action(host, "reveal", {"vote": "favorite", "chain": 0}, expected=400)
        self.action(guest, "replay", expected=403)
        replayed = self.action(host, "replay")["room"]
        self.assertEqual(replayed["phase"], "lobby")
        self.assertEqual((replayed["round"], replayed["total_rounds"]), (0, 0))
        self.assertIsNone(replayed["task"])
        self.assertIsNone(replayed["reveal"])
        self.assertIsNone(replayed["deadline"])
        self.assertFalse(any(p["ready"] for p in replayed["players"]))
        state, _ = self.persisted(host["code"])
        self.assertEqual((state["seats"], state["chains"], state["drafts"]), ([], [], {}))
        for player in players[1:]:
            self.action(player, "ready", {"ready": True})
        self.assertEqual(self.action(host, "start")["room"]["round"], 0)

    def test_match_success_and_owner_best_artwork_scores(self):
        players, room = self.revealed()
        host, second, third, fourth = players
        self.settle_chain(players, 0, ["same", "same", "same", "same"])
        reveal = self.reveal_stage(host, "replay")
        self.assertEqual(reveal["chain"], 1)
        self.assertEqual(reveal["stage"], "replay")
        self.assertIsNotNone(reveal["chains"][0]["award"])
        self.assertTrue(reveal["chains"][0]["success"])
        self.assertEqual(reveal["scores"][str(reveal["chains"][0]["owner_id"])], 1)
        self.assertEqual(reveal["scores"][str(reveal["chains"][0]["award"])], 1)
        self.settle_chain(players, 1, ["same", "changed", "changed", "changed"])
        self.skip_chain(players, 2)
        self.skip_chain(players, 3)
        scored = self.reveal_stage(host, "scores")
        self.assertEqual(scored["stage"], "scores")
        self.assertTrue(scored["chains"][0]["success"])
        self.assertFalse(scored["chains"][1]["success"])
        self.assertFalse(scored["chains"][2]["success"])
        self.assertIsNotNone(scored["chains"][1]["award"])
        # The score table is only exposed once every chain has been replayed.
        self.assertEqual(scored["scores"][str(scored["chains"][0]["owner_id"])], 1)
        self.assertEqual(scored["scores"][str(scored["chains"][0]["award"])], 1)

    def test_lobby_leave_revokes_token_and_migrates_host(self):
        players, _ = self.lobby()
        host, next_host = players[:2]
        left = self.action(host, "leave")["room"]
        self.assertEqual(left["host_id"], next_host["id"])
        self.assertNotIn(host["id"], [p["id"] for p in left["players"]])
        self.assertEqual(len(left["players"]), 3)
        self.poll(host, expected=401)
        self.action(host, "chat", {"text": "撤销后不能发言"}, expected=401)
        self.assertTrue(self.poll(next_host)["me"]["host"])
        self.action(next_host, "settings", dict(left["settings"], max_players=4))
        self.action(players[2], "settings", dict(left["settings"]), expected=403)
        replacement, _ = self.join(next_host, name="重新加入")
        self.assertNotEqual(replacement["token"], host["token"])
        self.assertGreater(replacement["id"], players[-1]["id"])

    def test_midgame_host_leave_autofills_each_assignment_preserves_draft_and_replay_prunes(self):
        players, started = self.playing()
        host, next_host = players[:2]
        drawing = self.drawing(765)
        self.action(host, "draft", {"round": 0, "kind": "draw", "text": started["task"]["choices"][0], "drawing": drawing})
        left = self.action(host, "leave")["room"]
        self.assertEqual(left["host_id"], next_host["id"])
        departed = next(p for p in left["players"] if p["id"] == host["id"])
        self.assertFalse(departed["online"])
        self.assertTrue(departed["submitted"])
        self.poll(host, expected=401, app=self.new_worker())
        self.action(host, "submit", self.final_payload(started), expected=401)
        for _ in range(4):
            for player in players[1:]:
                self.action(player, "submit", self.final_payload(self.poll(player)))
        revealed = self.poll(next_host)
        self.assertEqual(revealed["phase"], "reveal")
        self.assertEqual(revealed["reveal"]["chains"][0]["entries"][0]["drawing"], drawing)
        departed_entries = [e for c in revealed["reveal"]["chains"] for e in c["entries"] if e["player_id"] == host["id"]]
        self.assertEqual(len(departed_entries), 4)
        self.assertTrue(all(e["timed_out"] for e in departed_entries))
        self.assertEqual(sum(e["kind"] == "skip" for e in departed_entries), 3)
        self.assertTrue(all("有效内容" in e["text"] for e in departed_entries if e["kind"] == "skip"))
        self.assertEqual(revealed["reveal"]["stage"], "lineup")
        replayed = self.action(next_host, "replay")["room"]
        self.assertEqual(len(replayed["players"]), 3)
        self.assertNotIn(host["id"], [p["id"] for p in replayed["players"]])

    def test_practice_bots_submit_only_after_three_seconds_each_round(self):
        host, lobby = self.create(practice=True, settings={"max_players": 4, "draw_seconds": 30, "guess_seconds": 15})
        self.assertEqual(len(lobby["players"]), 4)
        self.assertEqual(sum(p["is_bot"] for p in lobby["players"]), 3)
        self.assertTrue(all(p["ready"] and p["online"] for p in lobby["players"] if p["is_bot"]))
        self.assertTrue(any("演示玩家" in m["text"] for m in lobby["chat"]))
        with self.app.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM game_members").fetchone()[0], 1)
        room = self.action(host, "start")["room"]
        for round_number in range(4):
            self.assertEqual(room["round"], round_number)
            started_at = self.now
            self.now = started_at + 2.999
            pending = self.poll(host)
            self.assertFalse(any(p["submitted"] for p in pending["players"]))
            self.now = started_at + 3
            bots_done = self.poll(host, app=self.new_worker())
            self.assertEqual(bots_done["round"], round_number)
            self.assertEqual(sum(p["submitted"] for p in bots_done["players"] if p["is_bot"]), 3)
            self.assertFalse(bots_done["players"][0]["submitted"])
            room = self.action(host, "submit", self.final_payload(bots_done))["room"]
        self.assertEqual(room["phase"], "reveal")
        bot_entries = [e for c in room["reveal"]["chains"] for e in c["entries"] if e["player_id"] != host["id"]]
        self.assertEqual(len(bot_entries), 12)
        self.assertTrue(all(not e["timed_out"] for e in bot_entries))
        self.assertTrue(all(e["drawing"]["strokes"] for e in bot_entries if e["kind"] == "draw"))
        self.assertTrue(all(e["text"] not in ("", "（未猜出）") for e in bot_entries if e["kind"] == "guess"))
        replayed = self.action(host, "replay")["room"]
        self.assertTrue(all(p["ready"] == p["is_bot"] for p in replayed["players"]))

    def test_practice_reveal_auto_advances_with_bot_votes_and_awards(self):
        host, _ = self.create(practice=True, settings={"max_players": 4, "draw_seconds": 30, "guess_seconds": 15})
        room = self.action(host, "start")["room"]
        for _ in range(4):
            self.now += 4
            room = self.poll(host)
            room = self.action(host, "submit", self.final_payload(room))["room"]
        self.assertEqual(room["phase"], "reveal")
        stages = []
        for _ in range(300):
            reveal = self.poll(host)["reveal"]
            if not stages or stages[-1] != reveal["stage"]:
                stages.append(reveal["stage"])
            if reveal["stage"] == "scores":
                break
            if reveal["stage"] == "favorite":
                chain = reveal["chains"][reveal["chain"]]
                if not chain["award"] and chain["owner_id"] == host["id"]:
                    artist = next(entry["player_id"] for entry in chain["entries"]
                                  if entry["kind"] == "draw" and entry["player_id"] != host["id"])
                    self.action(host, "reveal", {"vote": "favorite", "chain": reveal["chain"], "artist": artist})
            self.now = (reveal.get("deadline") or self.now) + 0.05
        self.assertEqual(reveal["stage"], "scores")
        self.assertEqual(stages[:4], ["lineup", "replay", "match", "match_result"])
        self.assertEqual(stages[-1], "scores")
        for chain in reveal["chains"]:
            self.assertGreaterEqual(chain["votes"]["same"] + chain["votes"]["changed"], 3)
            if chain["owner_id"] != host["id"]:
                self.assertIsNotNone(chain["award"])

    def test_last_human_leave_stops_bots_finishes_game_and_shortens_expiry(self):
        host, _ = self.create(practice=True)
        self.action(host, "start")
        left = self.action(host, "leave")["room"]
        self.assertIsNone(left["host_id"])
        self.assertEqual(left["phase"], "reveal")
        self.assertFalse(any(p["online"] for p in left["players"]))
        self.assertTrue(all(e["timed_out"] for c in left["reveal"]["chains"] for e in c["entries"]))
        state, expires = self.persisted(host["code"])
        self.assertFalse(any(p["active"] for p in state["players"]))
        self.assertEqual(expires, self.now + EMPTY_TTL)
        self.poll(host, expected=401)

    def test_expiration_cleanup_cascades_credentials_and_empty_lobby_can_reopen(self):
        host, _ = self.create()
        self.now += ROOM_TTL - 1
        # An unauthenticated join sees expiry, without relying on expired auth's status.
        self.now += 1
        self.api("POST", "/api/game/rooms/" + host["code"] + "/join",
                 {"name": "迟到", "avatar": 0}, expected=404)
        self.create(name="触发清理")
        self.assertIsNone(self.persisted(host["code"]))
        with self.app.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM game_members WHERE room_code=?", (host["code"],)).fetchone()[0], 0)
        self.poll(host, expected=401)
        empty_host, _ = self.create(name="空房间")
        self.action(empty_host, "leave")
        state, expires = self.persisted(empty_host["code"])
        self.assertEqual(state["players"], [])
        self.assertEqual(expires, self.now + EMPTY_TTL)
        newcomer, room = self.join(empty_host, name="新房主")
        self.assertEqual(room["host_id"], newcomer["id"])
        self.assertTrue(room["me"]["host"])
        self.assertEqual(self.persisted(empty_host["code"])[1], self.now + ROOM_TTL)
        self.action(newcomer, "leave")
        self.now += EMPTY_TTL
        self.create(name="清理空房间")
        self.assertIsNone(self.persisted(empty_host["code"]))

    def test_methods_routes_head_security_headers_and_same_origin_enforcement(self):
        host, _ = self.create()
        path = "/api/game/rooms/" + host["code"]
        for method, target, payload, expected in [
            ("GET", "/api/game/rooms", None, 405), ("POST", path, {}, 405),
            ("GET", path + "/join", None, 405), ("PUT", path, {}, 405),
            ("DELETE", path, {}, 405), ("HEAD", path + "/ready", None, 405),
            ("POST", path + "/unknown", {}, 404), ("GET", "/api/game/rooms/INVALID", None, 404),
        ]:
            response = self.request(method, target, payload, token=host["token"])
            self.assertEqual(response["status"], expected, response["body"])
        get = self.request("GET", path, token=host["token"])
        head = self.request("HEAD", path, token=host["token"])
        self.assertEqual(head["status"], 200)
        self.assertEqual(head["body"], b"")
        self.assertEqual(head["headers"]["content-length"], get["headers"]["content-length"])
        self.assertEqual(head["headers"]["x-content-type-options"], "nosniff")
        self.assertEqual(head["headers"]["x-frame-options"], "DENY")
        self.assertIn("script-src 'self'", head["headers"]["content-security-policy"])
        for headers in [{"Origin": "https://evil.example"}, {"Origin": "http://localhost:8081"},
                        {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}]:
            self.action(host, "chat", {"text": "不应保存"}, headers=headers, expected=403)
            self.api("POST", "/api/game/rooms", {"name": "拒绝创建", "avatar": 0}, headers=headers, expected=403)
            self.api("POST", path + "/join", {"name": "拒绝加入", "avatar": 0}, headers=headers, expected=403)
        self.action(host, "chat", {"text": "同源通过"}, headers={"Origin": "http://localhost:8080", "Sec-Fetch-Site": "same-origin"})
        for target in ["/game.py", "/game.sqlite3", "/static/../game.py"]:
            response = self.request("GET", target)
            self.assertEqual(response["status"], 404)
            self.assertNotIn(b"SQLite format 3", response["body"])

    def test_room_and_chat_rate_limits_persist_across_workers_ignore_forwarded_ip(self):
        hosts = [self.create(name="房间" + str(i))[0] for i in range(8)]
        worker = self.new_worker()
        response = self.request("POST", "/api/game/rooms", {"name": "超限", "avatar": 0},
                                app=worker, headers={"X-Forwarded-For": "203.0.113.1"})
        self.assertEqual(response["status"], 429)
        self.assertEqual(response["headers"]["retry-after"], "60")
        host = hosts[0]
        for i in range(120):
            self.action(host, "chat", {"text": "消息" + str(i)}, app=worker if i % 2 else self.app)
        self.action(host, "chat", {"text": "超限"}, expected=429, headers={"X-Forwarded-For": "203.0.113.2"})
        self.assertEqual(self.poll(host)["chat"][-1]["text"], "消息119")
        self.now = (int(self.now) // 60 + 1) * 60
        self.create(name="下一分钟", app=worker)
        self.action(host, "chat", {"text": "恢复"}, app=worker)
        self.assertEqual(self.poll(host)["chat"][-1]["text"], "恢复")

    def heartbeat_except(self, players, missing):
        with self.app.connect() as db:
            for player in players:
                if player["id"] != missing["id"]:
                    db.execute("UPDATE game_members SET last_seen=? WHERE room_code=? AND player_id=?",
                               (self.now, player["code"], player["id"]))

    def test_disconnect_pauses_everyone_and_reconnect_preserves_task_and_time(self):
        players, start = self.playing()
        missing = players[2]
        task = self.poll(missing)["task"]
        self.action(missing, "draft", self.final_payload(self.poll(missing)))
        self.now += 13
        self.heartbeat_except(players, missing)
        room = self.poll(players[0])
        self.assertEqual(room["pause"]["players"], [missing["id"]])
        self.assertEqual(room["pause"]["until"], self.now + 40)
        self.assertEqual(self.poll(players[1])["pause"], room["pause"])
        self.action(players[1], "submit", self.final_payload(self.poll(players[1])), expected=409)
        self.now += 5
        self.heartbeat_except(players, missing)
        restored = self.poll(missing, app=self.new_worker())
        self.assertIsNone(restored["pause"])
        self.assertEqual(restored["deadline"], start["deadline"] + 5)
        self.assertEqual(restored["task"]["source"], task["source"])
        self.assertIn("draft", restored["task"])
        self.assertEqual(restored["me"]["id"], missing["id"])

    def test_host_extend_cancel_and_offline_seat_does_not_break_parallel_chains(self):
        players, start = self.playing()
        missing = players[1]
        original = {p["id"]: self.poll(p) for p in players}
        host_drawing = self.final_payload(original[players[0]["id"]])
        self.action(players[0], "submit", host_drawing)
        self.now += 13
        self.heartbeat_except(players, missing)
        pause = self.poll(players[0])["pause"]
        self.action(players[2], "pause", {"seconds": 40}, expected=403)
        extended = self.action(players[0], "pause", {"seconds": 40})["room"]["pause"]
        self.assertEqual(extended["until"], pause["until"] + 40)
        self.action(players[0], "pause", {"seconds": 121}, expected=400)
        resumed = self.action(players[0], "pause", {"cancel": True})["room"]
        self.assertIsNone(resumed["pause"])
        self.assertTrue(next(p for p in resumed["players"] if p["id"] == missing["id"])["away"])
        for player in players[2:]:
            self.action(player, "submit", self.final_payload(self.poll(player)))
        # The missing owner's original prompt still exists; next player draws it.
        next_player = self.poll(players[2])
        self.assertEqual(next_player["round"], 1)
        self.assertEqual(next_player["task"]["kind"], "draw")
        self.assertEqual(next_player["task"]["source"]["text"], original[missing["id"]]["task"]["choices"][0])
        # Host chain skipped the missing guesser; the next online player must guess the SAME drawing.
        for player in (players[0], players[2], players[3]):
            self.action(player, "submit", self.final_payload(self.poll(player)))
        resumed_chain = self.poll(players[2])
        self.assertEqual(resumed_chain["task"]["kind"], "guess")
        self.assertEqual(resumed_chain["task"]["source"]["drawing"], host_drawing["drawing"])
        for _ in range(2):
            for player in (players[0], players[2], players[3]):
                self.action(player, "submit", self.final_payload(self.poll(player)))
        reveal = self.poll(players[0])["reveal"]
        for chain in reveal["chains"]:
            self.assertEqual(sum(e["kind"] == "skip" for e in chain["entries"]), 1)
            valid = [e for e in chain["entries"] if e["kind"] != "skip"]
            self.assertEqual([e["kind"] for e in valid], ["draw", "guess", "draw"])
            self.assertTrue(all(e.get("text") != "（未猜出）" for e in valid))
            self.assertTrue(all(e["drawing"]["strokes"] for e in valid if e["kind"] == "draw"))

    def test_pause_expires_then_reconnected_seat_can_join_next_valid_assignment(self):
        players, _ = self.playing()
        missing = players[3]
        self.now += 13
        self.heartbeat_except(players, missing)
        pause = self.poll(players[0])["pause"]
        self.now = pause["until"]
        self.heartbeat_except(players, missing)
        room = self.poll(players[0])
        self.assertIsNone(room["pause"])
        self.assertTrue(room["players"][3]["submitted"])
        restored = self.poll(missing)
        self.assertFalse(restored["players"][3]["away"])
        for player in players[:3]:
            self.action(player, "submit", self.final_payload(self.poll(player)))
        room = self.poll(missing)
        self.assertEqual(room["round"], 1)
        self.assertFalse(room["players"][3]["submitted"])
        self.action(missing, "submit", self.final_payload(room))

    def test_conditional_poll_is_small_and_old_game_submission_cannot_cross_replay(self):
        players, room = self.playing()
        host = players[0]
        result = self.api("GET", "/api/game/rooms/" + host["code"] + "?since_version=" + str(room["version"]), token=host["token"])
        self.assertTrue(result["unchanged"])
        self.assertNotIn("task", result["room"])
        self.assertNotIn("reveal", result["room"])
        payload = dict(self.final_payload(room), game_id=room["game_id"])
        for _ in range(4):
            self.complete_round(players)
        self.action(host, "replay")
        for player in players[1:]:
            self.action(player, "ready", {"ready": True})
        next_game = self.action(host, "start")["room"]
        self.assertGreater(next_game["game_id"], room["game_id"])
        self.action(host, "submit", payload, expected=409)


if __name__ == "__main__":
    unittest.main()
