const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup(){
 const listeners=[],calls=[],progress=[];let removed;
 const context={console,URL,AbortController,importScripts(){},FundingRadarLimits:{createClient:()=>()=>{}},
  FundingRadarProjection:{createClient:()=>async(exchange,symbol,options)=>{
   calls.push({exchange,symbol,options});options.onProgress({stage:'history'});
   return new Promise(resolve=>options.signal.addEventListener('abort',()=>resolve({ok:false}),{once:true}));
  }},chrome:{
   runtime:{id:'unit',onMessage:{addListener:fn=>listeners.push(fn)},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
   storage:{local:{get:async()=>({siteOrigin:'https://dashboard.example.com'})}},
   tabs:{sendMessage:async(...args)=>progress.push(args),onRemoved:{addListener:fn=>removed=fn}}
  }};
 vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'),'utf8'),context);
 return{calls,progress,remove:id=>removed(id),send:(message,sender)=>new Promise(resolve=>listeners.at(-1)(message,sender,resolve))};
}
const sender={id:'unit',url:'https://dashboard.example.com/dashboard',frameId:0,tab:{id:12}};
test('worker progress and cancellation are scoped to authorized originating tab',async()=>{
 const h=setup(),m={type:'funding-projection',requestId:'test-1',exchange:'aster',symbol:'AAA'};
 const active=h.send(m,sender);await new Promise(setImmediate);
 assert.equal(h.progress[0][0],12);assert.equal(h.progress[0][1].requestId,'test-1');
 for(const bad of [{...sender,id:'other'},{...sender,frameId:1},{...sender,url:'https://evil.example'}]){
  assert.equal((await h.send({...m,type:'funding-projection-cancel'},bad)).ok,false);
  assert.equal(h.calls[0].options.signal.aborted,false);
 }
 await h.send({...m,type:'funding-projection-cancel'},{...sender,tab:{id:13}});
 assert.equal(h.calls[0].options.signal.aborted,false);
 await h.send({...m,type:'funding-projection-cancel'},sender);await active;
 assert.equal(h.calls[0].options.signal.aborted,true);
 const next=h.send({...m,requestId:'test-2'},sender);await new Promise(setImmediate);
 h.remove(12);await next;assert.equal(h.calls[1].options.signal.aborted,true);
});
