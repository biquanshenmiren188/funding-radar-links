const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const limits=require('../limits.js');
class El {
 constructor(cls=''){this.className=cls;this.children=[];this.attrs={};this.dataset={};this.textContent='';this.handlers={};this.isConnected=true;this.nodeType=1;this.classList={contains:n=>this.className.split(' ').includes(n),add:n=>this.className+=' '+n,remove:n=>this.className=this.className.split(' ').filter(x=>x!==n).join(' ')};}
 addEventListener(k,f){this.handlers[k]=f;}setAttribute(k,v){this.attrs[k]=v;}
 get previousElementSibling(){return this.parentElement?.children[this.parentElement.children.indexOf(this)-1];}
 get nextElementSibling(){return this.parentElement?.children[this.parentElement.children.indexOf(this)+1];}
 append(e){e.parentElement=this;this.children.push(e);return e;}
 insertAdjacentElement(_,e){e.remove();e.parentElement=this.parentElement;this.parentElement.children.splice(this.parentElement.children.indexOf(this)+1,0,e);}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);this.parentElement=null;}
 querySelectorAll(s){return this.children.flatMap(c=>[...(s.startsWith('.')&&c.classList.contains(s.slice(1))?[c]:[]),...c.querySelectorAll(s)]);}
 querySelector(s){return this.querySelectorAll(s)[0]||null;}
 matches(s){return s==='.ant-card'&&this.classList.contains('ant-card');}closest(){return null;}
 click(){this.handlers.click({preventDefault(){},stopPropagation(){}});}
}
async function harness(config={interval:30}){
 let now=100000,seq=0,observer,storage;const timers=new Map(),frames=[],requests=[],cards=[],alerts=[];
 const doc={hidden:false,body:{},handlers:{},querySelectorAll:s=>s==='.ant-card'?cards:[],createElement:()=>new El(),addEventListener(k,f){this.handlers[k]=f},removeEventListener(){}};
 function card(symbol='SUPER',tagCount=1){const c=new El('ant-card');c.symbol=symbol;const header=c.append(new El());c.nameElement=header.append(new El());c.nameElement.textContent=symbol;const row=c.append(new El());c.hlTags=Array.from({length:tagCount},()=>row.append(new El('hl-tag')));cards.push(c);return c;}
 const a=card(),b=card(),spot=card('SPOT',0);
 const sandbox={console,Node:{TEXT_NODE:3,ELEMENT_NODE:1},Date:class extends Date{static now(){return now}},location:{origin:'https://test.local'},document:doc,
 FundingRadarLimits:{...limits,createReleaseTracker:()=>limits.createReleaseTracker(()=>now)},FundingRadarAlerts:{createNotifier:()=>({clear(){},notify:s=>alerts.push(s)})},
 FundingRadarLinking:{DEFAULT_RADAR_ORIGIN:'https://radar.local',readCard:()=>null,readBorrowCard:()=>null,readLimitCard:c=>c.hlTags.length?c:null},
 FundingRadarInlineRisk:{create:()=>({start(){},stop(){},render(){},visibilityChanged(){}})},
 setTimeout:(fn,ms)=>{timers.set(++seq,{fn,at:now+ms});return seq},clearTimeout:id=>timers.delete(id),requestAnimationFrame:fn=>{frames.push(fn);return frames.length},cancelAnimationFrame(){},
 MutationObserver:class{constructor(f){observer=f}observe(){}disconnect(){}},chrome:{storage:{local:{get:async()=>({siteOrigin:'https://test.local',hlAutoQuery:config,hlReleaseCoins:'SUPER'})},onChanged:{addListener:f=>storage=f,removeListener(){}}},runtime:{sendMessage:msg=>new Promise(resolve=>requests.push({msg,resolve}))}}};
 async function flush(){await new Promise(r=>setImmediate(r));let count=0;while(frames.length){frames.shift()();assert.ok(++count<30,'no render loop');}}
 async function tick(ms){const end=now+ms;while(true){const item=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!item)break;timers.delete(item[0]);now=item[1].at;item[1].fn();await flush();}now=end;await flush();}
 vm.runInNewContext(fs.readFileSync(require.resolve('../content.js'),'utf8'),sandbox);await flush();
 return {a,b,spot,cards,requests,alerts,flush,tick,doc,button:c=>c.querySelector('.funding-radar-limit-button'),
 resolve:async(i,state='open')=>{requests[i].resolve({state,checkedAt:now,reason:state});await flush()},
 configure:async v=>{storage({hlAutoQuery:{newValue:v}},'local');await flush()},
 remove:async c=>{cards.splice(cards.indexOf(c),1);c.isConnected=false;observer([{target:doc.body,addedNodes:[],removedNodes:[c]}]);await flush()}};
}
test('HL inline control starts polling, shares states and stops despite all-card settings',async()=>{
 const h=await harness();const a=h.button(h.a),b=h.button(h.b);
 assert.equal(a.previousElementSibling,h.a.hlTags[0]);assert.equal(a.textContent,'查');assert.equal(h.button(h.spot),null);
 a.click();await h.flush();assert.equal(a.attrs['aria-pressed'],'true');assert.equal(a.attrs['aria-busy'],'true');assert.equal(h.requests.length,1);
 await h.resolve(0);assert.equal(a.textContent,'可');assert.equal(b.textContent,'可');
 await h.tick(30000);assert.equal(h.requests.length,2);await h.resolve(1,'restricted');assert.equal(b.textContent,'限');
 b.click();await h.flush();assert.equal(a.textContent,'查');assert.equal(a.attrs['aria-pressed'],'false');
 await h.configure({enabled:true,mode:'all',interval:30});await h.tick(60000);assert.equal(h.requests.length,2,'manual stop overrides automatic defaults');
});
test('stop during query and restart reject the previous response',async()=>{
 const h=await harness();const b=h.button(h.a);b.click();await h.flush();b.click();await h.flush();b.click();await h.flush();
 assert.equal(h.requests.length,2);await h.resolve(0,'restricted');assert.equal(b.textContent,'查');assert.equal(b.attrs['aria-busy'],'true');
 await h.resolve(1,'open');assert.equal(b.textContent,'可');assert.deepEqual(h.alerts,[]);
});
test('expired and failed results never claim open; polling pauses in background',async()=>{
 const h=await harness({interval:60});const b=h.button(h.a);b.click();await h.resolve(0);assert.equal(b.textContent,'可');
 await h.tick(30051);assert.equal(b.textContent,'查');assert.equal(b.attrs['aria-pressed'],'true');
 await h.tick(29949);await h.resolve(1,'unknown');assert.equal(b.textContent,'查');assert.match(b.title,/自动查询已开启/);
 h.doc.hidden=true;h.doc.handlers.visibilitychange();await h.tick(60000);assert.equal(h.requests.length,2);
 h.doc.hidden=false;h.doc.handlers.visibilitychange();await h.tick(0);assert.equal(h.requests.length,3);
 b.click();await h.flush();await h.resolve(2);assert.equal(b.textContent,'查');assert.equal(b.attrs['aria-pressed'],'false');
});
test('removing last matching card invalidates pending response and manual subscription',async()=>{
 const h=await harness();h.button(h.a).click();await h.flush();await h.remove(h.a);await h.remove(h.b);await h.resolve(0);await h.tick(60000);assert.equal(h.requests.length,1);assert.deepEqual(h.alerts,[]);
});
