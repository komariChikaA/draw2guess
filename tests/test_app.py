"""Integration tests for the public word-library WSGI API.

Run with ``python -m unittest discover -s tests -v`` from the project root.
Every test uses a real temporary SQLite database; no HTTP server is required.
"""

import io
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import quote, urlsplit

from app import create_app


class WordLibraryApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.db_path = str(Path(self.temp_dir.name) / "words.sqlite3")
        self.app = create_app(self.db_path, seed=False)

    def request(self, method, target, payload=None, headers=None, raw=None, app=None):
        target_parts = urlsplit(target)
        if raw is not None:
            body = raw
        elif payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        else:
            body = b""
        environ = {
            "REQUEST_METHOD": method,
            "SCRIPT_NAME": "",
            "PATH_INFO": target_parts.path,
            "QUERY_STRING": target_parts.query,
            "SERVER_NAME": "localhost",
            "SERVER_PORT": "8080",
            "SERVER_PROTOCOL": "HTTP/1.1",
            "HTTP_HOST": "localhost:8080",
            "REMOTE_ADDR": "127.0.0.1",
            "CONTENT_LENGTH": str(len(body)),
            "wsgi.version": (1, 0),
            "wsgi.url_scheme": "http",
            "wsgi.input": io.BytesIO(body),
            "wsgi.errors": io.StringIO(),
            "wsgi.multithread": True,
            "wsgi.multiprocess": False,
            "wsgi.run_once": False,
        }
        if payload is not None:
            environ["CONTENT_TYPE"] = "application/json"
        for name, value in (headers or {}).items():
            normalized = name.upper().replace("-", "_")
            if normalized not in ("CONTENT_TYPE", "CONTENT_LENGTH"):
                normalized = "HTTP_" + normalized
            environ[normalized] = value
        response = {}

        def start_response(status, response_headers, exc_info=None):
            response["status"] = int(status.split(" ", 1)[0])
            response["headers"] = {
                key.lower(): value for key, value in response_headers
            }

        iterable = (app or self.app)(environ, start_response)
        try:
            response["body"] = b"".join(iterable)
        finally:
            if hasattr(iterable, "close"):
                iterable.close()
        return response

    def api(self, method, target, payload=None, expected=200, **kwargs):
        response = self.request(method, target, payload=payload, **kwargs)
        self.assertEqual(response["status"], expected, response["body"])
        self.assertIn("application/json", response["headers"].get("content-type", ""))
        return json.loads(response["body"].decode("utf-8"))

    def make_library(self, name="日常生活", **overrides):
        payload = {
            "name": name,
            "description": "大家一起收集适合你画我猜的词语",
            "color": "mint",
        }
        payload.update(overrides)
        result = self.api("POST", "/api/libraries", payload, expected=201)
        self.assertIn("library", result)
        return result["library"]

    def add_words(self, library_id, words, contributor="小画家", expected=200, owner=None):
        payload = {"words": words, "contributor": contributor}
        if owner is not None:
            payload["owner"] = owner
        return self.api(
            "POST",
            "/api/libraries/{}/words".format(library_id),
            payload,
            expected=expected,
        )

    def get_words(self, library_id, query=""):
        return self.api(
            "GET", "/api/libraries/{}/words{}".format(library_id, query)
        )

    def assert_json_error(self, method, target, payload=None, expected=400, **kwargs):
        result = self.api(method, target, payload, expected=expected, **kwargs)
        self.assertIsInstance(result.get("error"), str)
        self.assertTrue(result["error"].strip())
        self.assertTrue(
            any("\u4e00" <= char <= "\u9fff" for char in result["error"]),
            "API errors should explain the problem in Chinese",
        )
        return result

    def test_empty_database_and_health(self):
        self.assertEqual(
            self.api("GET", "/api/libraries"),
            {"libraries": [], "total_words": 0},
        )
        self.assertEqual(self.api("GET", "/healthz")["status"], "ok")

    def test_create_list_add_and_reopen_database(self):
        library = self.make_library()
        self.assertEqual(library["name"], "日常生活")
        self.assertEqual(library["word_count"], 0)
        self.assertTrue(library["created_at"])
        self.assertEqual(library["color"], "mint")
        addition = self.add_words(library["id"], ["自行车", "热气球"])
        self.assertEqual(addition, {"added": 2, "duplicates": [], "total": 2})

        libraries = self.api("GET", "/api/libraries")
        self.assertEqual(libraries["total_words"], 2)
        self.assertEqual(libraries["libraries"][0]["word_count"], 2)
        result = self.get_words(library["id"])
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["page"], 1)
        self.assertEqual(result["page_size"], 60)
        self.assertEqual(result["library"]["id"], library["id"])
        self.assertEqual({word["text"] for word in result["words"]}, {"自行车", "热气球"})
        for word in result["words"]:
            self.assertIsInstance(word["id"], int)
            self.assertEqual(word["contributor"], "小画家")
            self.assertTrue(word["created_at"])
            self.assertFalse(word["owned"])
            self.assertNotIn("owner_key", word)

        reopened = create_app(self.db_path, seed=False)
        persisted = self.api(
            "GET", "/api/libraries/{}/words".format(library["id"]), app=reopened
        )
        self.assertEqual(persisted["total"], 2)
        self.assertEqual({word["text"] for word in persisted["words"]}, {"自行车", "热气球"})

    def test_libraries_keep_words_separate_and_total_counts_all(self):
        first = self.make_library("动物")
        second = self.make_library("影视")
        self.add_words(first["id"], ["熊猫", "大象"])
        self.add_words(second["id"], ["熊猫"])
        self.assertEqual(self.get_words(first["id"])["total"], 2)
        self.assertEqual(self.get_words(second["id"])["total"], 1)
        self.assertEqual(self.api("GET", "/api/libraries")["total_words"], 3)

    def test_normalized_duplicates_within_request_and_existing_data(self):
        library = self.make_library()
        result = self.add_words(
            library["id"],
            ["Apple", "apple", "ＡＰＰＬＥ", "  热  气球  ", "热 气球", "Straße", "STRASSE"],
        )
        self.assertEqual(result["added"], 3)
        self.assertEqual(len(result["duplicates"]), 4)
        self.assertEqual(result["total"], 3)
        again = self.add_words(library["id"], ["APPLE", "热\t气球", "STRASSE"])
        self.assertEqual(again["added"], 0)
        self.assertEqual(len(again["duplicates"]), 3)
        self.assertEqual(again["total"], 3)
        words = self.get_words(library["id"])["words"]
        self.assertEqual({word["text"] for word in words}, {"Apple", "热 气球", "Straße"})

    def test_search_matches_sql_wildcards_literally(self):
        library = self.make_library()
        self.add_words(
            library["id"], ["100%纯净", "100X纯净", "a_b", "acb", "a\\b", "普通词语"]
        )
        for search, expected_text in [("%", "100%纯净"), ("_", "a_b"), ("\\", "a\\b")]:
            with self.subTest(search=search):
                result = self.get_words(library["id"], "?q=" + quote(search, safe=""))
                self.assertEqual(result["total"], 1)
                self.assertEqual([word["text"] for word in result["words"]], [expected_text])
        injection = self.get_words(library["id"], "?q=" + quote("' OR 1=1 --", safe=""))
        self.assertEqual(injection["total"], 0)

    def test_pagination_has_no_missing_or_repeated_words(self):
        library = self.make_library()
        self.add_words(library["id"], ["词语一", "词语二", "词语三", "词语四", "词语五"])
        pages = [self.get_words(library["id"], "?page={}&page_size=2".format(page)) for page in (1, 2, 3)]
        self.assertEqual([len(page["words"]) for page in pages], [2, 2, 1])
        self.assertTrue(all(page["total"] == 5 and page["page_size"] == 2 for page in pages))
        self.assertEqual([page["page"] for page in pages], [1, 2, 3])
        all_ids = [word["id"] for page in pages for word in page["words"]]
        self.assertEqual(len(all_ids), len(set(all_ids)))
        self.assertEqual(self.get_words(library["id"], "?page=4&page_size=2")["words"], [])

    def test_library_validation_rejects_invalid_name_description_and_types(self):
        invalid_payloads = [
            {},
            {"name": ""},
            {"name": "   "},
            {"name": "字" * 41},
            {"name": 123},
            {"name": "正常题库", "description": "字" * 161},
            {"name": "正常题库", "description": []},
            [],
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                self.assert_json_error("POST", "/api/libraries", payload)
        self.assertEqual(self.api("GET", "/api/libraries")["libraries"], [])

    def test_word_validation_is_atomic_and_enforces_batch_and_text_limits(self):
        library = self.make_library()
        path = "/api/libraries/{}/words".format(library["id"])
        invalid_payloads = [
            {},
            {"words": "苹果"},
            {"words": []},
            {"words": ["有效词语", 123]},
            {"words": ["有效词语", ""]},
            {"words": ["有效词语", "   "]},
            {"words": ["有效词语", "字" * 51]},
            {"words": ["词语{}".format(number) for number in range(201)]},
            {"words": ["有效词语"], "contributor": "字" * 25},
            {"words": ["有效词语"], "contributor": 123},
            [],
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                self.assert_json_error("POST", path, payload)
        self.assertEqual(self.get_words(library["id"])["total"], 0)

    def test_maximum_batch_and_lengths_are_accepted(self):
        library = self.make_library("字" * 40, description="字" * 160)
        batch = ["词语{}".format(number) for number in range(199)] + ["字" * 50]
        result = self.add_words(library["id"], batch, contributor="字" * 24)
        self.assertEqual(result["added"], 200)
        self.assertEqual(result["total"], 200)

    def test_missing_library_is_not_found_for_reads_writes_and_export(self):
        for method, path, payload in [
            ("GET", "/api/libraries/999999/words", None),
            ("POST", "/api/libraries/999999/words", {"words": ["苹果"]}),
            ("GET", "/api/libraries/999999/export", None),
            ("GET", "/api/libraries/999999/similar?q=苹果", None),
            ("POST", "/api/libraries/999999/similar", {"words": ["苹果"]}),
            ("DELETE", "/api/libraries/999999/words/1", {"owner": "a" * 32}),
        ]:
            with self.subTest(method=method, path=path):
                self.assert_json_error(method, path, payload, expected=404)

    def test_export_is_plain_text_and_preserves_untrusted_text(self):
        library = self.make_library("<script>alert(1)</script>")
        untrusted = "<img src=x onerror=alert(1)>"
        self.add_words(library["id"], ["熊猫", untrusted])
        words = self.get_words(library["id"])["words"]
        self.assertIn(untrusted, [word["text"] for word in words])
        self.assertEqual(self.api("GET", "/api/libraries")["libraries"][0]["name"], library["name"])
        response = self.request("GET", "/api/libraries/{}/export".format(library["id"]))
        self.assertEqual(response["status"], 200)
        self.assertIn("text/plain", response["headers"].get("content-type", ""))
        exported_lines = response["body"].decode("utf-8-sig").splitlines()
        self.assertEqual(set(exported_lines), {"熊猫", untrusted})
        self.assertNotIn("<!doctype", response["body"].decode("utf-8").lower())

    def test_json_content_type_and_valid_json_are_required(self):
        self.assert_json_error(
            "POST", "/api/libraries", raw=b'{"name":"test"}', expected=415
        )
        self.assert_json_error(
            "POST", "/api/libraries", raw=b'{"name":"test"}',
            headers={"Content-Type": "text/plain"}, expected=415,
        )
        self.assert_json_error(
            "POST", "/api/libraries", raw=b'{"name":',
            headers={"Content-Type": "application/json"}, expected=400,
        )
        self.assert_json_error(
            "POST", "/api/libraries", raw=b"\xff",
            headers={"Content-Type": "application/json"}, expected=400,
        )

    def test_oversized_request_does_not_create_a_library(self):
        self.assert_json_error(
            "POST", "/api/libraries", {"name": "字" * 22000}, expected=413
        )
        self.assertEqual(self.api("GET", "/api/libraries")["libraries"], [])

    def test_invalid_pagination_and_search_length_return_client_errors(self):
        library = self.make_library()
        for query in [
            "?page=0", "?page=-1", "?page=abc", "?page=1000001",
            "?page_size=0", "?page_size=201", "?page_size=abc",
            "?q=" + quote("字" * 101),
        ]:
            with self.subTest(query=query):
                self.assert_json_error(
                    "GET", "/api/libraries/{}/words{}".format(library["id"], query)
                )

    def test_cross_origin_and_cross_site_posts_are_rejected(self):
        payload = {"name": "被拒绝的题库"}
        for headers in [
            {"Origin": "https://evil.example"},
            {"Origin": "http://localhost:8081"},
            {"Origin": "null"},
            {"Sec-Fetch-Site": "cross-site"},
        ]:
            with self.subTest(headers=headers):
                self.assert_json_error("POST", "/api/libraries", payload, headers=headers, expected=403)
        result = self.api(
            "POST", "/api/libraries", {"name": "本机题库"},
            headers={"Origin": "http://localhost:8080", "Sec-Fetch-Site": "same-origin"},
            expected=201,
        )
        self.assertEqual(result["library"]["name"], "本机题库")
        self.assertEqual(len(self.api("GET", "/api/libraries")["libraries"]), 1)

    def test_simultaneous_duplicate_additions_create_exactly_one_word(self):
        library = self.make_library()
        barrier = threading.Barrier(6)

        def submit(_):
            barrier.wait(timeout=10)
            return self.request(
                "POST", "/api/libraries/{}/words".format(library["id"]),
                payload={"words": ["热气球"], "contributor": "并发测试"},
            )

        with ThreadPoolExecutor(max_workers=6) as executor:
            responses = list(executor.map(submit, range(6)))
        self.assertEqual([response["status"] for response in responses], [200] * 6)
        results = [json.loads(response["body"].decode("utf-8")) for response in responses]
        self.assertEqual(sum(result["added"] for result in results), 1)
        self.assertEqual(sum(len(result["duplicates"]) for result in results), 5)
        self.assertEqual(self.get_words(library["id"])["total"], 1)

    def test_cannot_delete_libraries_or_all_words_at_once(self):
        library = self.make_library()
        self.add_words(library["id"], ["保留的词语"])
        self.assert_json_error("DELETE", "/api/libraries/{}".format(library["id"]), expected=404)
        self.assert_json_error("DELETE", "/api/libraries/{}/words".format(library["id"]), expected=405)
        self.assertEqual(self.get_words(library["id"])["total"], 1)

    def test_only_the_owner_can_delete_a_word(self):
        library = self.make_library()
        owner = "a" * 32
        other = "b" * 32
        self.add_words(library["id"], ["自己的词语"], owner=owner)
        self.add_words(library["id"], ["别人的词语"], owner=other)
        self.add_words(library["id"], ["没有凭证的词语"])
        mine = self.api(
            "GET",
            "/api/libraries/{}/words".format(library["id"]),
            headers={"X-Huacai-Owner": owner},
        )
        owned = [word for word in mine["words"] if word["owned"]]
        self.assertEqual([word["text"] for word in owned], ["自己的词语"])
        word_id = owned[0]["id"]
        others = [word for word in mine["words"] if word["text"] == "别人的词语"][0]
        anonymous = [word for word in mine["words"] if word["text"] == "没有凭证的词语"][0]

        self.assert_json_error(
            "DELETE",
            "/api/libraries/{}/words/{}".format(library["id"], others["id"]),
            {"owner": owner},
            expected=403,
        )
        self.assert_json_error(
            "DELETE",
            "/api/libraries/{}/words/{}".format(library["id"], anonymous["id"]),
            {"owner": owner},
            expected=403,
        )
        self.assert_json_error(
            "DELETE",
            "/api/libraries/{}/words/{}".format(library["id"], word_id),
            {"owner": other},
            expected=403,
        )
        self.assert_json_error(
            "DELETE",
            "/api/libraries/{}/words/{}".format(library["id"], word_id),
            {},
            expected=400,
        )
        deleted = self.api(
            "DELETE",
            "/api/libraries/{}/words/{}".format(library["id"], word_id),
            {"owner": owner},
        )
        self.assertEqual(deleted, {"deleted": True, "total": 2})
        remaining = {word["text"] for word in self.get_words(library["id"])["words"]}
        self.assertEqual(remaining, {"别人的词语", "没有凭证的词语"})
        again = self.add_words(library["id"], ["自己的词语"], owner=owner)
        self.assertEqual(again["added"], 1)

    def test_delete_is_rejected_across_origin_and_missing_words(self):
        library = self.make_library()
        owner = "a" * 32
        self.add_words(library["id"], ["可删除"], owner=owner)
        word_id = self.get_words(library["id"])["words"][0]["id"]
        path = "/api/libraries/{}/words/{}".format(library["id"], word_id)
        self.assert_json_error(
            "DELETE", path, {"owner": owner},
            headers={"Origin": "https://evil.example"}, expected=403,
        )
        self.assert_json_error(
            "DELETE",
            "/api/libraries/{}/words/999999".format(library["id"]),
            {"owner": owner},
            expected=404,
        )
        self.assertEqual(self.get_words(library["id"])["total"], 1)

    def test_similar_finds_close_names_and_skips_unrelated_words(self):
        first = self.make_library("查重题库")
        second = self.make_library("隔离题库")
        self.add_words(first["id"], ["西瓜", "西瓜汁", "冰糖西瓜", "洗衣机", "洗衣服", "苹果", "飞机"])
        self.add_words(second["id"], ["西瓜"])
        melon = self.api("GET", "/api/libraries/{}/similar?q=西瓜".format(first["id"]))
        self.assertEqual(melon["query"], "西瓜")
        melon_texts = [match["text"] for match in melon["matches"]]
        self.assertEqual(melon_texts[0], "西瓜")
        self.assertEqual(melon["matches"][0]["reason"], "完全相同")
        self.assertIn("西瓜汁", melon_texts)
        self.assertIn("冰糖西瓜", melon_texts)
        self.assertNotIn("飞机", melon_texts)
        self.assertNotIn("苹果", melon_texts)
        washer = self.api(
            "POST",
            "/api/libraries/{}/similar".format(first["id"]),
            {"words": ["洗衣机", "飞机"]},
        )
        grouped = {item["word"]: item["matches"] for item in washer["results"]}
        washer_texts = [match["text"] for match in grouped["洗衣机"]]
        self.assertIn("洗衣机", washer_texts)
        self.assertIn("洗衣服", washer_texts)
        plane_texts = [match["text"] for match in grouped["飞机"]]
        self.assertEqual(plane_texts, ["飞机"])
        isolated = self.api("GET", "/api/libraries/{}/similar?q=洗衣机".format(second["id"]))
        self.assertEqual(isolated["matches"], [])

    def test_similar_normalizes_case_width_accents_kana_and_punctuation(self):
        library = self.make_library("增强查重")
        self.add_words(library["id"], [
            "ATRI -My Dear Moments-",
            "CLANNAD",
            "Ever 17 - The Out of Infinity",
            "STEINS;GATE",
            "DRACU-RIOT!",
            "CHAIRMAN",
            "White Album 2",
            "Baldr Sky",
            "Pokémon",
            "クラナド",
        ])
        result = self.api(
            "POST",
            "/api/libraries/{}/similar".format(library["id"]),
            {"words": [
                "atri",
                "CLANNAD After Story",
                "Ever17",
                "Steins Gate",
                "dracu riot",
                "AIR",
                "white album",
                "Sky Baldr",
                "pokemon",
                "くらなど",
            ]},
        )
        grouped = {
            item["word"]: [(match["text"], match["reason"]) for match in item["matches"]]
            for item in result["results"]
        }
        self.assertEqual(grouped["atri"], [("ATRI -My Dear Moments-", "现有词条包含该词")])
        self.assertEqual(grouped["CLANNAD After Story"], [("CLANNAD", "该词包含现有词条")])
        self.assertEqual(grouped["Ever17"], [("Ever 17 - The Out of Infinity", "现有词条包含该词")])
        self.assertIn(("STEINS;GATE", "仅写法不同（大小写/空格/符号）"), grouped["Steins Gate"])
        self.assertIn(("DRACU-RIOT!", "仅写法不同（大小写/空格/符号）"), grouped["dracu riot"])
        self.assertNotIn("CHAIRMAN", [text for text, _ in grouped["AIR"]])
        self.assertEqual(grouped["white album"], [("White Album 2", "现有词条包含该词")])
        self.assertIn(("Baldr Sky", "词序不同或名称相近"), grouped["Sky Baldr"])
        self.assertIn(("Pokémon", "仅写法不同（大小写/空格/符号）"), grouped["pokemon"])
        self.assertIn(("クラナド", "仅写法不同（大小写/空格/符号）"), grouped["くらなど"])

    def test_similar_validates_input_and_does_not_change_words(self):
        library = self.make_library()
        self.add_words(library["id"], ["熊猫"])
        self.assert_json_error("GET", "/api/libraries/{}/similar".format(library["id"]))
        self.assert_json_error(
            "POST",
            "/api/libraries/{}/similar".format(library["id"]),
            {"words": ["词条{}".format(number) for number in range(21)]},
        )
        self.assert_json_error(
            "DELETE",
            "/api/libraries/{}/similar".format(library["id"]),
            expected=405,
        )
        self.assertEqual(self.get_words(library["id"])["total"], 1)

    def test_existing_database_gains_owner_column(self):
        import sqlite3

        old_path = str(Path(self.temp_dir.name) / "legacy.sqlite3")
        connection = sqlite3.connect(old_path)
        connection.executescript("""
            CREATE TABLE libraries (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                name_key TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                color TEXT NOT NULL DEFAULT 'mint',
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            CREATE TABLE words (
                id INTEGER PRIMARY KEY,
                library_id INTEGER NOT NULL REFERENCES libraries(id),
                text TEXT NOT NULL,
                text_key TEXT NOT NULL,
                contributor TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                UNIQUE(library_id, text_key)
            );
            INSERT INTO libraries(id,name,name_key,description,color) VALUES(1,'旧题库','旧题库','','mint');
            INSERT INTO words(library_id,text,text_key,contributor) VALUES(1,'旧词条','旧词条','早期访客');
        """)
        connection.close()
        migrated = create_app(old_path, seed=False)
        result = self.api("GET", "/api/libraries/1/words", app=migrated)
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["words"][0]["text"], "旧词条")
        self.assertFalse(result["words"][0]["owned"])
        owner = "c" * 32
        self.api(
            "POST",
            "/api/libraries/1/words",
            {"words": ["新词条"], "owner": owner},
            app=migrated,
        )
        listed = self.api(
            "GET",
            "/api/libraries/1/words",
            headers={"X-Huacai-Owner": owner},
            app=migrated,
        )
        owned = [word for word in listed["words"] if word["owned"]]
        self.assertEqual([word["text"] for word in owned], ["新词条"])
        old = [word for word in listed["words"] if word["text"] == "旧词条"][0]
        self.assert_json_error(
            "DELETE",
            "/api/libraries/1/words/{}".format(old["id"]),
            {"owner": owner},
            expected=403,
            app=migrated,
        )

    def test_path_traversal_cannot_expose_source_or_database(self):
        for path in [
            "/../app.py",
            "/static/../app.py",
            "/static/%2e%2e/app.py",
            "/static/..%2fapp.py",
            "/static/..\\app.py",
            "/app.py",
            "/words.sqlite3",
        ]:
            with self.subTest(path=path):
                response = self.request("GET", path)
                self.assertGreaterEqual(response["status"], 400)
                self.assertLess(response["status"], 500)
                self.assertNotIn(b"SQLite format 3", response["body"])
                self.assertNotIn(b"def create_app", response["body"])


if __name__ == "__main__":
    unittest.main()
