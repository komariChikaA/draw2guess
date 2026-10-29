"""Online SQLite backup; retains the latest seven successful daily snapshots."""
from datetime import datetime, timezone
import os
from pathlib import Path
import sqlite3
import shutil

source = Path(os.environ.get("HUACAI_DB", "/var/lib/huacai/huacai.sqlite3"))
destination = source.parent / "backups"
destination.mkdir(mode=0o750, exist_ok=True)
if shutil.disk_usage(destination).free < source.stat().st_size + 512 * 1024 * 1024:
    raise RuntimeError("Insufficient free space for a safe database backup")
name = "huacai-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + ".sqlite3"
target = destination / name
try:
    with sqlite3.connect(str(source)) as original, sqlite3.connect(str(target)) as snapshot:
        original.backup(snapshot, pages=256, sleep=0.05)
        assert snapshot.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    os.chmod(target, 0o640)
except Exception:
    target.unlink(missing_ok=True)
    raise
for old in sorted(destination.glob("huacai-*.sqlite3"), reverse=True)[7:]:
    old.unlink()
print("Backup complete:", target.name)
