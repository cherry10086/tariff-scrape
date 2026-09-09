const fs = require('fs');
function parsePrice(p){const m=(p||'').match(/([\d.]+)\s*元\s*\/\s*月/);return m?parseFloat(m[1]):null;}
function parseGB(res){if(!res)return null;const m=res.match(/国内通用流量\s*([\d.]+)\s*(TB|GB|MB)/);if(!m)return null;let v=parseFloat(m[1]);if(m[2]==='TB')v*=1024;if(m[2]==='MB')v/=1024;return v;}
function isPromo(n){return /活动|优惠|合约|特惠|享流量|加享|签约|专属卡|号卡/.test(n||'');}

function load(f){
  const d=JSON.parse(fs.readFileSync(f,'utf8'));
  const rows=d.map(x=>{const price=parsePrice(x.price),gb=parseGB(x.resources);return{...x,priceNum:price,gb,perGB:(price&&gb)?+(price/gb).toFixed(3):null};})
    .filter(r=>r.perGB!==null&&r.priceNum>0&&r.gb>0);
  const seen=new Set(),u=[];for(const r of rows){if(!seen.has(r.code)){seen.add(r.code);u.push(r);}}
  return u;
}
function show(u,tag){
  const pkg=u.filter(r=>!isPromo(r.name)).sort((a,b)=>a.perGB-b.perGB);
  const promo=u.filter(r=>isPromo(r.name)).sort((a,b)=>a.perGB-b.perGB);
  console.log(`\n########## ${tag} ##########`);
  console.log(`\n--- 长期套餐(非活动/合约) cheapest 6 ---`);
  pkg.slice(0,6).forEach((r,i)=>console.log(`${i+1}. ${r.perGB}元/GB | ${r.priceNum}元/月÷${r.gb}GB | [${r.rangeTab}] ${r.name} (${r.code})`));
  console.log(`\n--- 活动/优惠/合约 cheapest 6 ---`);
  promo.slice(0,6).forEach((r,i)=>console.log(`${i+1}. ${r.perGB}元/GB | ${r.priceNum}元/月÷${r.gb}GB | [${r.rangeTab}] ${r.name} (${r.code})`));
}
show(load('shanghai_full.json'),'上海移动');
show(load('jiangsu_full.json'),'江苏(苏州)移动');
