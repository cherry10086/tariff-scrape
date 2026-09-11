#!/usr/bin/env bash
# tariff-scrape Debian 12 一键部署脚本(需 root)
# 安装内容: chromium + 中文字体 + node 依赖 + 专用低权用户 + systemd timer
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "请用 root 运行: sudo ./install-debian12.sh"; exit 1; fi

APP_DIR=/opt/tariff-scrape
STATE_DIR=/var/lib/tariff-scraper
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> 安装系统依赖 (chromium / 中文字体 / node)..."
apt-get update
apt-get install -y --no-install-recommends chromium fonts-noto-cjk
command -v node >/dev/null 2>&1 || apt-get install -y --no-install-recommends nodejs

echo "==> 部署代码到 ${APP_DIR}..."
install -d "${APP_DIR}"
# 源目录就是部署目录时(重复运行本脚本)跳过拷贝, 避免 cp "same file" 报错
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  cp "$SRC_DIR"/tariff-query.js "$SRC_DIR"/package.json "$SRC_DIR"/package-lock.json "$APP_DIR"/
fi
cd "$APP_DIR"
npm ci --omit=dev

echo "==> 创建专用用户与状态目录..."
id tariff >/dev/null 2>&1 || useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin tariff
install -d -o tariff -g tariff "$STATE_DIR"

echo "==> 安装配置文件与 systemd 单元..."
install -m 644 "$SRC_DIR/deploy/tariff-scraper.conf" /etc/tariff-scraper.conf
install -m 644 "$SRC_DIR/deploy/tariff-scraper.service" /etc/systemd/system/tariff-scraper.service
install -m 644 "$SRC_DIR/deploy/tariff-scraper.timer" /etc/systemd/system/tariff-scraper.timer
systemctl daemon-reload

echo "==> 手动试跑一次, 验证 chromium/node/页面可达..."
runuser -u tariff -- node "$APP_DIR/tariff-query.js" --list-provinces | head -5 || true

echo "==> 启用定时器 (每天 07:00/19:00)..."
systemctl enable --now tariff-scraper.timer

echo "完成。常用命令:"
echo "  systemctl list-timers tariff-scraper.timer    # 查看下次运行时间"
echo "  systemctl start tariff-scraper.service        # 立即手动跑一次"
echo "  journalctl -u tariff-scraper -f               # 跟踪日志"
echo "  报告输出: ${STATE_DIR}/report.txt 与 report.json"
