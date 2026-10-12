const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {createReleaseTracker} = require('../limits.js');

test('release alarm requires a known restriction, fires once, and re-arms after a new restriction',()=>{
  let time=100000;const release=createReleaseTracker(()=>time);
  const result=state=>({state,checkedAt:++time});
  assert.equal(release('BTC',result('open')),false);
  assert.equal(release('W',result('restricted')),false);
  assert.equal(release('w',result('unknown')),false);
  assert.equal(release('W',result('open')),true);
  assert.equal(release('W',result('open')),false);
  assert.equal(release('W',result('restricted')),false);
  assert.equal(release('W',result('open')),true);
});
test('cached, stale, future and out-of-order snapshots do not trigger alerts',()=>{
  const release=createReleaseTracker(()=>100000);
  release('W',{state:'restricted',checkedAt:99000});
  for(const checkedAt of [99000,98000,1,100001,NaN]) assert.equal(release('W',{state:'open',checkedAt}),false);
  assert.equal(release('W',{state:'open',checkedAt:100000}),true);
  assert.equal(release('W',{state:'open',checkedAt:100000}),false);
});

function harness(blocked=false) {
  let id=0, plays=0, sourcePauses=0;
  const timers=new Map(), clones=[];
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.classes=new Set();this.classList={add:x=>this.classes.add(x),remove:x=>this.classes.delete(x)};}
    setAttribute(k,v){this[k]=v;}
    removeAttribute(k){delete this[k];}
    append(...els){for(const el of els){this.children.push(el);el.parent=this;}}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
    addEventListener(k,fn){this.listeners[k]=fn;}
    querySelector(sel){return this.children.find(x=>sel==='[role=status]'?x.role==='status':x.className==='funding-radar-alert-retry');}
  }
  const source={volume:0.6,muted:false,pause:()=>sourcePauses++,cloneNode:()=>{
    const clip=new Element('audio');clip.play=()=>{plays++;return blocked?Promise.reject(Error('autoplay')):Promise.resolve();};
    clip.pause=()=>clip.paused=true;clip.replaceChildren=()=>{};clip.load=()=>{};clones.push(clip);return clip;
  }};
  const doc={hidden:false,body:new Element('body'),createElement:tag=>new Element(tag),querySelector:()=>source};
  const sandbox={document:doc,setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(fs.readFileSync(require.resolve('../alerts.js'),'utf8'),sandbox);
  return {doc,source,timers,clones,plays:()=>plays,sourcePauses:()=>sourcePauses,card:()=>new Element('card'),
    notifier:sandbox.FundingRadarAlerts.createNotifier(doc),
    async run(ms){const t=[...timers].find(([,t])=>t.ms===ms);assert.ok(t);timers.delete(t[0]);t[1].fn();await new Promise(resolve=>setImmediate(resolve));}};
}
test('multiple released cards share one sound; original site alarm stays untouched; clear cleans effects',async()=>{
  const h=harness();const a=h.card(),b=h.card();
  h.notifier.notify('W',[a,b]);h.notifier.notify('BTC',[b]);
  await h.run(150);assert.equal(h.plays(),1);assert.equal(h.sourcePauses(),0);
  assert.equal(h.clones[0].volume,0.6);assert.equal(h.clones[0].loop,false);
  assert.equal(a.classes.has('funding-radar-release-alert'),true);
  h.notifier.clear();assert.equal(h.clones[0].paused,true);assert.equal(h.doc.body.children.length,0);assert.equal(h.timers.size,0);assert.equal(a.classes.size,0);
});
test('autoplay failure exposes a manual retry and hidden documents do not alert',async()=>{
  const h=harness(true);h.doc.hidden=true;h.notifier.notify('W',[h.card()]);assert.equal(h.timers.size,0);
  h.doc.hidden=false;h.notifier.notify('W',[h.card()]);await h.run(150);
  const notice=h.doc.body.children[0];assert.match(notice.children[0].textContent,/声音未播放/);
  assert.equal(notice.children[1].hidden,false);assert.equal(h.plays(),1);
  await notice.children[1].listeners.click();assert.equal(h.plays(),2);
  h.notifier.clear();
});
