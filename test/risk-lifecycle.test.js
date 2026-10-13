const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function harness() {
 let next=0,eligible=true,reject=false,resolvePending,delayed=false,clock=Date.now();
 const TestDate=class extends Date {static now(){return clock;}};
 const timers=new Map(),queries=[];
 const button={dataset:{},textContent:'',title:'',setAttribute(){}};
 const row={classList:{contains:()=>true,remove(){}}};
 const wrap={parentElement:row,firstElementChild:button};
 const card={querySelector:s=>s==='.mmr-row'?row:s==='.funding-radar-risk'?wrap:null,querySelectorAll:()=>[]};
 const document={hidden:false,querySelectorAll:()=>[card]};
 const ctx={document,console,Date:TestDate,setTimeout:(fn,ms)=>{timers.set(++next,{fn,ms});return next;},clearTimeout:n=>timers.delete(n),chrome:{runtime:{sendMessage:async()=>{
   queries.push(1);
   if(delayed)await new Promise(resolve=>resolvePending=resolve);
   if(reject)throw new Error('failed');
   return {ok:true,report:{capturedAt:clock,rows:[{exchange:'bitget',symbol:'DEMO',weighted:{state:'estimated',multiple:2.5}}]}};
 }}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../risk-inline.js'),'utf8'),ctx);
 const risk=ctx.FundingRadarInlineRisk.create({linking:{readBorrowCard:()=>eligible?{exchange:'bitget',symbol:'DEMO'}:null}});
 return {risk,queries,timers,document,button,advance:ms=>clock+=ms,render:()=>risk.render(card),eligible:v=>eligible=v,fail:()=>reject=true,delay:()=>delayed=true,resolve:()=>resolvePending(),
 async tick(){const [id,t]=[...timers][0]||[];assert.ok(t);timers.delete(id);clock+=t.ms;t.fn();await new Promise(r=>setImmediate(r));}};
}
test('no eligible cards means no reads; hidden cards keep values and continue polling',async()=>{
 const h=harness();h.eligible(false);h.risk.start();await h.tick();assert.equal(h.queries.length,0);
 h.eligible(true);await h.tick();assert.equal(h.queries.length,1);assert.equal(h.button.textContent,'150%');
 h.document.hidden=true;h.risk.visibilityChanged();assert.equal(h.timers.size,1);assert.equal(h.button.textContent,'150%');
 await h.tick();assert.equal(h.queries.length,2);assert.equal(h.button.dataset.state,'space');
 h.document.hidden=false;h.risk.visibilityChanged();assert.equal(h.button.textContent,'150%');
 h.fail();await h.tick();assert.equal(h.button.textContent,'—');assert.equal(h.button.dataset.state,'unknown');
 h.risk.stop();assert.equal(h.timers.size,0);
});
test('switching tabs during a read keeps the value and accepts the response in background',async()=>{
 const h=harness();h.risk.start();await h.tick();h.delay();await h.tick();
 h.document.hidden=true;h.risk.visibilityChanged();assert.equal(h.button.textContent,'150%');
 h.resolve();await new Promise(r=>setImmediate(r));
 assert.equal(h.button.textContent,'150%');assert.equal(h.button.dataset.state,'space');assert.equal(h.timers.size,1);h.risk.stop();
});
test('stop discards an in-flight response and cannot restart polling',async()=>{
 const h=harness();h.delay();h.risk.start();await h.tick();h.risk.stop();h.resolve();await new Promise(r=>setImmediate(r));
 assert.equal(h.timers.size,0);assert.equal(h.button.textContent,'—');
});

test('sleep-expired value stays visible but neutral until a fresh response arrives',async()=>{
 const h=harness();h.risk.start();await h.tick();h.advance(61000);h.risk.visibilityChanged();
 assert.equal(h.button.textContent,'150%');assert.equal(h.button.dataset.state,'unknown');assert.match(h.button.title,/已过期/);
 await h.tick();assert.equal(h.button.textContent,'150%');assert.equal(h.button.dataset.state,'space');h.risk.stop();
});
