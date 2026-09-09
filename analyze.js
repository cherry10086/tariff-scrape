const fs = require('fs');

function parsePrice(p) {
  // "99元/月" -> 99 ; "预存..." etc -> null
  const m = (p||'').match(/([\d.]+)\s*元\s*\/\s*月/);
  if (m) return parseFloat(m[1]);
  const m2 = (p||'').match(/^([\d.]+)\s*元/); // fallback
  return m2 ? parseFloat(m2[1]) : null;
}
function parseGeneralGB(res) {
  // resources string: "... 国内通用流量 40GB ..." ; handle TB, GB, MB
  if (!res) return null;
  const m = res.match(/国内通用流量\s*([\d.]+)\s*(TB|GB|MB)/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  const u = m[2];
  if (u === 'TB') v *= 1024;
  if (u === 'MB') v /= 1024;
  return v;
}

function analyze(file, tag) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = data.map(d => {
    const price = parsePrice(d.price);
    const gb = parseGeneralGB(d.resources);
    return { ...d, priceNum: price, gb, perGB: (price && gb) ? +(price/gb).toFixed(3) : null };
  }).filter(r => r.perGB !== null && r.priceNum > 0 && r.gb > 0);

  // dedupe by code (keep first)
  const seen = new Set(); const uniq = [];
  for (const r of rows){ if(!seen.has(r.code)){ seen.add(r.code); uniq.push(r);} }

  uniq.sort((a,b)=>a.perGB-b.perGB);
  console.log(`\n===== ${tag} =====  qualifying plans: ${uniq.length}`);
  console.log('--- Cheapest 8 by ¥/GB (general traffic) ---');
  uniq.slice(0,8).forEach((r,i)=>{
    console.log(`${i+1}. ${r.perGB} 元/GB | ${r.priceNum}元/月 ÷ ${r.gb}GB | [${r.rangeTab}] ${r.name} (${r.code}) 适用:${r.region}`);
  });
  return uniq;
}

const sh = analyze('shanghai_full.json', '上海移动');
const js = analyze('jiangsu_full.json', '江苏/苏州移动');

fs.writeFileSync('analysis.json', JSON.stringify({ shanghai: sh, jiangsu: js }, null, 2));
