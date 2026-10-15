const test = require('node:test');
const assert = require('node:assert/strict');
const { project, reconstructRange, fee, createClient, MAX_SAMPLING_ERROR } = require('../projection.js');
const start=1792065600000;
test('HL 72 hourly settlement records confirm the one-eighth formula and rate units',()=>{for(const r of require('./fixtures/hl-settlements.json'))assert.ok(Math.abs(fee(Number(r.premium),{interest:.0001,divisor:8,floor:-.04,cap:.04})-Number(r.fundingRate))<=5.0001e-11);});
test('43 independent official settlements fall inside the OHLC sampling envelope',()=>{
 const fixtures=require('./fixtures/approximate-settlements.json');assert.equal(fixtures.length,43);
 for(const f of fixtures){const rows=f.rows.map(r=>({t:+r[0],p:r.slice(1,5).map(Number).reduce((a,b)=>a+b)/4,close:+r[4],low:+r[3],high:+r[2],...(f.exchange==='bitget'?{}:{count:+r[8]})}));const [lo,hi]=reconstructRange(f.config,rows);const rounding=f.exchange==='bitget'?0.0000005:0.000000005;assert.ok(f.actual>=lo-rounding&&f.actual<=hi+rounding,`${f.exchange} ${f.coin} ${f.config.end}`);}
});
test('sampling envelope contains arbitrary 5-second paths; broad uncertainty emits a range',()=>{
 for(const equal of [true,false]){
 const c={start,end:start+3600000,hours:1,samples:12,equal,interest:.0001,divisor:8,floor:-.04,cap:.04,bounded:true};let sum=0,weight=0;
 const rows=Array.from({length:30},(_,i)=>{const v=Array.from({length:12},(_,j)=>.02*Math.sin(i*13+j));v.forEach((p,j)=>{const w=equal?1:i*12+j+1;sum+=w*p;weight+=w;});const low=Math.min(...v),high=Math.max(...v);return {t:start+i*60000,p:(v[0]+low+high+v[11])/4,low,high,close:v[11],count:12};});
 const r=project(c,rows,start+30*60000),n=720,total=equal?n:n*(n+1)/2;
 const truth=fee((sum+rows.at(-1).close*(total-weight))/total,c);
 assert.ok(truth>=r.lower&&truth<=r.upper);assert.equal(r.rangeOnly,true);assert.ok(r.samplingError>MAX_SAMPLING_ERROR);
 const flat=rows.map(r=>({...r,p:.001,low:.001,high:.001,close:.001}));assert.equal(project(c,flat,start+30*60000).rangeOnly,false);
 }
});
function hlHarness({stamp=start,settled=start,rate='-.004',interval=1}={}){
 let calls=[];const q=createClient(async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);const data=body.type==='metaAndAssetCtxs'?[{universe:[{name:'BLUR'}]},[]]:body.type==='predictedFundings'?[['BLUR',[['BinPerp',{fundingRate:'-.03',nextFundingTime:start+28800000}],['HlPerp',{fundingRate:rate,nextFundingTime:stamp,fundingIntervalHours:interval}]]]]:[{coin:'BLUR',time:settled+34}];return {ok:true,json:async()=>data};},()=>start+1800000,async()=>{});return {q,calls};
}
test('HL uses its own hourly prediction without double dividing, validates a lagging boundary with settlement',async()=>{const h=hlHarness();const r=await h.q('hyperliquid','BLUR');assert.equal(r.ok,true);assert.equal(r.predicted,-.004);assert.equal(r.kind,'official');assert.equal(r.end,start+3600000);assert.equal(h.calls.at(-1).type,'fundingHistory');await h.q('hyperliquid','BLUR');assert.equal(h.calls.length,3);});
test('HL future timestamps need no repair; arbitrary stale predictions and wrong settlements fail',async()=>{assert.equal((await hlHarness({stamp:start+3600000}).q('hyperliquid','BLUR')).ok,true);for(const options of [{stamp:start-3600000},{settled:start-3600000},{interval:8},{rate:'-.4'}])assert.equal((await hlHarness(options).q('hyperliquid','BLUR')).ok,false);});
