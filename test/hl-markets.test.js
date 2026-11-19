const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveHlMarket } = require('../hl-cards.js');
const { createClient, createReleaseTracker } = require('../limits.js');
const pair = { name: 'ANTH-ANT', type: 'FR', buyEx: 'gc-hl', sellEx: 'gc-binance', aHlDex: 'io' };

test('worker resolves actual pair configuration before issuing a scoped public query', async () => {
  const vm = require('node:vm'), fs = require('node:fs');
  const listeners = [], requests = [];
  const readHlCardMarkets = () => {};
  const worker = { URL, importScripts(){}, readHlCardMarkets, resolveHlMarket,
    FundingRadarLimits:{createClient:()=>async (coin,dex)=>{requests.push([coin,dex]); return {state:'open',reason:'ok'};}},
    FundingRadarProjection:{createClient:()=>()=>{}},
    chrome:{ runtime:{id:'test',onMessage:{addListener:f=>listeners.push(f)},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
      storage:{local:{get:async()=>({siteOrigin:'https://test.example'})}},
      scripting:{executeScript:async request=>{
        assert.deepEqual([...request.target.frameIds],[0]);
        assert.equal(request.target.tabId,7); assert.equal(request.func,readHlCardMarkets);
        return [{result:[pair]}];
      }}}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'),'utf8'),worker);
  const sender = {id:'test',url:'https://test.example/dashboard',tab:{id:7},frameId:0};
  const send = symbol => new Promise(resolve=>{
    assert.ok(listeners.some(f=>f({type:'hl-limit-query',symbol},sender,resolve)));
  });
  const result = await send('ANTH-ANT');
  assert.equal(result.state,'open'); assert.equal(result.market,'io:ANTH');
  assert.equal((await send('UNKNOWN')).state,'unknown');
  assert.deepEqual(requests,[['ANTH','io']]);
});

test('FR and SR resolve the HL contract leg including its effective market and symbol override', () => {
  assert.equal(resolveHlMarket('ANTH-ANT', [pair]), 'io:ANTH');
  assert.equal(resolveHlMarket('ANTH-ANT', [{...pair, type:'SR'}]), null);
  assert.equal(resolveHlMarket('ANTH-ANT', [{...pair, type:'SR', buyEx:'binance', sellEx:'hl', bHlDex:'xyz'}]), 'xyz:ANT');
  assert.equal(resolveHlMarket('ANTH-ANT', [{...pair, aEffectiveHlDex:'para', aMarketSymbol:'para:DIFFERENT'}]), 'para:DIFFERENT');
  assert.equal(resolveHlMarket('ANTH-ANT', [{...pair, aMarketSymbol:'para:ANTH'}]), null);
  assert.equal(resolveHlMarket('BTC', [{...pair, name:'BTC', type:'FF', aHlDex:'default'}]), 'BTC');
  assert.equal(resolveHlMarket('ANTH-ANT', [pair, {...pair, aHlDex:'para'}]), null);
  assert.equal(resolveHlMarket('ANTH-ANT', [pair, {...pair}]), 'io:ANTH');
});

test('HL queries the same dex for metadata and caps, isolating cache and failure states', async () => {
  const calls = [];
  const client = createClient(async (_, init) => {
    const {type, dex} = JSON.parse(init.body);
    calls.push([type, dex]);
    const data = type === 'meta' ? {universe:[{name:dex + ':ANTH'}]} : dex === 'io' ? ['io:ANTH'] : [];
    return {ok:true, json:async()=>data};
  });
  const [a,b,c] = await Promise.all([client('ANTH','io'),client('ANTH','para'),client('ANTH','io')]);
  assert.deepEqual([a.state,b.state,c.state], ['restricted','open','restricted']);
  assert.deepEqual(calls.sort(), [['meta','io'],['meta','para'],['perpsAtOpenInterestCap','io'],['perpsAtOpenInterestCap','para']]);
  const release = createReleaseTracker(()=>1000);
  release('ANTH-ANT',{state:'restricted',checkedAt:900,market:'io:ANTH'});
  assert.equal(release('ANTH-ANT',{state:'open',checkedAt:950,market:'para:ANTH'}),false);
});
