const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const limits = require('../limits.js');
async function harness(config, alertCoins = "", alertEnabled = true) {
  const timers = new Map(), queries = [], handlers = {};
  let id = 0, storage, responseState = "open", clock = Date.now() - 10000;
  const alerts = [];
  const cards = ['W', 'BTC', 'W'].map(symbol=>({symbol}));
  const document = {hidden:false, body:{}, querySelectorAll:()=>cards,
    addEventListener:(type,fn)=>handlers[type]=fn,removeEventListener:()=>{}};
  const sandbox = {
    FundingRadarLimits:{...limits,createReleaseTracker:()=>limits.createReleaseTracker(()=>clock)}, FundingRadarAlerts:{createNotifier:()=>({notify(symbol){alerts.push(symbol)},clear(){}})},
    FundingRadarLinking:{DEFAULT_RADAR_ORIGIN:'https://radar.example',readLimitCard:card=>card},
    document, location:{origin:'https://dashboard.example'},console,
    setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{},
    MutationObserver:class {observe(){}disconnect(){}},
    chrome:{storage:{local:{get:async()=>({siteOrigin:'https://dashboard.example',hlAutoQuery:config,hlReleaseCoins:alertCoins,hlReleaseAlert:alertEnabled})},
      onChanged:{addListener:fn=>storage=fn,removeListener:()=>{}}},runtime:{sendMessage:async msg=>{
        queries.push(msg.symbol);return {state:responseState,checkedAt:++clock,reason:'test'};
      }}}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../content.js'),'utf8'),sandbox);
  await new Promise(resolve=>setImmediate(resolve));
  return {queries,timers,document,handlers,alerts,setResponse:state=>responseState=state,setAlertCoins:coins=>storage({hlReleaseCoins:{newValue:coins}},"local"),setConfig:config=>storage({hlAutoQuery:{newValue:config}},'local'),
    async run(ms){const entry=[...timers].find(([,t])=>t.ms===ms);assert.ok(entry,`timer ${ms} exists`);timers.delete(entry[0]);entry[1].fn();await new Promise(resolve=>setImmediate(resolve));}};
}
test('automatic lookup defaults off and requires a coin allowlist',async()=>{
  for(const config of [undefined,{enabled:true,coins:''}]){
    const h=await harness(config);assert.equal(h.timers.size,0);assert.equal(h.queries.length,0);
  }
});
test('auto interval, allowlist, deduplication, off switch and background pause',async()=>{
  const config={enabled:true,interval:60,coins:'W, ABSENT'};
  const h=await harness(config);
  await h.run(0);assert.deepEqual(h.queries,['W']);
  await h.run(60000);assert.deepEqual(h.queries,['W','W']);
  h.document.hidden=true;h.handlers.visibilitychange();
  assert.ok(![...h.timers.values()].some(t=>t.ms===60000));
  h.document.hidden=false;h.handlers.visibilitychange();await h.run(0);
  assert.deepEqual(h.queries,['W','W','W']);
  h.setConfig({...config,enabled:false});assert.ok(![...h.timers.values()].some(t=>t.ms===60000));
  h.setConfig({enabled:true,interval:120,coins:'BTC'});await h.run(0);
  assert.equal(h.queries.at(-1),'BTC');assert.ok([...h.timers.values()].some(t=>t.ms===120000));
});

test('all-card mode works without a list and deduplicates present symbols',async()=>{
  const h=await harness({enabled:true,mode:'all',interval:30,coins:''});
  await h.run(0);assert.deepEqual(h.queries,['W','BTC']);
  h.setConfig({enabled:true,mode:'selected',interval:30,coins:'BTC'});await h.run(0);
  assert.deepEqual(h.queries,['W','BTC','BTC']);
});
test('release alerts use a separate required allowlist even when all cards are queried',async()=>{
  const h=await harness({enabled:true,mode:'all',interval:30},'w');
  h.setResponse('restricted');await h.run(0);
  h.setResponse('open');await h.run(30000);assert.deepEqual(h.alerts,['W']);
  await h.run(30000);assert.deepEqual(h.alerts,['W']);
  h.setAlertCoins('BTC');h.setResponse('restricted');await h.run(30000);
  h.setResponse('open');await h.run(30000);assert.deepEqual(h.alerts,['W','BTC']);
});
test('empty reminder list or disabled reminder never alerts',async()=>{
  for(const [coins,enabled] of [['',true],['W',false]]){
    const h=await harness({enabled:true,mode:'all',interval:30},coins,enabled);
    h.setResponse('restricted');await h.run(0);h.setResponse('open');await h.run(30000);
    assert.deepEqual(h.alerts,[]);
  }
});
