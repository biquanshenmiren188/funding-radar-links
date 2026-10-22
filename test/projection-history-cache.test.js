const test=require('node:test'),assert=require('node:assert/strict');
const {createClient}=require('../projection.js');
test('captured Aster three-minute publication delay produces a complete-history estimate',async()=>{
 const f=require('./fixtures/aster-delayed-history.json');
 const q=createClient(async raw=>{
  const path=new URL(raw).pathname;
  const data=path.endsWith('/fundingInfo')?[f.info]:path.endsWith('/premiumIndex')?f.p:f.rows;
  return{ok:true,json:async()=>data};
 },()=>f.at,async()=>{});
 const r=await q('aster','龙虾');
 assert.equal(r.ok,true,r.error);assert.equal(r.historyLagMinutes,3);
 assert.equal(r.observedMinutes,197);assert.equal(r.premiumAt,1792077360000);
 const complete=f.rows.filter(row=>+row[0]<=r.premiumAt).sort((a,b)=>a[0]-b[0]);
 const mean=complete.slice(-10).reduce((s,row)=>s+row.slice(1,5).reduce((a,b)=>a+Number(b),0)/4,0)/10;
 assert.ok(Math.abs(r.forecastPremium-mean)<1e-12);
 assert.equal(r.forecastMethod,'mean10');
});
test('failed history retains good minutes and next attempts request only gaps plus the tail',async()=>{
 const start=1792065600000;let now=start+30*60000,missing=true,calls=[];
 const q=createClient(async(raw)=>{
  const u=new URL(raw);let data;
  if(u.pathname.endsWith('/premiumIndex'))data={symbol:'AAAUSDT',time:now,nextFundingTime:start+14400000,lastFundingRate:'.00005',interestRate:'.0001'};
  else if(u.pathname.endsWith('/fundingInfo'))data=[{symbol:'AAAUSDT',fundingIntervalHours:4,adjustedFundingRateCap:'.02',adjustedFundingRateFloor:'-.02'}];
  else {
   calls.push(u);
   const lo=Number(u.searchParams.get('startTime')),hi=Number(u.searchParams.get('endTime'));
   data=Array.from({length:Math.floor((now-start)/60000)},(_,i)=>[start+i*60000,'-.001','-.001','-.001','-.001',0,0,0,12])
    .filter(r=>r[0]>=lo&&r[0]<=hi&&(!missing||r[0]!==start+5*60000));
  }
  return{ok:true,json:async()=>data};
 },()=>now,async()=>{});
 const failed=await q('binance','AAA');assert.equal(failed.ok,false);assert.match(failed.error,/缺口/);
 assert.equal(calls.length,2);
 assert.equal(Number(calls[1].searchParams.get('startTime')),start+5*60000);
 assert.equal(Number(calls[1].searchParams.get('endTime')),start+6*60000-1);
 now+=6000;missing=false;calls=[];
 const repaired=await q('binance','AAA');assert.equal(repaired.ok,true,repaired.error);
 assert.equal(calls.length,2);
 assert.deepEqual(calls.map(u=>Number(u.searchParams.get('startTime'))).sort((a,b)=>a-b),[start+5*60000,start+27*60000]);
});
