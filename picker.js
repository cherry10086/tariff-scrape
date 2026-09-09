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

  // click the province switch
  await page.evaluate(() => {
    const el = document.querySelector('.province-switch') || document.querySelector('.province-name');
    if (el) el.click();
  });
  await new Promise(r => setTimeout(r, 2500));

  const picker = await page.evaluate(() => {
    // capture any popup/list that appeared
    const candidates = [...document.querySelectorAll('[class*=popup],[class*=picker],[class*=dialog],[class*=modal],[class*=list],[class*=drawer],[class*=select]')];
    const visible = candidates.filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 50 && r.height > 30;
    }).map(e => ({ cls: e.className, text: (e.innerText||'').slice(0, 400) }));
    // also grab all short text spans that look like province names
    const provinceLike = [...document.querySelectorAll('span,li,div,p,a')]
      .filter(e => { const t=(e.innerText||'').trim(); return /^(北京|上海|天津|重庆|江苏|浙江|广东|山东|苏州|南京)/.test(t) && t.length<=6; })
      .map(e => ({ tag:e.tagName, cls:e.className, text:(e.innerText||'').trim() }));
    return { visible, provinceLike: provinceLike.slice(0,40) };
  });
  fs.writeFileSync('picker.json', JSON.stringify(picker, null, 2));
  console.log('VISIBLE POPUPS:', JSON.stringify(picker.visible, null, 2).slice(0, 3000));
  console.log('\nPROVINCE-LIKE:', JSON.stringify(picker.provinceLike, null, 2).slice(0,2000));
  await browser.close();
})();
