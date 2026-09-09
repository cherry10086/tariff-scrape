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
 * 依赖: puppeteer-core + 本机 Chrome
 *
 * 用法示例:
 *   node tariff-query.js --list-provinces                 列出所有可选省份名
 *   node tariff-query.js --province 上海市                 查上海(全网+本省)
 *   node tariff-query.js -p 上海市 -p 江苏省               同时查多个省
 *   node tariff-query.js -p 江苏省 --local-only            只看本省页签
 *   node tariff-query.js -p 上海市 --nationwide-only       只看全网页签
 *   node tariff-query.js -p 上海市 --top 10 --out sh.txt   取前10 并写入文件
 *   node tariff-query.js -p 上海市 -p 江苏省 --watch       每12小时循环执行
 *   node tariff-query.js -p 上海市 --watch --interval 6    改为每6小时
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

// ---------- 配置 ----------
const PAGE_URL = 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html';

// 自动探测本机 Chrome / Edge 路径
function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  throw new Error('未找到 Chrome/Edge，请用环境变量 CHROME_PATH 指定浏览器路径');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const cfg = {
    provinces: [],
    nationwideOnly: false,
    localOnly: false,
    top: 8,
    out: null,
    json: false,
    watch: false,
    interval: 12,           // 小时
    listProvinces: false,
    headful: false,
    compare: false,
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
      case '--watch': cfg.watch = true; break;
      case '--interval': cfg.interval = parseFloat(next()) || 12; break;
      case '--compare': cfg.compare = true; break;
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
async function openPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(PAGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(6000); // 等 SPA 首屏渲染
  return page;
}

async function listProvinces(page) {
  await page.evaluate(() => { const e = document.querySelector('.prov-entry'); if (e) e.click(); });
  await sleep(1500);
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('.select-item')].map((e) => (e.innerText || '').trim()).filter(Boolean)
  );
  // 关闭弹层
  await page.evaluate(() => { const e = document.querySelector('.prov-entry'); if (e) e.click(); });
  return [...new Set(names)];
}

async function selectProvince(page, name) {
  await page.evaluate(() => { const e = document.querySelector('.prov-entry'); if (e) e.click(); });
  await sleep(1500);
  const ok = await page.evaluate((n) => {
    const t = [...document.querySelectorAll('.select-item')].find((e) => (e.innerText || '').trim() === n);
    if (t) { t.click(); return true; }
    return false;
  }, name);
  await sleep(6500); // 等切省后接口返回 + 渲染
  return ok;
}

async function getRangeTabs(page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll('.range-tab')].map((e) => (e.innerText || '').trim()).filter(Boolean)
  );
}

async function clickRangeTab(page, label) {
  return await page.evaluate((lb) => {
    const t = [...document.querySelectorAll('.range-tab')].find((e) => (e.innerText || '').trim() === lb);
    if (t) { t.click(); return true; }
    return false;
  }, label);
}

async function fullScroll(page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 15; i++) { window.scrollBy(0, 2500); await new Promise((r) => setTimeout(r, 250)); }
    window.scrollTo(0, 0);
  });
  await sleep(1200);
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
    if (!(await clickRangeTab(page, tab))) continue;
    await sleep(3500);
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
async function runOnce(cfg) {
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: cfg.headful ? false : 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1400,900'],
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
      fs.writeFileSync(cfg.out, report + '\n', 'utf8');
      console.log(`\n[已写入] ${path.resolve(cfg.out)}`);
    }
    if (cfg.json) {
      const jsonPath = (cfg.out ? cfg.out.replace(/\.\w+$/, '') : 'tariff') + '.json';
      fs.writeFileSync(jsonPath, JSON.stringify(perProvince.map(({ province, selected, all }) => ({ province, selected, plans: all })), null, 2), 'utf8');
      console.log(`[已写入] ${path.resolve(jsonPath)}`);
    }
  } finally {
    await browser.close();
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
  --watch               常驻循环，每隔 interval 小时跑一次
  --interval <小时>     配合 --watch，默认 12
  --compare             多省对比表(查询≥2省时默认已附带)
  --list-provinces      列出所有可选省份名后退出
  --headful             显示浏览器窗口(默认无头)
  -h, --help            帮助

示例:
  node tariff-query.js -p 上海市 -p 江苏省 --top 10 --out report.txt --json
  node tariff-query.js -p 上海市 --watch --interval 12`;

(async () => {
  const cfg = parseArgs(process.argv);
  if (cfg.help) { console.log(HELP); return; }
  if (!cfg.listProvinces && !cfg.provinces.length) {
    console.log('缺少 --province。先跑 `node tariff-query.js --list-provinces` 查省份名。\n');
    console.log(HELP);
    return;
  }

  if (cfg.watch && !cfg.listProvinces) {
    const ms = cfg.interval * 3600 * 1000;
    console.log(`[watch] 每 ${cfg.interval} 小时执行一次，Ctrl+C 停止。`);
    const tick = async () => {
      try { await runOnce(cfg); }
      catch (e) { console.error(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] 执行出错:`, e.message); }
      console.log(`\n[watch] 下次执行: ${new Date(Date.now() + ms).toLocaleString('zh-CN', { hour12: false })}\n`);
    };
    await tick();
    setInterval(tick, ms);
  } else {
    await runOnce(cfg);
  }
})();
