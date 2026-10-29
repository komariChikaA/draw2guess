#!/usr/bin/env bash
# Run as root with a verified release directory and pre-downloaded pure Python wheels.
set -euo pipefail
release="$(realpath "$1")"
case "$release" in /opt/huacai/releases/*) ;; *) echo 'Unexpected release path' >&2; exit 1;; esac
test -f "$release/app.py"
test -f "$release/static/index.html"
chown -R root:root "$release"
find "$release" -type d -exec chmod 0755 {} +
find "$release" -type f -exec chmod 0644 {} +
if ss -ltnH 'sport = :80' | grep -q .; then
    if ! systemctl is-active --quiet huacai.service; then
        echo 'Port 80 already occupied; refusing to touch another service.' >&2
        exit 1
    fi
fi
if ! id huacai >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/huacai --shell /usr/sbin/nologin huacai
fi
install -d -m 0750 -o huacai -g huacai /var/lib/huacai
test -x /opt/huacai/venv/bin/python || python3 -m venv --without-pip /opt/huacai/venv
/opt/huacai/venv/bin/python "$release/deploy/install-wheels.py" "$release/wheels"
cd "$release"
/opt/huacai/venv/bin/python -m unittest discover -s tests -v
if test -f /var/lib/huacai/huacai.sqlite3; then
    runuser -u huacai -- /opt/huacai/venv/bin/python "$release/deploy/backup.py"
fi
HUACAI_DB=/var/lib/huacai/huacai.sqlite3 runuser -u huacai --preserve-environment -- /opt/huacai/venv/bin/python -c 'from app import create_app; create_app(seed=True)'
previous="$(readlink /opt/huacai/current || true)"
ln -sfn "$release" /opt/huacai/current.next
mv -Tf /opt/huacai/current.next /opt/huacai/current
install -m 0644 "$release/deploy/huacai.service" /etc/systemd/system/huacai.service
install -m 0644 "$release/deploy/huacai-backup.service" /etc/systemd/system/huacai-backup.service
install -m 0644 "$release/deploy/huacai-backup.timer" /etc/systemd/system/huacai-backup.timer
systemctl daemon-reload
systemctl enable huacai.service
systemctl restart huacai.service
ready=0
for attempt in {1..15}; do
    if curl --fail --silent http://127.0.0.1/healthz >/dev/null; then ready=1; break; fi
    sleep 1
done
if test "$ready" != 1; then
    if test -n "$previous"; then
        ln -sfn "$previous" /opt/huacai/current
        systemctl restart huacai.service
    else
        systemctl stop huacai.service
    fi
    echo 'New deployment failed health check; previous version restored if available.' >&2
    exit 1
fi
systemctl enable --now huacai-backup.timer
systemctl start huacai-backup.service
echo 'Huacai deployed successfully.'
systemctl --no-pager status huacai.service huacai-backup.timer
