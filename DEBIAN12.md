# Debian 12 定时部署指南

把 tariff-scrape 改造成 Debian 12 服务器上的定时任务：**systemd timer（推荐）** 或 **cron** 二选一。

## 方式一：一键安装（推荐）

```bash
# 以 root 在仓库根目录执行
sudo ./install-debian12.sh
```

脚本会自动完成：

1. `apt-get install chromium fonts-noto-cjk nodejs`（Node 18 满足 puppeteer-core 23 的要求）
2. 代码部署到 `/opt/tariff-scrape`，`npm ci --omit=dev`（仅 puppeteer-core 一个依赖）
3. 创建专用低权系统用户 `tariff`（`/usr/sbin/nologin`，不可登录）
4. 安装 systemd 单元并启用定时器，状态目录 `/var/lib/tariff-scraper`
5. 手动试跑一次 `--list-provinces` 验证页面可达

## 方式二：手动安装

```bash
# 1. 系统依赖
apt-get update
apt-get install -y --no-install-recommends chromium fonts-noto-cjk nodejs

# 2. 代码
mkdir -p /opt/tariff-scrape
cp tariff-query.js package.json package-lock.json /opt/tariff-scrape/
cd /opt/tariff-scrape && npm ci --omit=dev

# 3. 专用用户与目录
useradd --system --home-dir /var/lib/tariff-scraper --shell /usr/sbin/nologin tariff
install -d -o tariff -g tariff /var/lib/tariff-scraper

# 4. systemd 单元
cp deploy/tariff-scraper.conf   /etc/tariff-scraper.conf
cp deploy/tariff-scraper.service /etc/systemd/system/
cp deploy/tariff-scraper.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tariff-scraper.timer

# 5. 验证
systemctl start tariff-scraper.service   # 立即跑一次
journalctl -u tariff-scraper -f          # 看日志
cat /var/lib/tariff-scraper/report.txt   # 看报告
```

## 日常运维

| 操作 | 命令 |
| --- | --- |
| 查看下次运行时间 | `systemctl list-timers tariff-scraper.timer` |
| 立即手动跑一次 | `systemctl start tariff-scraper.service` |
| 跟踪日志 | `journalctl -u tariff-scraper -f` |
| 改查询省份 | 编辑 `/etc/tariff-scraper.conf` 的 `TARIFF_PROVINCES` |
| 改运行时间 | 编辑 timer 的 `OnCalendar` 后 `systemctl daemon-reload` |
| 停用 | `systemctl disable --now tariff-scraper.timer` |

省份名必须与页面一致，可用 `node /opt/tariff-scrape/tariff-query.js --list-provinces` 查询。

## 方式三：cron 备选

如果环境不用 systemd：

```bash
cp deploy/tariff-scraper.cron /etc/cron.d/tariff-scraper
cp deploy/tariff-scraper.logrotate /etc/logrotate.d/tariff-scraper
touch /var/log/tariff-scraper.log && chown tariff:tariff /var/log/tariff-scraper.log
```

cron 版本自带 `flock -n` 防止上次未跑完时重叠启动；日志走 `/var/log/tariff-scraper.log`（logrotate 每周转切，留 8 份）。
**注意：systemd timer 与 cron 二选一，同时启用会双倍抓取。**

## 本次性能优化清单

| 优化点 | 原来 | 现在 |
| --- | --- | --- |
| 首屏等待 | `networkidle2` + 固定 sleep 6s | `domcontentloaded` + 事件驱动等 `.prov-entry`/`.range-tab`/卡片出现 |
| 切省等待 | 固定 sleep 6.5s | 等省份入口文本变为目标省 + 页签重渲染（上限 20s 兜底） |
| 页签切换 | 固定 sleep 3.5s | 等卡片数量连续两次采样不变 |
| 懒加载滚动 | 固定滚 15 轮 + 1.2s | 连续两轮卡片数不增长即提前停止 |
| 资源加载 | 全量 | 拦截并丢弃 image/media/font 请求（CSS 必须放行，innerText 依赖它） |
| Chrome 启动 | 3 个参数 | 面向服务器：`--disable-dev-shm-usage`（防 /dev/shm 64M 崩溃）、`--disable-gpu`、独立临时 user-data-dir 等 |
| 文件写入 | 直接覆盖 | 临时文件 + rename 原子写，读方永远拿到完整文件 |
| 失败处理 | 抛错即止 | 脚本内即时重试 1 次 + 10 分钟看门狗 + systemd `Restart=on-failure` 兜底 |
| 系统资源 | 无约束 | `MemoryMax=1G`、`CPUWeight=30`、`Nice=15`、`IOSchedulingClass=idle`，不与同机服务抢资源 |
| 调度 | 进程内 `setInterval`（--watch） | systemd timer：`RandomizedDelaySec` 防整点拥塞、`Persistent=true` 补跑错过的班次 |

单省抓取耗时估计从 ~25s 降到 ~8-12s（取决于接口响应速度；最坏情况不劣于原版，因为每处事件等待的超时上限都 ≥ 原盲等时长）。

## 已知注意事项

- `--no-sandbox` 目前保留（兼容 root 手动调试）。生产上以专用用户 `tariff` 运行时，可从 `tariff-query.js` 的 `buildLaunchArgs()` 里删掉该行以启用 Chromium 自带沙箱。
- 数据源是加密 SPA，只能浏览器渲染抓取，无法换成纯 HTTP 请求；每轮冷启动 Chrome 的 ~2s 开销无法避免，这是换稳定性的代价（systemd oneshot 模式不怕进程崩溃）。
- 多省查询在同一页面内串行切换（页面全局状态所致，无法并行）；如果确实要多省并行，可复制多份 service/timer 用不同 `EnvironmentFile` 跑多实例。
