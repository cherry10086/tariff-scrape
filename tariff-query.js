/**
 * 中国移动「资费公示专区」套餐查询脚本
 * 数据源: https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html
 *
 * 该页面是加密网关的 Vue SPA（请求/响应都是 AES 密文），
 * 所以这里用本机 Chrome 驱动页面自行解密渲染，再抓 DOM，
 * 按「资费标准 ÷ 国内通用流量」算出每 GB 单价。
 *
 * 说明:
 *  - 专区只能按【省】切换，没有地级市。苏州用户看到的即江苏省资费。
 *  - 每个省有两个页签: 全网资费(全国卡) 和 本省资费(如 上海资费/江苏资费)。
 *  - 单价只按「国内通用流量」计算，定向流量不计入。
 *
 * 依赖: puppeteer-core + 本机 Chrome/Chromium (Debian 12: apt install chromium)
 *
 * Debian 12 定时部署: 见 DEBIAN12.md (systemd timer 为主, cron 备选)
 * 环境变量 TARIFF_PROVINCES="上海市 江苏省" 可作为 -p 的默认值
 *
 * 用法示例:
 *   node tariff-query.js --list-provinces                 列出所有可选省份名
 *   node tariff-query.js --province 上海市                 查上海(全网+本省)
 *   node tariff-query.js -p 上海市 -p 江苏省               同时查多个省
 *   node tariff-query.js -p 江苏省 --local-only            只看本省页签
 *   node tariff-query.js -p 上海市 --nationwide-only       只看全网页签
 *   node tariff-query.js -p 上海市 --top 10 --out sh.txt   取前10 并写入文件
 * 定时执行交给系统调度(systemd timer / cron), 见 DEBIAN12.md
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-core');

// ---------- 配置 ----------
const PAGE_URL = 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html';

// 自动探测 Chromium/Chrome (Debian 12), 或用环境变量 CHROME_PATH 指定
function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',              // Debian 12: apt install chromium
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ].filter(Boolean);
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  throw new Error('未找到 Chromium/Chrome，请用环境变量 CHROME_PATH 指定浏览器路径');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 原子写: 先写 .tmp 再 rename, 定时任务中途被杀时下游不会读到半截文件
// (tmp 带 PID: 即使两个实例并发写同一输出文件也不互相踩)
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- 性能优化: 事件驱动等待 ----------
// 单次 evaluate 加超时: 页面 JS 阻塞(如解密死循环)时不至于让等待原语整体挂死,
// 超时或 evaluate 失败一律返回 undefined(视为条件未满足), 由上层轮询兜底。
async function evalWithTimeout(page, fn, arg, ms = 2000) {
  let timer;
  const bail = new Promise((r) => { timer = setTimeout(() => r(undefined), ms); timer.unref(); });
  const v = await Promise.race([page.evaluate(fn, arg).catch(() => undefined), bail]);
  clearTimeout(timer);
  return v;
}

// 轮询浏览器内条件 fn, 成立立即返回 true; 超时返回 false(不抛错, 上层兜底)。
// 替代固定 sleep 盲等: 页面快就快, 页面慢最多等到 timeout。
async function waitUntil(page, fn, arg, { timeout = 15000, poll = 300 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evalWithTimeout(page, fn, arg)) return true;
    await sleep(poll);
  }
  return false;
}

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const cfg = {
    provinces: [],
    nationwideOnly: false,
    localOnly: false,
    top: 8,
    out: null,
    json: false,
    listProvinces: false,
    headful: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-p': case '--province': cfg.provinces.push(next()); break;
      case '--nationwide-only': cfg.nationwideOnly = true; break;
      case '--local-only': cfg.localOnly = true; break;
      case '--top': cfg.top = parseInt(next(), 10) || 8; break;
      case '--out': cfg.out = next(); break;
      case '--json': cfg.json = true; break;
      case '--list-provinces': cfg.listProvinces = true; break;
      case '--headful': cfg.headful = true; break;
      case '-h': case '--help': cfg.help = true; break;
      default:
        if (!a.startsWith('-')) cfg.provinces.push(a); // 裸参数当作省份
    }
  }
  return cfg;
}

// ---------- 页面操作 ----------
// 拦截图片/字体/媒体请求: 数据全在加密 XHR 里, 这些资源只耗带宽和内存。
// 注意 stylesheet 必须放行——innerText 受 display:none 影响, 禁 CSS 会破坏抓取。
async function setupResourceBlocker(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType();
    if (t === 'image' || t === 'media' || t === 'font') req.abort().catch(() => {});
    else req.continue().catch(() => {});
  });
}

async function openPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await setupResourceBlocker(page);
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 等加密网关返回、SPA 渲染出省份入口/页签/卡片(替代 networkidle2 + 固定 6 秒盲等)
  await page.waitForSelector('.prov-entry', { timeout: 30000 }).catch(() => {});
  await waitUntil(page, () => !!document.querySelector('.range-tab'), null, { timeout: 20000, poll: 400 });
  await waitUntil(page, () => !!document.querySelector('.item-tips-list'), null, { timeout: 10000, poll: 400 });
  return page;
}

async function listProvinces(page) {
  await page.evaluate(() => { const e = document.querySelector('.prov-entry'); if (e) e.click(); });
  await page.waitForSelector('.select-item', { timeout: 8000 }).catch(() => {});
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('.select-item')].map((e) => (e.innerText || '').trim()).filter(Boolean)
  );
  // 关闭弹层
  await page.evaluate(() => { const e = document.querySelector('.prov-entry'); if (e) e.click(); });
  return [...new Set(names)];
}

async function selectProvince(page, name) {
  await page.evaluate(() => { const e = document.querySelector('.prov-entry'); if (e) e.click(); });
  await page.waitForSelector('.select-item', { timeout: 8000 }).catch(() => {});
  const ok = await page.evaluate((n) => {
    const t = [...document.querySelectorAll('.select-item')].find((e) => (e.innerText || '').trim() === n);
    if (t) { t.click(); return true; }
    return false;
  }, name);
  if (!ok) { // 没找到目标省, 关闭弹层
    await page.evaluate(() => { const e = document.querySelector('.prov-entry'); if (e) e.click(); });
    return false;
  }
  // 等切省生效: 省入口文本变为目标省且页签重新渲染(替代固定 6.5 秒盲等)
  await waitUntil(page, (n) => {
    const e = document.querySelector('.prov-entry');
    return !!e && (e.innerText || '').includes(n) && !!document.querySelector('.range-tab');
  }, name, { timeout: 20000, poll: 400 });
  await waitUntil(page, () => !!document.querySelector('.item-tips-list'), null, { timeout: 10000, poll: 400 });
  return true;
}

async function getRangeTabs(page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll('.range-tab')].map((e) => (e.innerText || '').trim()).filter(Boolean)
  );
}

async function clickRangeTab(page, label) {
  const clicked = await page.evaluate((lb) => {
    const t = [...document.querySelectorAll('.range-tab')].find((e) => (e.innerText || '').trim() === lb);
    if (t) { t.click(); return true; }
    return false;
  }, label);
  if (!clicked) return false;
  // 等该页签卡片渲染且数量稳定(替代固定 3.5 秒盲等)
  await waitCardsStable(page, { timeout: 12000 });
  return true;
}

// 等页面上卡片(.item-tips-list)数量连续 stable 次采样不变, 说明接口返回 + 渲染完成
async function waitCardsStable(page, { timeout = 12000, poll = 350, stable = 2 } = {}) {
  let last = -1, same = 0;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const n = (await evalWithTimeout(page, () => document.querySelectorAll('.item-tips-list').length)) || 0;
    if (n > 0 && n === last) { if (++same >= stable) return n; } else same = 0;
    last = n;
    await sleep(poll);
  }
  return last > 0 ? last : 0;
}

// 触发懒加载: 滚动到底, 但连续两轮卡片数不增长就提前停(替代固定 15 轮全滚)
async function fullScroll(page, maxRounds = 20) {
  await page.evaluate(async (maxRounds) => {
    let last = -1, same = 0;
    for (let i = 0; i < maxRounds; i++) {
      window.scrollBy(0, 2500);
      await new Promise((r) => setTimeout(r, 200));
      const n = document.querySelectorAll('.item-tips-list').length;
      if (n === last) { if (++same >= 2) break; } else same = 0;
      last = n;
    }
    window.scrollTo(0, 0);
  }, maxRounds);
  // 滚动触发的懒加载请求可能仍在途, 等增量卡片插入完成再返回, 避免漏抓最后一批
  await waitCardsStable(page, { timeout: 4000, poll: 300 });
}

async function scrapeCards(page, rangeLabel) {
  return await page.evaluate((rangeLabel) => {
    function grab(txt, label) {
      const re = new RegExp(label + '[:：]\\s*\\n?([^\\n]+)');
      const m = txt.match(re);
      return m ? m[1].trim() : '';
    }
    const tips = [...document.querySelectorAll('.item-tips-list')];
    const out = [];
    tips.forEach((tip) => {
      const txt = tip.innerText || '';
      let card = tip;
      for (let i = 0; i < 7 && card && card.parentElement; i++) {
        card = card.parentElement;
        if (card.querySelector && card.querySelector('.table-area')) break;
      }
      const tableTxt = (card && card.querySelector('.table-area')) ? card.querySelector('.table-area').innerText : '';
      let name = '';
      if (card) {
        const cand = card.querySelector('[class*=title],[class*=name],h3,h4');
        if (cand) name = (cand.innerText || '').trim().split('\n')[0];
      }
      out.push({
        rangeTab: rangeLabel,
        name,
        price: grab(txt, '资费标准'),
        code: grab(txt, '方案编号'),
        type: grab(txt, '资费类型'),
        scope: grab(txt, '适用范围'),
        region: grab(txt, '适用地区'),
        resources: tableTxt.replace(/\n+/g, ' ').trim(),
      });
    });
    return out;
  }, rangeLabel);
}

async function scrapeProvince(page, provName, cfg) {
  const ok = await selectProvince(page, provName);
  if (!ok) return { selected: false, cards: [] };

  const tabs = await getRangeTabs(page); // 例如 ['全网资费','江苏资费']
  let wanted = tabs;
  if (cfg.nationwideOnly) wanted = tabs.filter((t) => t.includes('全网'));
  if (cfg.localOnly) wanted = tabs.filter((t) => !t.includes('全网'));
  if (!wanted.length) wanted = tabs;

  const all = [];
  for (const tab of wanted) {
    if (!(await clickRangeTab(page, tab))) continue; // 内部已等渲染稳定
    await fullScroll(page);
    all.push(...(await scrapeCards(page, tab)));
  }
  const seen = new Set(); const uniq = [];
  for (const c of all) { const k = c.code + '|' + c.rangeTab; if (c.code && !seen.has(k)) { seen.add(k); uniq.push(c); } }
  return { selected: true, cards: uniq };
}

// ---------- 计算 ----------
function parsePrice(p) { const m = (p || '').match(/([\d.]+)\s*元\s*\/\s*月/); return m ? parseFloat(m[1]) : null; }
function parseGB(res) {
  if (!res) return null;
  const m = res.match(/国内通用流量\s*([\d.]+)\s*(TB|GB|MB)/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (m[2] === 'TB') v *= 1024;
  if (m[2] === 'MB') v /= 1024;
  return v;
}

// 流量包/附加包识别: 命中即为“非主资费”的叠加包/优惠活动，其余视为主套餐。
// 这类无法作为手机号主资费独立办理，需叠加在主套餐上或属充值/权益优惠。
const DATAPACK_RE = /流量包|流量活动|享流量|优惠购活动|新机体验|AI灵犀|融合包|预存|升档|全品类优惠|限时特惠|副卡|礼包|畅享包/;
// 分类: 'pack' 流量包/附加包 ; 'main' 主套餐
function classify(name) { return DATAPACK_RE.test(name || '') ? 'pack' : 'main'; }

function enrich(cards) {
  const rows = cards.map((c) => {
    const priceNum = parsePrice(c.price);
    const gb = parseGB(c.resources);
    return { ...c, priceNum, gb, perGB: (priceNum && gb) ? +(priceNum / gb).toFixed(3) : null, category: classify(c.name) };
  }).filter((r) => r.perGB !== null && r.priceNum > 0 && r.gb > 0);
  const seen = new Set(); const uniq = [];
  for (const r of rows) { if (!seen.has(r.code)) { seen.add(r.code); uniq.push(r); } }
  return uniq;
}

// ---------- 文本报告 ----------
function fmtList(rows, top) {
  return rows.slice(0, top).map((r, i) =>
    `  ${String(i + 1).padStart(2)}. ${String(r.perGB).padEnd(6)}元/GB | ${r.priceNum}元/月 ÷ ${r.gb}GB | [${r.rangeTab}] ${r.name} (${r.code})`
  ).join('\n');
}

// 计算字符串显示宽度(中文/全角算2列)
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) { w += /[\u2E80-\uFFFF]/.test(ch) ? 2 : 1; }
  return w;
}
// 按显示宽度右侧补空格
function padDisp(s, width) {
  s = String(s);
  const pad = width - dispWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/**
 * 生成多省单价对比表。
 * 对每个省分别取「长期套餐」和「活动/合约」的最低单价及对应套餐，横向并排。
 */
function buildCompareTable(perProvince) {
  const valid = perProvince.filter((p) => p.selected && p.all.length);
  if (valid.length < 2) return ''; // 少于2省无需对比

  // 每省汇总指标
  const stats = valid.map(({ province, all }) => {
    const pkg = all.filter((r) => r.category === 'main').sort((a, b) => a.perGB - b.perGB);
    const promo = all.filter((r) => r.category === 'pack').sort((a, b) => a.perGB - b.perGB);
    return {
      province,
      count: all.length,
      mainCount: pkg.length,
      packCount: promo.length,
      pkgBest: pkg[0] || null,
      promoBest: promo[0] || null,
      overall: pkg[0] || all.slice().sort((a, b) => a.perGB - b.perGB)[0], // 以主套餐为准
    };
  });

  const cell = (r) => r ? `${r.perGB}元/GB (${r.priceNum}元/${r.gb}GB)` : '无';
  const cellName = (r) => r ? `${r.name} (${r.code})` : '—';

  const rowsSpec = [
    ['主套餐数', (s) => String(s.mainCount)],
    ['流量包数', (s) => String(s.packCount)],
    ['主套餐·最低单价', (s) => cell(s.pkgBest)],
    ['  └ 套餐', (s) => cellName(s.pkgBest)],
    ['流量包·最低单价', (s) => cell(s.promoBest)],
    ['  └ 套餐', (s) => cellName(s.promoBest)],
  ];

  // 计算各列宽度
  const labelW = Math.max(...rowsSpec.map((r) => dispWidth(r[0])), dispWidth('指标'));
  const colW = stats.map((s) =>
    Math.max(dispWidth(s.province), ...rowsSpec.map((r) => dispWidth(r[1](s))))
  );

  const sep = '+' + '-'.repeat(labelW + 2) + stats.map((_, i) => '+' + '-'.repeat(colW[i] + 2)).join('') + '+';
  const line = (label, cells) =>
    '| ' + padDisp(label, labelW) + ' ' + cells.map((c, i) => '| ' + padDisp(c, colW[i]) + ' ').join('') + '|';

  const out = [];
  out.push('');
  out.push('══════════ 两省单价对比表 ══════════');
  out.push(sep);
  out.push(line('指标', stats.map((s) => s.province)));
  out.push(sep);
  for (const [label, fn] of rowsSpec) out.push(line(label, stats.map((s) => fn(s))));
  out.push(sep);

  // 结论行: 谁的全场最低单价更便宜
  const sorted = stats.slice().sort((a, b) => a.overall.perGB - b.overall.perGB);
  const cheapest = sorted[0], dearest = sorted[sorted.length - 1];
  const ratio = (dearest.overall.perGB / cheapest.overall.perGB).toFixed(1);
  out.push(`>> 结论: 主套餐单价 ${cheapest.province} 最低 ${cheapest.overall.perGB}元/GB，比 ${dearest.province}(${dearest.overall.perGB}元/GB) 便宜约 ${ratio} 倍`);
  return out.join('\n');
}

function buildReport(perProvince, cfg) {
  const lines = [];
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  lines.push('='.repeat(72));
  lines.push(`中国移动资费公示 · 每GB单价查询报告   ${stamp}`);
  lines.push(`筛选: ${cfg.nationwideOnly ? '仅全网资费' : cfg.localOnly ? '仅本省资费' : '全网+本省'} | Top ${cfg.top} | 单价按国内通用流量计`);
  lines.push('='.repeat(72));

  for (const { province, selected, all } of perProvince) {
    lines.push('');
    lines.push(`########## ${province} ##########`);
    if (!selected) { lines.push('  [失败] 未能选中该省，请用 --list-provinces 核对名称'); continue; }
    if (!all.length) { lines.push('  [空] 未解析到含通用流量的套餐'); continue; }

    const pkg = all.filter((r) => r.category === 'main').sort((a, b) => a.perGB - b.perGB);
    const promo = all.filter((r) => r.category === 'pack').sort((a, b) => a.perGB - b.perGB);

    lines.push(`\n--- 主套餐 最便宜 ${cfg.top} ---`);
    lines.push(pkg.length ? fmtList(pkg, cfg.top) : '  (无)');
    lines.push(`\n--- 流量包/附加包 最便宜 ${cfg.top} ---`);
    lines.push(promo.length ? fmtList(promo, cfg.top) : '  (无)');

    const best = pkg[0] || all.slice().sort((a, b) => a.perGB - b.perGB)[0];
    lines.push(`\n>> 主套餐最低单价: ${best.perGB}元/GB (${best.name} ${best.code}, ${best.priceNum}元/${best.gb}GB)`);
  }

  // 多省时追加对比表(默认开启; 单省无意义)
  if (perProvince.filter((p) => p.selected && p.all.length).length >= 2) {
    const table = buildCompareTable(perProvince);
    if (table) { lines.push(''); lines.push(table); }
  }

  lines.push('');
  lines.push('='.repeat(72));
  return lines.join('\n');
}

// ---------- 主流程 ----------
// Chrome 启动参数面向无显示器的 Debian 服务器调优:
//  - disable-dev-shm-usage: 服务器 /dev/shm 常只有 64M, 不加极易崩页/崩溃
//  - user-data-dir 带 PID 指到系统临时目录: 并发实例不共用 profile(会锁冲突),
//    用完即删(见 runOnce), 不在 tmp 留垃圾
const PROFILE_DIR = path.join(os.tmpdir(), `tariff-chrome-${process.pid}`);

function buildLaunchArgs() {
  return [
    '--no-sandbox', // 以非特权专用用户运行时, 可删除此行启用 Chromium 自带沙箱
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--no-first-run',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1400,900',
    `--user-data-dir=${PROFILE_DIR}`,
  ];
}

async function runOnce(cfg) {
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: !cfg.headful,
    args: buildLaunchArgs(),
  });
  try {
    const page = await openPage(browser);

    if (cfg.listProvinces) {
      const provs = await listProvinces(page);
      console.log('可选省份 (' + provs.length + '):\n' + provs.map((p) => '  ' + p).join('\n'));
      return;
    }

    const perProvince = [];
    for (const prov of cfg.provinces) {
      const { selected, cards } = await scrapeProvince(page, prov, cfg);
      perProvince.push({ province: prov, selected, all: enrich(cards), raw: cards });
    }

    const report = buildReport(perProvince, cfg);
    console.log(report);

    if (cfg.out) {
      writeFileAtomic(cfg.out, report + '\n');
      console.log(`\n[已写入] ${path.resolve(cfg.out)}`);
    }
    if (cfg.json) {
      const jsonPath = (cfg.out ? cfg.out.replace(/\.\w+$/, '') : 'tariff') + '.json';
      writeFileAtomic(jsonPath, JSON.stringify(perProvince.map(({ province, selected, all }) => ({ province, selected, plans: all })), null, 2) + '\n');
      console.log(`[已写入] ${path.resolve(jsonPath)}`);
    }
  } finally {
    await browser.close();
    // maxRetries: Windows 上 Crashpad 子进程可能短暂占用文件; Linux 下无影响
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  }
}

const HELP = `中国移动资费公示 · 每GB单价查询脚本

用法:
  node tariff-query.js --list-provinces
  node tariff-query.js -p 上海市 [-p 江苏省 ...] [选项]

选项:
  -p, --province <名>   要查询的省份(可多次)。名称须与页面一致(如 上海市/江苏省)
  --nationwide-only     只看「全网资费」页签
  --local-only          只看本省资费页签
  --top <n>             每类列出前 n 条 (默认 8)
  --out <file>          文本报告写入文件
  --json                同时导出结构化 JSON
  --list-provinces      列出所有可选省份名后退出
  --headful             显示浏览器窗口(默认无头)
  -h, --help            帮助

环境变量:
  TARIFF_PROVINCES      空格分隔的省份列表, 作为 -p 的默认值(供 systemd/cron 部署用)
                       例: TARIFF_PROVINCES="上海市 江苏省" node tariff-query.js

示例:
  node tariff-query.js -p 上海市 -p 江苏省 --top 10 --out report.txt --json
  TARIFF_PROVINCES="上海市 江苏省" node tariff-query.js --out report.txt`;

// 单次抓取看门狗: 页面异常挂死时及时失败, 不占住 systemd/cron 的槽位
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`看门狗超时(${label}): ${Math.round(ms / 60000)} 分钟`)), ms);
    timer.unref(); // 不阻止进程正常退出
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 失败自动重试(共 attempts 次), 全部失败则以非零码退出, 让 systemd/cron 感知
async function runWithRetry(cfg, attempts = 2) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await withTimeout(runOnce(cfg), RUN_TIMEOUT_MS, '单次抓取');
      return;
    } catch (e) {
      const canRetry = i < attempts;
      console.error(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] 第 ${i}/${attempts} 次执行失败: ${e.message}${canRetry ? '，5 秒后重试' : ''}`);
      if (canRetry) await sleep(5000);
      else process.exitCode = 1;
    }
  }
}

(async () => {
  const cfg = parseArgs(process.argv);
  if (cfg.help) { console.log(HELP); return; }
  // 环境变量兜底: systemd/cron 部署时用 TARIFF_PROVINCES="上海市 江苏省" 代替命令行 -p
  if (!cfg.listProvinces && !cfg.provinces.length) {
    const envProv = (process.env.TARIFF_PROVINCES || '').trim();
    if (envProv) cfg.provinces = envProv.split(/\s+/);
  }
  if (!cfg.listProvinces && !cfg.provinces.length) {
    console.log('缺少 --province。先跑 `node tariff-query.js --list-provinces` 查省份名，或设置环境变量 TARIFF_PROVINCES。\n');
    console.log(HELP);
    process.exitCode = 2;
    return;
  }

  // systemd 停止服务时会发 SIGTERM, 及时退出避免拖延到被 SIGKILL
  process.on('SIGTERM', () => {
    console.error('[SIGTERM] 收到终止信号, 退出。');
    process.exit(143);
  });

  await runWithRetry(cfg);
})();
