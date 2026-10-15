const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup() {
 const listeners=[],calls=[];
 const context={console,URL,FundingRadarProjection:{createClient:()=>()=>{}},importScripts(){},FundingRadarLimits:{createClient:()=>()=>{}},FundingRadarRoughRisk:require('../rough-risk.js'),readAstroRiskSnapshot:()=>{},chrome:{
 runtime:{id:'unit',onMessage:{addListener:fn=>listeners.push(fn)},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
 storage:{local:{get:async()=>({siteOrigin:'https://dashboard.example.com'})}},
 scripting:{executeScript:async args=>{calls.push(args);return[{result:{capturedAt:Date.now(),pairs:[],accounts:{}}}];}}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'),'utf8'),context);
 return {calls,send:sender=>new Promise(resolve=>listeners[0]({type:'read-frontend-risk'},sender,resolve))};
}
test('only own main-frame content on configured origin can read its own tab',async()=>{
 const x=setup(),sender={id:'unit',url:'https://dashboard.example.com/prefix/dashboard',frameId:0,tab:{id:12}};
 const good=await x.send(sender);assert.equal(good.ok,true);assert.ok(good.report);assert.equal(good.snapshot,undefined);
 assert.equal(x.calls[0].target.tabId,12);assert.equal(x.calls[0].world,'MAIN');
 for(const bad of [{...sender,id:'other'},{...sender,url:'https://evil.example'},{...sender,tab:null},{...sender,frameId:1},{...sender,url:'chrome-extension://unit/popup.html'}])assert.equal((await x.send(bad)).ok,false);
 assert.equal(x.calls.length,1);
});
test('simultaneous reads coalesce per tab and never share between tabs',async()=>{
 const x=setup(),sender={id:'unit',url:'https://dashboard.example.com/dashboard',frameId:0,tab:{id:12}};
 await Promise.all([x.send(sender),x.send(sender),x.send({...sender,tab:{id:13}})]);
 assert.equal(x.calls.length,2);assert.deepEqual(x.calls.map(c=>c.target.tabId),[12,13]);
});
