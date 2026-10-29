"""One-time, backed-up replacement of the three explicitly named starter banks."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys

OLD_NAMES = {"日常脑洞", "动物开会", "成语挑战"}
NEW_NAMES = ["galgame题库", "小众宝藏题库"]


def replace(database):
    database = Path(database).resolve(strict=True)
    connection = sqlite3.connect(str(database), timeout=15)
    connection.execute("PRAGMA foreign_keys=ON")
    try:
        connection.execute("BEGIN IMMEDIATE")
        libraries = connection.execute("SELECT id,name FROM libraries ORDER BY id").fetchall()
        if len(libraries) == 2 and {r[1] for r in libraries} == set(NEW_NAMES):
            connection.rollback()
            return {"state": "already_replaced", "libraries": libraries}
        if len(libraries) != 3 or {r[1] for r in libraries} != OLD_NAMES:
            raise RuntimeError("Current libraries differ from the authorized three; no data changed")
        destination = database.parent / "backups"
        destination.mkdir(mode=0o750, exist_ok=True)
        if shutil.disk_usage(destination).free < database.stat().st_size + 512 * 1024 * 1024:
            raise RuntimeError("Insufficient space for a safe backup; no data changed")
        snapshot = destination / ("before-library-replacement-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f") + ".sqlite3")
        # A second connection snapshots committed data while BEGIN IMMEDIATE blocks writers.
        source = sqlite3.connect(str(database), timeout=15)
        target = sqlite3.connect(str(snapshot))
        try:
            source.backup(target)
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("Backup integrity check failed; no data changed")
        finally:
            target.close()
            source.close()
        os.chmod(snapshot, 0o640)
        old_ids = [r[0] for r in libraries]
        new_id = max(old_ids) + 1
        deleted_words = connection.execute("DELETE FROM words WHERE library_id IN (?,?,?)", old_ids).rowcount
        deleted_libraries = connection.execute("DELETE FROM libraries WHERE id IN (?,?,?)", old_ids).rowcount
        for offset, name in enumerate(NEW_NAMES):
            connection.execute("INSERT INTO libraries(id,name,name_key,description,color) VALUES(?,?,?,?,?)", (new_id + offset, name, name.casefold(), "", "mint"))
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("Foreign key check failed; changes rolled back")
        connection.commit()
        return {"state": "replaced", "backup": str(snapshot), "deleted_libraries": deleted_libraries, "deleted_words": deleted_words, "libraries": [{"id": new_id + i, "name": name, "word_count": 0} for i, name in enumerate(NEW_NAMES)]}
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


if __name__ == "__main__":
    print(json.dumps(replace(sys.argv[1]), ensure_ascii=False))
