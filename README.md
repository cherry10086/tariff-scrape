# Tariff Scrape (中国移动资费查询 · Debian 12 定时版)

抓取中国移动「资费公示专区」，按省份查询套餐，自动分类「主套餐 / 流量包」并按每 GB 单价排序，支持多省横向对比，输出文本报告与结构化 JSON。

## 核心特性

* 全国 31 个省份定向查询（名称严格匹配网页，用 `--list-provinces` 查看）。
* 自动分类：主套餐（可独立办理）与流量包/附加包（需叠加的优惠），按「国内通用流量」计算每 GB 单价，定向流量不计入。
* 多省对比：查询 ≥2 省时报告末尾自动附带对比表与全场最低价结论。
* 面向 Debian 12 服务器定时运行：systemd timer（推荐）/ cron，一键安装脚本，事件驱动等待等性能优化。

## 参数选项

运行 `node tariff-query.js`：

| 参数 | 功能描述 |
| --- | --- |
| `-p <省份名>` | 指定查询的省份（可多次使用，如 `-p 上海市 -p 江苏省`）。 |
| `--list-provinces` | 列出所有可选的 31 个省份名称。 |
| `--nationwide-only` | 只查询「全网资费」页签。 |
| `--local-only` | 只查询本省资费页签。 |
| `--top <N>` | 每类数据提取前 N 条记录（默认 8 条）。 |
| `--out <文件名>` | 报告输出到指定文本文件（如 `report.txt`）。 |
| `--json` | 额外导出结构化 JSON 文件。 |
| `--headful` | 显示浏览器窗口（默认无头），调试用。 |
| `-h, --help` | 帮助。 |

环境变量：`TARIFF_PROVINCES="江苏省"` 作为 `-p` 的默认值，供 systemd/cron 部署使用。

## 命令示例

```bash
# 查询支持的省份名称
node tariff-query.js --list-provinces

# 查询上海与江苏，取前 10 条，生成文本报告并导出 JSON（≥2 省自动附带对比表）
node tariff-query.js -p 上海市 -p 江苏省 --top 10 --out report.txt --json

# 只看江苏省本地资费页签
node tariff-query.js -p 江苏省 --local-only
```

## 防封提示（重要）

资费公示站点对高频/大批量访问有风控，请注意：

* **一次运行只查一个省**：页面默认视图自带「全网资费」页签，单省一次运行即覆盖「全国 + 该省」全部数据，请求量最小。默认部署配置即为此模式。
* **不要一次传大量省份**（会把所有省的接口都拉一遍，特征明显像爬虫）。确需多省对比时，拆成多次运行：为每个省建一个 timer 实例，错开运行时刻（做法见 DEBIAN12.md）；同一次运行传多个省时，脚本会在省与省之间随机停顿（`--delay`，默认 30 秒）以打散节奏。
* 运行频率保持低频（默认每天 07:00/19:00 两次足够；资费数据变化远没有这么快）。

## Debian 12 部署与定时运行

参见 [DEBIAN12.md](DEBIAN12.md)。最快路径：

```bash
git clone https://github.com/cherry10086/tariff-scrape.git && cd tariff-scrape
sudo ./install-debian12.sh    # 装依赖、部署 /opt、启用每天 07:00/19:00 的 systemd timer
```

改查询省份：编辑 `/etc/tariff-scraper.conf`。日志：`journalctl -u tariff-scraper -f`。报告：`/var/lib/tariff-scraper/report.txt`。
