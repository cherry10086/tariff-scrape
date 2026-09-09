const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const hits = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (/tariffZone|tariff|Tariff|getStandardlist/.test(url)) {
      let body = null;
      try { body = await resp.text(); } catch (e) {}
      hits.push({ url, status: resp.status(), len: body ? body.length : 0, body });
      console.log('[HIT]', resp.status(), url, body ? body.length : 0);
    }
  });
  page.on('console', (m) => { /* silence */ });

  await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log('goto:', e.message));
  // let SPA settle / fire its calls
  await new Promise(r => setTimeout(r, 8000));

  // dump page text to understand province/city UI
  const info = await page.evaluate(() => {
    const txt = document.body ? document.body.innerText.slice(0, 3000) : '';
    return { title: document.title, txt };
  });
  console.log('=== PAGE TITLE ===', info.title);
  console.log('=== PAGE TEXT (head) ===\n', info.txt);

  console.log('\n=== TOTAL HITS:', hits.length, '===');
  const fs = require('fs');
  fs.writeFileSync('hits.json', JSON.stringify(hits, null, 2));
  await browser.close();
})();
