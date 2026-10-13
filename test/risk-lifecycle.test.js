const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function harness() {
 let next=0,eligible=true,reject=false,resolvePending,delayed=false;
 const timers=new Map(),queries=[];
 const button={dataset:{},textContent:'',title:'',setAttribute(){}};
 const row={classList:{contains:()=>true,remove(){}}};
 const wrap={parentElement:row,firstElementChild:button};
 const card={querySelector:s=>s==='.mmr-row'?row:s==='.funding-radar-risk'?wrap:null,querySelectorAll:()=>[]};
 const document={hidden:false,querySelectorAll:()=>[card]};
 const ctx={document,console,Date,setTimeout:(fn,ms)=>{timers.set(++next,{fn,ms});return next;},clearTimeout:n=>timers.delete(n),chrome:{runtime:{sendMessage:async()=>{
   queries.push(1);
   if(delayed)await new Promise(resolve=>resolvePending=resolve);
   if(reject)throw new Error('failed');
   return {ok:true,report:{capturedAt:Date.now(),rows:[{exchange:'bitget',symbol:'DEMO',weighted:{state:'estimated',multiple:2.5}}]}};
 }}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../risk-inline.js'),'utf8'),ctx);
 const risk=ctx.FundingRadarInlineRisk.create({linking:{readBorrowCard:()=>eligible?{exchange:'bitget',symbol:'DEMO'}:null}});
 return {risk,queries,timers,document,button,eligible:v=>eligible=v,fail:()=>reject=true,delay:()=>delayed=true,resolve:()=>resolvePending(),
 async tick(){const [id,t]=[...timers][0]||[];assert.ok(t);timers.delete(id);t.fn();await new Promise(r=>setImmediate(r));}};
}
test('no eligible cards means no reads; visible cards share one poll, hide pauses and failures clear values',async()=>{
 const h=harness();h.eligible(false);h.risk.start();await h.tick();assert.equal(h.queries.length,0);
 h.eligible(true);await h.tick();assert.equal(h.queries.length,1);assert.equal(h.button.textContent,'150%');
 h.document.hidden=true;h.risk.visibilityChanged();assert.equal(h.timers.size,0);
 h.document.hidden=false;h.risk.visibilityChanged();await h.tick();assert.equal(h.queries.length,2);
 h.fail();await h.tick();assert.equal(h.button.textContent,'—');assert.equal(h.button.dataset.state,'unknown');
 h.risk.stop();assert.equal(h.timers.size,0);
});
test('response arriving while hidden cannot restore an old number or start polling',async()=>{
 const h=harness();h.delay();h.risk.start();await h.tick();
 h.document.hidden=true;h.risk.visibilityChanged();h.resolve();await new Promise(r=>setImmediate(r));
 assert.equal(h.button.textContent,'');assert.equal(h.timers.size,0);h.risk.stop();
});
