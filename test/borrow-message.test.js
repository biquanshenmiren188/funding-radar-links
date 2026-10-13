const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function setup() {
  const listeners=[],opened=[];
  const context={console,URL,URLSearchParams,importScripts:()=>{},FundingRadarLimits:{createClient:()=>()=>{}},
    chrome:{runtime:{getURL:path=>'chrome-extension://test/'+path,onMessage:{addListener:fn=>listeners.push(fn)},onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}}},
      storage:{local:{get:async()=>({siteOrigin:'https://dashboard.example.com'})}},tabs:{create:async args=>opened.push(args)}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'),'utf8'),context);
  const send=(message,sender)=>new Promise(resolve=>listeners[0](message,sender,resolve));
  return {send,opened};
}
test('calculator message accepts only configured dashboard and native venue; sends identity only',async()=>{
  const {send,opened}=setup();
  const sender={tab:{id:1},url:'https://dashboard.example.com/dashboard'};
  const reply=await send({type:'open-borrow-calculator',exchange:'bitget',symbol:'X&equity=secret',equity:999},sender);
  assert.equal(reply.ok,true);
  const url=new URL(opened[0].url), seed=new URLSearchParams(url.hash.slice(1));
  assert.equal(url.pathname,'/liquidation.html');
  assert.equal(seed.get('symbol'),'X&equity=secret');
  assert.equal(seed.get('equity'),null);
  assert.equal([...seed.keys()].length,2);
  for(const [message,source] of [
    [{exchange:'bitget',symbol:'BTC'},{tab:{id:1},url:'https://evil.example'}],
    [{exchange:'bitget',symbol:'BTC'},{url:sender.url}],
    [{exchange:'gc-binance',symbol:'BTC'},sender],
    [{exchange:'bitget',symbol:'X'.repeat(61)},sender],
    [{exchange:'bitget',symbol:''},sender]
  ]) assert.equal((await send({type:'open-borrow-calculator',...message},source)).ok,false);
  assert.equal(opened.length,1);
});
