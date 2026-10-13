const test = require('node:test');
const assert = require('node:assert/strict');
const {analyze}=require('../rough-risk.js');
const now=1800000000000;
const snapshot=()=>({capturedAt:now,pairs:[{id:'one',type:'FS',spotMarginType:'cross',name:'DEMO',buyEx:'binance',sellEx:'bitget',bExPosition:5000,avgOpenBExPrice:0.8}],accounts:{bitget:{displayedMargin:10000,mmr:0.1,spot:{BTC:0.1,USDT:1000},future:{},prices:{DEMO:1}}}});
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('frontend rough model uses current price and actual displayed margin, not entry cost or 2x divisor',()=>{
 const s=snapshot(),r=analyze(s,now).rows[0];
 close(r.currentNotional,5000);close(r.averageEntry,0.8);
 close(r.weighted.multiple,2.5); // E0=10000, M0=1000, dE=-5000, dM=1000.
 close(r.fixed.multiple,2.8);close(r.all.multiple,2.5);
 s.pairs[0].leverage=2;close(analyze(s,now).rows[0].weighted.multiple,2.5);
});
test('same account real futures offset debt, cross-exchange contracts do not',()=>{
 const s=snapshot();
 s.accounts.binance={displayedMargin:1e6,mmr:0.01,future:{'DEMO-LONG':5000},spot:{},prices:{DEMO:1}};
 close(analyze(s,now).rows[0].equitySlope,-5000);
 s.accounts.bitget.future={'DEMO-LONG':5000,'DEMO-PRICE':1};
 const r=analyze(s,now).rows[0];close(r.equitySlope,0);close(r.weighted.multiple,10);
 assert.equal(r.fixed.state,'none');
});
test('other actual futures contribute to maintenance allocation; missing price fails whole account',()=>{
 const s=snapshot();s.accounts.bitget.future={'OTHER-SHORT':5000};s.accounts.bitget.prices.OTHER=1;
 let r=analyze(s,now).rows[0];close(r.share,0.5);close(r.weighted.multiple,1+9000/5500);
 delete s.accounts.bitget.prices.OTHER;
 assert.match(analyze(s,now).rows[0].error,/OTHER/);
});
test('multiple FS cards sum borrowed quantity, notional-weighted entry; paused holdings still count',()=>{
 const s=snapshot();s.pairs.push({...s.pairs[0],id:'two',bExPosition:5000,avgOpenBExPrice:1.2,status:false});
 const r=analyze(s,now).rows[0];close(r.quantity,10000);close(r.averageEntry,1);close(r.currentNotional,10000);
 s.pairs.push({...s.pairs[0]});assert.match(analyze(s,now).rows[0].error,/身份/);
});
test('positive same coin spot offsets net liability; BTC price stress is not fixed-collateral model',()=>{
 const s=snapshot();s.accounts.bitget.spot.DEMO=1000;
 close(analyze(s,now).rows[0].equitySlope,-4000);
 s.pairs[0].name='BTC';s.accounts.bitget.prices.BTC=60000;
 assert.match(analyze(s,now).rows[0].error,/抵押资产/);
});
test('stale, invalid, absent or zero MMR and missing price never produce numbers',()=>{
 assert.throws(()=>analyze(snapshot(),now+60001),/过期/);
 for(const value of [null,'',NaN,-1,0,true,[],{}]) {
  const s=snapshot();s.accounts.bitget.mmr=value;assert.ok(analyze(s,now).rows[0].error);
 }
 const s=snapshot();delete s.accounts.bitget.prices.DEMO;
 assert.ok(analyze(s,now).rows[0].error);
});
test('Binance uses separate reference line and does not normalize GC into native accounts',()=>{
 const s=snapshot();s.pairs[0].sellEx='binance';s.accounts.binance=s.accounts.bitget;
 const r=analyze(s,now).rows[0];close(r.weighted.multiple,1+8950/6050);
 s.pairs[0].sellEx='gc-binance';assert.equal(analyze(s,now).rows.length,0);
});
test('failed venue does not contaminate successful venue; empty and unsupported cards excluded',()=>{
 const s=snapshot();s.pairs.push({...s.pairs[0],id:'two',sellEx:'binance'});s.accounts.binance={error:'failed'};
 const rows=analyze(s,now).rows;assert.equal(rows[0].error,'failed');assert.equal(rows[1].error,undefined);
 s.pairs=[];assert.equal(analyze(s,now).rows.length,0);
});

test('spot, isolated and unknown margin modes never become loans',()=>{
 for(const mode of ['spot','isolated',undefined]) {const s=snapshot();s.pairs[0].spotMarginType=mode;assert.equal(analyze(s,now).rows.length,0);}
 const s=snapshot();s.pairs.push({...s.pairs[0],id:'isolated',spotMarginType:'isolated',bExPosition:99999});
 close(analyze(s,now).rows[0].quantity,5000);
});
