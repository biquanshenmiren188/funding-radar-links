const test=require('node:test'), assert=require('node:assert/strict');
const {project,recentPremium,fee,createClient,FORECAST_METHODS}=require('../projection.js');
const {forecast}=require('../scripts/backtest-funding.cjs');
const start=1792627200000, M=60000;
function fixture(hours=4,samples=12,offset=0){
  const config={start,end:start+hours*60*M,hours,samples,sampleOffset:offset,equal:false,interest:.0001,divisor:8/hours,floor:-.02,cap:.02,forecastMethod:'mean10'};
  const rows=Array.from({length:hours*60+15},(_,j)=>{let i=j-15,p=.001+i*.00001;return {t:start+(i+offset)*M,p,close:p+.000001,low:p,high:p+.000002,count:samples};});
  return {config,rows};
}
test('5/10-minute scenario matches independent weighted arithmetic for all periods and venue sampling',()=>{
  for(const hours of [1,2,4,8]) for(const samples of [1,12]) for(const equal of [false,true]) for(const window of [5,10]){
    const p=fixture(hours,samples);p.config.equal=equal;p.config.forecastMethod='mean'+window;
    const elapsed=17,prefix=p.rows.filter(r=>r.t>=start&&r.t<start+elapsed*M);
    const anchor=prefix.slice(-window).reduce((s,r)=>s+r.p,0)/window;
    let weighted=0,total=0;
    for(let minute=0;minute<hours*60;minute++) for(let sample=0;sample<samples;sample++){
      const w=equal?1:minute*samples+sample+1;
      weighted+=(minute<elapsed?prefix[minute].p:anchor)*w;total+=w;
    }
    const result=project(p.config,p.rows,start+elapsed*M);
    assert.ok(Math.abs(result.predicted-fee(weighted/total,p.config))<1e-14);
    assert.ok(Math.abs(result.forecastPremium-anchor)<1e-14);
  }
});
test('new cycle takes exact lookback across settlement without counting prior minutes as accrued history',()=>{
  const p=fixture();const result=project(p.config,p.rows,start+2*M);
  const expected=p.rows.filter(r=>r.t>=start-8*M&&r.t<start+2*M).reduce((s,r)=>s+r.p,0)/10;
  assert.equal(result.forecastPremium,expected);assert.equal(result.observedMinutes,2);
  assert.throws(()=>project(p.config,p.rows.filter(r=>r.t>=start),start+2*M),/10 分钟溢价有缺口/);
});
test('recent window rejects missing/conflicting/incomplete observations and ignores future data',()=>{
  const p=fixture(),t=start+12*M;
  const expected=project(p.config,p.rows,t).predicted;
  assert.equal(project(p.config,p.rows.map(r=>r.t>=t?{...r,p:99,close:99}:r),t).predicted,expected);
  assert.throws(()=>recentPremium(p.config,p.rows.filter(r=>r.t!==start+5*M),12,10),/缺口/);
  assert.throws(()=>recentPremium(p.config,p.rows.map(r=>r.t===start+5*M?{...r,count:11}:r),12,10),/缺口/);
  assert.throws(()=>recentPremium(p.config,[...p.rows,{...p.rows.find(r=>r.t===start+5*M),t:start+5*M+1000}],12,10),/多个/);
});
test('Bybit endpoint alignment and lag consume only the last five completed observable samples',()=>{
  const p=fixture(4,1,1);p.config.forecastMethod='mean5';p.config.forecastLagMinutes=1;
  const result=project(p.config,p.rows,start+12*M);
  const tail=p.rows.filter(r=>r.t>=start+7*M&&r.t<=start+11*M);
  assert.equal(result.forecastPremium,tail.reduce((s,r)=>s+r.p,0)/5);
  assert.equal(result.observedMinutes,11);
  const period={...p,exchange:'bybit',rows:p.rows.filter(r=>r.t>start)};
  assert.ok(Math.abs(result.predicted-forecast(period,12,'mean5'))<1e-14);
});
test('seconds-bearing OKX samples use minute buckets in the recent window',()=>{
  const p=fixture(4,1);const expected=project(p.config,p.rows,start+12*M);
  const shifted=project(p.config,p.rows.map(r=>({...r,t:r.t+23456})),start+12*M);
  assert.equal(shifted.predicted,expected.predicted);
});
test('production client fetches prior-cycle window and computes exact lookback after rollover',async()=>{
  const p=fixture(),now=start+2*M,urls=[];
  const q=createClient(async u=>{urls.push(u);const url=new URL(u);let data;
    if(url.pathname.endsWith('premiumIndex'))data={symbol:'BTCUSDT',nextFundingTime:p.config.end,time:now,lastFundingRate:'.001',interestRate:'.0001'};
    else if(url.pathname.endsWith('fundingInfo'))data=[{symbol:'BTCUSDT',fundingIntervalHours:4,adjustedFundingRateCap:'.02',adjustedFundingRateFloor:'-.02'}];
    else {const from=+url.searchParams.get('startTime'),to=+url.searchParams.get('endTime');data=p.rows.filter(r=>r.t>=from&&r.t<=to).map(r=>[r.t,r.p,r.high,r.low,r.close,0,r.t+M-1,0,12]);}
    return {ok:true,json:async()=>data};
  },()=>now,async()=>{});
  const r=await q('binance','BTC');assert.equal(r.ok,true,r.error);
  assert.equal(r.observedMinutes,2);
  assert.ok(urls.some(u=>new URL(u).searchParams.has('startTime')&&+new URL(u).searchParams.get('startTime')<=start-8*M));
});
test('accepted scenario policy preserves Hyperliquid official prediction without inventing minute history',()=>{
  assert.deepEqual(FORECAST_METHODS,{binance:'mean10',aster:'mean10',gate:'mean10',bybit:'mean5',bitget:'mean10',okx:'mean10',hyperliquid:'official'});
});
