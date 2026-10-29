# 部署与维护

本文档说明如何在一台 Linux 服务器上自建 draw2guess。示例路径沿用 `deploy/` 脚本中的默认值，部署到自己的环境时可以整体替换。

## 环境要求

- Linux + systemd
- Python 3.10 或更新版本
- SQLite 3（Python 标准库自带）
- 一个可写的持久化数据目录
- 若直接监听 80 端口，需要相应权限；也可以监听高位端口后由 Nginx/Caddy 反向代理

项目运行时不依赖第三方 Python 包；`gunicorn` 仅用于生产环境，已列在 `requirements.txt`。

## 运行方式

开发预览：

```bash
python app.py --port 8088 --seed
```

生产环境通过 WSGI 入口 `wsgi:application` 启动，建议 2 个 worker、4 个线程：

```bash
HUACAI_DB=/var/lib/huacai/huacai.sqlite3 \
  /opt/huacai/venv/bin/python -m gunicorn \
  --bind 0.0.0.0:8088 --workers 2 --threads 4 --timeout 30 \
  --worker-tmp-dir /run/huacai wsgi:application
```

数据库路径由环境变量 `HUACAI_DB` 指定，默认是仓库内的 `data/huacai.sqlite3`。生产环境应指向独立的数据目录，不要把数据库放进版本目录。

## 使用部署脚本

`deploy/` 提供了 systemd 单元、安装脚本和备份脚本。发布流程是：把代码、测试、`deploy/` 与预先下载的纯 Python wheel 打成压缩包，解压到新的版本目录，然后以 root 执行：

```bash
bash /opt/huacai/releases/<版本>/deploy/install.sh /opt/huacai/releases/<版本>
```

脚本会依次：

1. 检查目标端口是否被其他服务占用；
2. 创建独立系统用户与数据目录；
3. 在专用虚拟环境中安装 `wheels/` 里的依赖；
4. 运行全部测试；
5. 备份现有数据库；
6. 切换 `current` 符号链接并重启服务；
7. 轮询 `/healthz`，失败时自动恢复到上一个版本。

首次安装失败会停止新服务；更新失败会切回旧版本。脚本不会安装系统软件，也不会改动其他服务。

## 手动部署

如果不使用安装脚本，可以按下面的步骤操作：

```bash
useradd --system --home-dir /var/lib/huacai --shell /usr/sbin/nologin huacai
install -d -m 0750 -o huacai -g huacai /var/lib/huacai
install -d -m 0755 /opt/huacai/releases/<版本>
# 将发布包解压到 /opt/huacai/releases/<版本> 后
python3 -m venv /opt/huacai/venv
/opt/huacai/venv/bin/pip install -r requirements.txt
ln -sfn /opt/huacai/releases/<版本> /opt/huacai/current
install -m 0644 deploy/huacai.service /etc/systemd/system/huacai.service
systemctl daemon-reload
systemctl enable --now huacai.service
```

`deploy/huacai.service` 默认监听 80 端口，并启用了只读文件系统、独立临时目录、能力限制、内存 / CPU / 任务数上限等隔离项。如果改用反向代理，把 `--bind` 改成 `127.0.0.1:8088`，并在服务单元中同步调整。

## 反向代理与 HTTPS

建议由 Nginx 或 Caddy 终止 TLS，再转发到本机应用端口。Nginx 示例：

```nginx
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:8088;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

登录 Cookie 目前按站点实际协议下发；如果通过公网使用，请配置 HTTPS，避免账号会话在明文连接中传输。

## 备份

`deploy/backup.py` 使用 SQLite 在线备份 API 生成一致性快照，并做 `PRAGMA integrity_check`，默认保留最近 7 份：

```bash
HUACAI_DB=/var/lib/huacai/huacai.sqlite3 \
  /opt/huacai/venv/bin/python /opt/huacai/current/deploy/backup.py
```

`deploy/huacai-backup.timer` 默认每天 03:20 UTC 执行，并带 20 分钟随机延迟。备份前会检查剩余空间，低于“数据库大小 + 512 MiB”时拒绝执行。

SQLite 使用 WAL 模式，**不要**在服务运行时直接复制主库文件代替在线备份。

## 升级与回滚

升级就是解压新版本并重新执行安装脚本。`/opt/huacai/current` 始终指向当前版本，历史版本目录保留，便于回滚：

```bash
ln -sfn /opt/huacai/releases/<旧版本> /opt/huacai/current
systemctl restart huacai.service
curl -fsS http://127.0.0.1:8088/healthz
```

回滚只切换代码，不回滚数据库。数据库结构变更需要向后兼容；如需恢复数据，先停止服务并备份当前数据库，再使用在线备份文件恢复。

## 日常维护

```bash
systemctl status huacai.service
journalctl -u huacai.service -n 100 --no-pager
systemctl start huacai-backup.service
systemctl list-timers huacai-backup.timer
curl -fsS http://127.0.0.1:8088/healthz
```

检查数据库完整性：

```bash
sudo -u huacai /opt/huacai/venv/bin/python -c \
  'import sqlite3; c=sqlite3.connect("/var/lib/huacai/huacai.sqlite3"); print(c.execute("PRAGMA integrity_check").fetchone()[0])'
```

停止服务：

```bash
systemctl disable --now huacai.service huacai-backup.timer
```

数据和版本目录都会保留。

## 数据与容量

- 单次请求上限 1 MiB。
- 每个房间原始画作最多 16 MiB / 500,000 个坐标点，全局压缩画作上限 128 MiB。
- 房间数上限 200，空闲房间 5 分钟后回收。
- 题库上限 2,000 个、词条上限 100,000 条。
- 每个来源 IP 每分钟最多新建 5 个题库、提交 30 批词条、删除 30 条词条。

## 安全提示

- 公网部署请使用 HTTPS，并只开放实际需要的端口。
- 服务以独立低权限用户运行，数据目录与版本目录分离。
- 不要向公开题库填写私人信息；词库和词条默认对所有访问者可见。
- 账号密码使用 PBKDF2-HMAC-SHA256 加盐存储，会话 Cookie 为 HttpOnly、SameSite=Lax。
