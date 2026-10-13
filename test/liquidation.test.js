const test = require('node:test');
const assert = require('node:assert/strict');
const { calculate, at } = require('../liquidation.js');
const base = { exchange:'bitget', price:1, equity:10000, maintenance:1000, debt:5000, borrowed:5000, borrowRate:10, hedge:'elsewhere', software:50, tierBound:'' };
const close = (a,b) => assert.ok(Math.abs(a-b) < 1e-8, `${a} != ${b}`);

test('unhedged borrowing reprices both debt and maintenance; boundary reconciles',()=>{
  const r=calculate(base);
  close(r.exchange.multiple, 1+9000/5500);
  const boundary=at(r.model,r.exchange.multiple);
  close(boundary.equity,boundary.maintenance);
  assert.ok(at(r.model,r.exchange.multiple-0.0001).equity > at(r.model,r.exchange.multiple-0.0001).maintenance);
  assert.ok(at(r.model,r.exchange.multiple+0.0001).triggered);
  close(r.software.multiple,1+8000/6000);
});
test('Binance uses native E/M 1.05, while Bitget first risk event is M/E 1',()=>{
  const b=calculate({...base,exchange:'binance'});
  const atB=at(b.model,b.exchange.multiple);
  close(atB.equity/atB.maintenance,1.05);
  assert.ok(b.exchange.multiple < calculate(base).exchange.multiple);
  assert.equal(calculate({...base,equity:1050,exchange:'binance'}).exchange.state,'already');
  assert.equal(calculate({...base,equity:1000}).exchange.state,'already');
});
test('same-account hedge offsets debt PnL, but maintenance still grows',()=>{
  const r=calculate({...base,hedge:'same',hedgeNotional:5000,riskNotional:5000,futuresRate:1,credit:100});
  close(r.model.equitySlope,0);
  close(r.model.maintenanceSlope,550);
  close(r.exchange.multiple,1+9000/550);
  const boundary=at(r.model,r.exchange.multiple);
  close(boundary.equity,boundary.maintenance);
});
test('other-exchange profits are ignored, including stale hidden inputs',()=>{
  const r=calculate({...base,hedgeNotional:999999,riskNotional:999999,futuresRate:99,credit:100});
  close(r.exchange.multiple,calculate(base).exchange.multiple);
});
test('gross loan MM is independent of net debt, and futures deductions do not scale',()=>{
  const r=calculate({...base,borrowed:8000,hedge:'same',hedgeNotional:-1000,riskNotional:4000,futuresRate:2,credit:90});
  close(r.model.equitySlope,-5900);
  close(r.model.maintenanceSlope,880);
  close(at(r.model,2).maintenance,1880);
});
test('no upward crossing is not an infinite safety claim; missing tier remains unverified',()=>{
  const r=calculate({...base,hedge:'same',hedgeNotional:10000,riskNotional:10000,futuresRate:1,credit:100});
  assert.equal(r.exchange.state,'none');
  assert.equal(r.exchange.multiple,null);
  assert.equal(at(r.model,2).outsideTier,true);
  assert.equal(calculate({...base,tierBound:2}).exchange.outsideTier,true);
  assert.equal(calculate({...base,tierBound:3}).exchange.outsideTier,false);
});
test('missing, negative, nonfinite and inconsistent account inputs fail closed',()=>{
  for(const key of ['price','equity','maintenance','debt','borrowed','borrowRate']) {
    for(const value of ['',null,undefined,NaN,Infinity,-1]) assert.throws(()=>calculate({...base,[key]:value}));
  }
  assert.throws(()=>calculate({...base,exchange:'gc-binance'}));
  assert.throws(()=>calculate({...base,borrowRate:101}));
  assert.throws(()=>calculate({...base,tierBound:0.5}));
  assert.throws(()=>calculate({...base,hedge:'same',hedgeNotional:5000,riskNotional:100,futuresRate:1,credit:100}));
  assert.throws(()=>calculate({...base,hedge:'same'}));
});
test('zero maintenance works; nonpositive equity in scenarios is triggered',()=>{
  const r=calculate({...base,maintenance:0,borrowRate:0});
  close(r.exchange.multiple,3);
  assert.equal(at(r.model,4).risk,Infinity);
  assert.equal(at(r.model,4).triggered,true);
});
test('changing coin units leaves risk multiplier unchanged',()=>{
  const a=calculate(base), b=calculate({...base,price:0.001});
  close(a.exchange.multiple,b.exchange.multiple);
  close(a.exchange.price/1000,b.exchange.price);
});
test('scaled portfolios have identical boundary; random deterministic cases reconcile',()=>{
  for(let i=1;i<=50;i++) for(const exchange of ['binance','bitget']) {
    const input={...base,exchange,equity:1000+i*300,maintenance:100+i,debt:500+i*100,borrowed:700+i*100,borrowRate:2+i/5};
    const a=calculate(input);
    const b=calculate({...input,equity:input.equity*10,maintenance:input.maintenance*10,debt:input.debt*10,borrowed:input.borrowed*10});
    close(a.exchange.multiple,b.exchange.multiple);
    const point=at(a.model,a.exchange.multiple);
    close(point.equity,point.maintenance*(exchange==='binance'?1.05:1));
  }
});
