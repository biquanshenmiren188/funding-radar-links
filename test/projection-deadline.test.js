const test = require('node:test'), assert = require('node:assert/strict');
const { createClient, project } = require('../projection.js');
const now = 1792077600000;
const reply = data => ({ok:true,json:async()=>data});
const contexts = [{universe:[{name:'AAA'},{name:'BBB'}]},[]];
const predictions = ['AAA','BBB'].map(coin=>[coin,[['HlPerp',{fundingRate:'.0001',nextFundingTime:now+3600000,fundingIntervalHours:1}]]]);

test('whole-query deadline aborts stalled fetch and frees the exchange lane for later work', async()=>{
  let stall=true, signal, time=now;
  const q=createClient(async(url,options)=>{
    if(stall){signal=options.signal;return new Promise(()=>{})}
    return reply(JSON.parse(options.body).type==='metaAndAssetCtxs'?contexts:predictions);
  },()=>time,async()=>{}, {queryTimeoutMs:40});
  const r=await q('hyperliquid','AAA');
  assert.equal(r.ok,false);assert.match(r.error,/本轮已结束/);assert.equal(signal.aborted,true);
  stall=false;time+=6000;
  const recovered=await q('hyperliquid','AAA');
  assert.equal(recovered.ok,true,recovered.error);
});

test('whole-query deadline also bounds response body reads and retry backoff', async()=>{
  for(const kind of ['body','backoff']){
    const q=createClient(async()=>kind==='body'?{ok:true,json:()=>new Promise(()=>{})}:{ok:false,status:429,headers:{get:()=> '10'}},()=>now,()=>new Promise(()=>{}),{queryTimeoutMs:30});
    const r=await q('hyperliquid','AAA');assert.equal(r.ok,false);assert.match(r.error,/本轮已结束/);
  }
});

test('timing out one market does not abort shared metadata needed by another market', async()=>{
  let release, metaCalls=0, sharedSignal;
  const q=createClient(async(url,options)=>{
    if(JSON.parse(options.body).type==='metaAndAssetCtxs'){
      metaCalls++;sharedSignal=options.signal;
      return new Promise(resolve=>{release=()=>resolve(reply(contexts))});
    }
    return reply(predictions);
  },()=>now,async()=>{}, {queryTimeoutMs:160});
  const first=q('hyperliquid','AAA');
  await new Promise(resolve=>setTimeout(resolve,60));
  const second=q('hyperliquid','BBB');
  assert.equal((await first).ok,false);
  assert.equal(sharedSignal.aborted,false);assert.equal(metaCalls,1);
  release();const r=await second;assert.equal(r.ok,true,r.error);
});

test('history failures identify the missing minute and incomplete sample count',()=>{
  const c={start:now,end:now+3600000,hours:1,samples:12,equal:true,interest:.0001,divisor:8,floor:-.02,cap:.02};
  assert.throws(()=>project(c,[{t:now,p:0,close:0,count:11}],now+60000),/23:20:00.*采样 11\/12/);
  assert.throws(()=>project(c,[{t:now+60000,p:0,close:0,count:12}],now+120000),/23:20:00.*尚未返回/);
});

test('a delayed tail extrapolates from complete history without accepting interior gaps',()=>{
  for (const sampleOffset of [0,1]) {
    const c={start:now,end:now+3600000,hours:1,samples:12,equal:true,interest:.0001,divisor:8,floor:-.02,cap:.02,maxHistoryLagMinutes:5,sampleOffset};
    const rows=Array.from({length:7},(_,i)=>({t:now+(i+sampleOffset)*60000,p:-.002,close:-.002,count:12}));
    rows.push({t:now+(7+sampleOffset)*60000,p:.9,close:.9,count:11});
    const r=project(c,rows,now+10*60000);
    assert.equal(r.historyLagMinutes,3);assert.equal(r.observedMinutes,7);
    assert.equal(r.currentPremium,-.002);assert.ok(Math.abs(r.average+.002)<1e-12);
    assert.throws(()=>project(c,rows.filter((_,i)=>i!==3),now+10*60000),/缺口/);
    assert.throws(()=>project(c,rows,now+13*60000),/延迟超过/);
  }
});

test('cancel one subscriber keeps a shared query alive; cancel its last subscriber aborts the fetch',async()=>{
  let signal,release;
  const q=createClient(async(url,options)=>{
    if(JSON.parse(options.body).type==='metaAndAssetCtxs'){
      signal=options.signal;return new Promise(resolve=>{release=()=>resolve(reply(contexts))});
    }
    return reply(predictions);
  },()=>now,async()=>{});
  const a=new AbortController(),b=new AbortController();
  const one=q('hyperliquid','AAA',{signal:a.signal});
  const two=q('hyperliquid','AAA',{signal:b.signal});
  await new Promise(setImmediate);a.abort();
  await assert.rejects(one);assert.equal(signal.aborted,false);
  release();assert.equal((await two).ok,true);
  const last=new AbortController();
  const q2=createClient(async(url,options)=>{signal=options.signal;return new Promise(()=>{})},()=>now,async()=>{});
  const three=q2('hyperliquid','BBB',{signal:last.signal});await new Promise(setImmediate);
  last.abort();await assert.rejects(three);await new Promise(setImmediate);
  assert.equal(signal.aborted,true);
});
