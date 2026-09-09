const puppeteer = require('puppeteer-core');
const fs = require('fs');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log('goto:', e.message));
  await new Promise(r => setTimeout(r, 6000));

  const clicked = await page.evaluate(() => {
    const el = document.querySelector('.prov-entry');
    if (el) { el.click(); return true; }
    return false;
  });
  console.log('clicked prov-entry:', clicked);
  await new Promise(r => setTimeout(r, 2500));

  const list = await page.evaluate(() => {
    // find province name items now visible
    const items = [...document.querySelectorAll('*')].filter(e => {
      const t = (e.childNodes.length===1 && e.childNodes[0].nodeType===3) ? (e.innerText||'').trim() : '';
      return /^(上海|江苏|北京|浙江|广东)$|市$|省$/.test(t) && t.length<=6;
    }).map(e => ({ tag:e.tagName, cls:e.className, text:(e.innerText||'').trim() }));
    // dedupe
    const seen = new Set(); const out=[];
    for (const it of items){ const k=it.text+it.cls; if(!seen.has(k)){seen.add(k); out.push(it);} }
    return out.slice(0, 60);
  });
  fs.writeFileSync('provlist.json', JSON.stringify(list, null, 2));
  console.log('PROVINCE ITEMS:', JSON.stringify(list, null, 2).slice(0, 3500));
  await browser.close();
})();
