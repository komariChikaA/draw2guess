"""Install downloaded, pinned pure-Python wheels into this interpreter's venv."""
import pathlib
import sys
import sysconfig
import zipfile

target = pathlib.Path(sysconfig.get_path("purelib"))
assert sys.prefix != sys.base_prefix, "Use the dedicated virtual environment"
target.mkdir(parents=True, exist_ok=True)
for wheel in sorted(pathlib.Path(sys.argv[1]).glob("*.whl")):
    assert wheel.name.endswith("-py3-none-any.whl"), wheel.name
    with zipfile.ZipFile(wheel) as archive:
        for entry in archive.namelist():
            assert not entry.startswith("/") and ".." not in pathlib.PurePosixPath(entry).parts
        archive.extractall(target)
    print("Installed", wheel.name)
