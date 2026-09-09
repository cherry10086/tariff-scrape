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
  await new Promise(r => setTimeout(r, 7000));

  // Dump structural skeleton: classes and the region selector
  const struct = await page.evaluate(() => {
    const pick = (el) => ({
      tag: el.tagName, cls: el.className, id: el.id,
      text: (el.innerText || '').slice(0, 40)
    });
    // region header area - top-left elements
    const clickable = [...document.querySelectorAll('[class*=city],[class*=area],[class*=province],[class*=region],[class*=addr]')].slice(0, 30).map(pick);
    // count plan cards - look for repeated structures containing 元/月
    const all = [...document.querySelectorAll('div,li,section')];
    const cards = all.filter(e => /方案编号|资费标准/.test(e.innerText || '') && (e.innerText||'').length < 2500);
    // find the tightest card wrapper class
    const cardClasses = {};
    cards.forEach(c => { cardClasses[c.className] = (cardClasses[c.className]||0)+1; });
    return { clickable, cardClassCounts: cardClasses, cardSample: cards.length ? cards[cards.length-1].outerHTML.slice(0,1200) : '' };
  });
  fs.writeFileSync('struct.json', JSON.stringify(struct, null, 2));
  console.log('CLICKABLE region els:');
  console.log(JSON.stringify(struct.clickable, null, 2));
  console.log('\nCARD CLASS COUNTS:');
  console.log(JSON.stringify(struct.cardClassCounts, null, 2));
  await browser.close();
})();
