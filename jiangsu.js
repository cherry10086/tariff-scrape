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
  await sleep(6000);
  return ok;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1400,900'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log('goto:', e.message));
  await sleep(6000);

  const okJS = await selectProvince(page, '江苏省');
  console.log('selected 江苏省:', okJS);
  await sleep(1000);

  // Look for any city selector / secondary region entry & the "适用地区/苏州" clues
  const probe = await page.evaluate(() => {
    const out = {};
    out.label = (document.querySelector('.provinceName')||{}).innerText || '';
    // any element mentioning 市 selectable near top (city entry)
    const cityish = [...document.querySelectorAll('[class*=city],[class*=City]')].map(e => ({cls:e.className, text:(e.innerText||'').slice(0,30)})).slice(0,20);
    out.cityish = cityish;
    // tabs like 江苏资费
    const tabs = [...document.querySelectorAll('[class*=tab]')].map(e=>({cls:e.className,text:(e.innerText||'').slice(0,60)})).slice(0,15);
    out.tabs = tabs;
    // count cards
    out.cardCount = document.querySelectorAll('.item-tips-list').length;
    // does any card region mention 苏州?
    const suzhou = [...document.querySelectorAll('.item-tips-list')].filter(e=>/苏州/.test(e.innerText||'')).length;
    out.suzhouMentions = suzhou;
    return out;
  });
  console.log(JSON.stringify(probe, null, 2));
  await browser.close();
})();
