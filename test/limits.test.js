const test = require('node:test');
const assert = require('node:assert/strict');
const { settings, classify, createClient } = require('../limits.js');
const meta = { universe: [{ name: 'W' }, { name: 'BTC' }, { name: 'OLD', isDelisted: true }, {name:'kPEPE'}] };
const ok = data => ({ ok: true, json: async () => data });

test('HL public cap, delisting and exact identity determine status', () => {
  assert.equal(classify('w', meta, ['W']).state, 'restricted');
  assert.equal(classify('BTC', meta, ['W']).state, 'open');
  assert.equal(classify('OLD', meta, []).state, 'restricted');
  assert.equal(classify('PEPE', meta, []).state, 'unknown');
  assert.equal(classify('kPEPE', meta, []).state, 'open');
  assert.equal(classify('xyz:BTC', meta, []).state, 'unknown');
  assert.equal(classify('BTC/USDC', meta, []).state, 'unknown');
});
test('malformed cap/meta data cannot become green', () => {
  for(const caps of [null, {}, ['W',null]]) assert.throws(()=>classify('BTC',meta,caps));
  for(const value of [{}, {universe:[]}, {universe:[{name:'BTC',isDelisted:'true'}]}]) assert.throws(()=>classify('BTC',value,[]));
  assert.equal(classify('BTC',{universe:[{name:'BTC'},{name:'btc'}]},[]).state,'unknown');
});
test('auto query defaults off, bounds interval, normalizes explicit coin allowlist', () => {
  assert.deepEqual(settings(), {enabled:false,mode:"selected",interval:60,coins:[]});
  assert.deepEqual(settings({enabled:true,interval:1,coins:'w, BTC，w\neth'}),{enabled:true,mode:'selected',interval:60,coins:['W','BTC','ETH']});
  for(const interval of [30,60,120,300]) assert.equal(settings({interval}).interval,interval);
  assert.equal(settings({coins:Array.from({length:110},(_,i)=>'X'+i).join(',')}).coins.length,100);
});
test('multiple cards share two public requests with no credentials; cache expires', async () => {
  let now = 100000, calls = 0;
  const client = createClient(async (url, init) => {
    calls++; assert.equal(url,'https://api.hyperliquid.xyz/info');
    assert.equal(init.credentials,'omit'); assert.equal(init.redirect,'error');
    const body=JSON.parse(init.body); assert.deepEqual(Object.keys(body),['type']);
    return ok(body.type === 'meta' ? meta : ['W']);
  },()=>now);
  const [w,btc] = await Promise.all([client('W'), client('BTC')]);
  assert.equal(w.state,'restricted');assert.equal(btc.state,'open');assert.equal(calls,2);
  await client('BTC');assert.equal(calls,2);
  now+=10001;await client('W');assert.equal(calls,4);
});
test('failed refresh clears success, no stale green fallback, failure backoff', async () => {
  let now=100000, fail=false, calls=0;
  const client=createClient(async (_url,init)=>{
    calls++;if(fail) return {ok:false,status:429};
    return ok(JSON.parse(init.body).type==='meta'?meta:[]);
  },()=>now);
  assert.equal((await client('BTC')).state,'open');
  fail=true;now+=10001;
  assert.equal((await client('BTC')).state,'unknown');
  const failedCalls=calls;
  assert.equal((await client('BTC')).state,'unknown');assert.equal(calls,failedCalls);
  fail=false;now+=5001;assert.equal((await client('BTC')).state,'open');
});
test('network timeout settles as unknown instead of leaving query pending', async () => {
  const client=createClient((_url,init)=>new Promise((_,reject)=>{
    init.signal.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError')));
  }),Date.now,5);
  const result=await client('W');assert.equal(result.state,'unknown');assert.match(result.reason,/超时/);
});
test('invalid or HIP3 identity makes no network requests', async () => {
  let calls=0;const client=createClient(()=>{calls++;throw Error('unexpected');});
  for(const symbol of ['',null,'X'.repeat(61),'xyz:BTC']) assert.equal((await client(symbol)).state,'unknown');
  assert.equal(calls,0);
});
