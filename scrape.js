const puppeteer = require('puppeteer-core');
const fs = require('fs');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function selectProvince(page, name) {
  await page.evaluate(() => { const e=document.querySelector('.prov-entry'); if(e)e.click(); });
  await sleep(1500);
  const ok = await page.evaluate((n) => {
    const items = [...document.querySelectorAll('.select-item')];
    const t = items.find(e => (e.innerText||'').trim() === n);
    if (t) { t.click(); return true; }
    return false;
  }, name);
  await sleep(6000); // wait for reload of list
  return ok;
}

// scrape all plan cards currently rendered
async function scrapeCards(page) {
  return await page.evaluate(() => {
    function grab(txt, label) {
      // txt is multiline "label:\nvalue"
      const re = new RegExp(label + '[:：]\\s*\\n?([^\\n]+)');
      const m = txt.match(re);
      return m ? m[1].trim() : '';
    }
    // Each plan: a name header + item-tips-list + table-area (resources)
    const tips = [...document.querySelectorAll('.item-tips-list')];
    const results = [];
    tips.forEach((tip) => {
      const txt = tip.innerText || '';
      // resource block: walk up to a common card container to find table-area
      let card = tip;
      for (let i=0;i<6 && card && card.parentElement;i++){ card = card.parentElement; if(card.querySelector && card.querySelector('.table-area')) break; }
      const tableTxt = (card && card.querySelector('.table-area')) ? card.querySelector('.table-area').innerText : '';
      // plan name: nearest preceding heading text within card
      let name = '';
      if (card) {
        const cand = card.querySelector('[class*=title],[class*=name],h3,h4,.card-title');
        if (cand) name = (cand.innerText||'').trim().split('\n')[0];
      }
      results.push({
        name,
        price: grab(txt, '资费标准'),
        code: grab(txt, '方案编号'),
        type: grab(txt, '资费类型'),
        scope: grab(txt, '适用范围'),
        region: grab(txt, '适用地区'),
        onDate: grab(txt, '上线日期'),
        resources: tableTxt.replace(/\n+/g, ' ').trim(),
      });
    });
    return results;
  });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log('goto:', e.message));
  await sleep(6000);

  // select Shanghai
  const okSH = await selectProvince(page, '上海市');
  console.log('selected 上海市:', okSH);
  // scroll to load all cards (lazy?)
  await page.evaluate(async () => { for(let i=0;i<10;i++){ window.scrollBy(0, 2000); await new Promise(r=>setTimeout(r,300)); } });
  await sleep(2000);
  const sh = await scrapeCards(page);
  console.log('SH cards:', sh.length);
  fs.writeFileSync('shanghai.json', JSON.stringify(sh, null, 2));

  // check current region label
  const label = await page.evaluate(() => (document.querySelector('.provinceName')||{}).innerText || '');
  console.log('current label:', label);

  console.log('SAMPLE SH:', JSON.stringify(sh.slice(0,3), null, 2));
  await browser.close();
})();
