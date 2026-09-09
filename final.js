const puppeteer = require('puppeteer-core');
const fs = require('fs');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function selectProvince(page, name) {
  await page.evaluate(() => { const e=document.querySelector('.prov-entry'); if(e)e.click(); });
  await sleep(1500);
  const ok = await page.evaluate((n) => {
    const t = [...document.querySelectorAll('.select-item')].find(e => (e.innerText||'').trim() === n);
    if (t) { t.click(); return true; } return false;
  }, name);
  await sleep(6500);
  return ok;
}

async function clickRangeTab(page, label) {
  return await page.evaluate((lb) => {
    const t = [...document.querySelectorAll('.range-tab')].find(e => (e.innerText||'').trim() === lb);
    if (t) { t.click(); return true; } return false;
  }, label);
}

async function scrapeCards(page, rangeLabel) {
  return await page.evaluate((rangeLabel) => {
    function grab(txt, label) {
      const re = new RegExp(label + '[:：]\\s*\\n?([^\\n]+)');
      const m = txt.match(re); return m ? m[1].trim() : '';
    }
    const tips = [...document.querySelectorAll('.item-tips-list')];
    const results = [];
    tips.forEach((tip) => {
      const txt = tip.innerText || '';
      let card = tip;
      for (let i=0;i<7 && card && card.parentElement;i++){ card = card.parentElement; if(card.querySelector && card.querySelector('.table-area')) break; }
      const tableTxt = (card && card.querySelector('.table-area')) ? card.querySelector('.table-area').innerText : '';
      let name = '';
      if (card) {
        const cand = card.querySelector('[class*=title],[class*=name],h3,h4');
        if (cand) name = (cand.innerText||'').trim().split('\n')[0];
      }
      results.push({
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
    return results;
  }, rangeLabel);
}

async function fullScroll(page) {
  await page.evaluate(async () => { for(let i=0;i<15;i++){ window.scrollBy(0, 2500); await new Promise(r=>setTimeout(r,250)); } window.scrollTo(0,0); });
  await sleep(1500);
}

async function scrapeProvince(page, provName, localTabLabel) {
  const ok = await selectProvince(page, provName);
  const all = [];
  // range tabs: 全网资费 + local
  for (const tab of ['全网资费', localTabLabel]) {
    const clicked = await clickRangeTab(page, tab);
    if (!clicked) continue;
    await sleep(3500);
    await fullScroll(page);
    const cards = await scrapeCards(page, tab);
    all.push(...cards);
  }
  // dedupe by code+rangeTab
  const seen = new Set(); const out=[];
  for (const c of all){ const k=c.code+'|'+c.rangeTab; if(c.code && !seen.has(k)){seen.add(k); out.push(c);} }
  return { selected: ok, cards: out };
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1400,900'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log('goto:', e.message));
  await sleep(6000);

  const sh = await scrapeProvince(page, '上海市', '上海资费');
  console.log('Shanghai:', sh.selected, 'cards:', sh.cards.length);
  fs.writeFileSync('shanghai_full.json', JSON.stringify(sh.cards, null, 2));

  const js = await scrapeProvince(page, '江苏省', '江苏资费');
  console.log('Jiangsu:', js.selected, 'cards:', js.cards.length);
  fs.writeFileSync('jiangsu_full.json', JSON.stringify(js.cards, null, 2));

  await browser.close();
  console.log('DONE');
})();
