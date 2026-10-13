const test=require('node:test'),assert=require('node:assert/strict');
const {describe}=require('../risk-inline.js');
const row=multiple=>({exchange:'bitget',symbol:'DEMO',weighted:{state:'estimated',multiple}});
test('inline percentage rounds to integer and explains current-price basis',()=>{
 const r=describe(row(2.123456));
 assert.equal(r.label,'112%');assert.match(r.detail,/上涨空间粗估/);assert.match(r.detail,/并非交易所确认/);
});
test('100% and lower is red, higher is green',()=>{
 assert.equal(describe(row(2)).state,'danger');assert.equal(describe(row(2.00000001)).state,'danger');assert.equal(describe(row(1.5)).state,'danger');assert.equal(describe(row(2.01)).state,'space');
 assert.equal(describe({weighted:{state:'already'}}).label,'0%');assert.equal(describe({weighted:{state:'already'}}).state,'danger');
});
test('errors and no crossing use a neutral dash, never green or a made-up percentage',()=>{
 for(const r of [describe(null),describe({error:'missing'}),describe({weighted:{state:'none'}}),describe(row(Infinity))]){assert.equal(r.label,'—');assert.equal(r.state,'unknown');}
});
