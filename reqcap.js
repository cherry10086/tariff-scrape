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

  const reqs = [];
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (/getTariffListInfo|getStandardlist|getType2List|contact\/list|SeriesName/.test(r.url())) {
      reqs.push({ url: r.url(), method: r.method(), headers: r.headers(), postData: r.postData() });
    }
    r.continue();
  });

  await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log('goto:', e.message));
  await new Promise(r => setTimeout(r, 7000));

  fs.writeFileSync('reqs.json', JSON.stringify(reqs, null, 2));
  console.log('=== CAPTURED REQUESTS:', reqs.length, '===');
  for (const q of reqs) {
    console.log('\n---', q.method, q.url);
    console.log('postData:', q.postData ? q.postData.slice(0, 800) : '(none)');
  }

  // Try to find province/city selector data in the app
  const regionData = await page.evaluate(() => {
    // scan window / vue for province lists
    const out = {};
    try {
      const html = document.querySelector('#app') ? document.querySelector('#app').innerHTML : '';
      out.hasApp = !!html;
    } catch (e) {}
    return out;
  });
  console.log('\nregion:', JSON.stringify(regionData));
  await browser.close();
})();
