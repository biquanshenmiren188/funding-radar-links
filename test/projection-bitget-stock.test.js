const test=require('node:test');
const assert=require('node:assert/strict');
const {createClient,reconstruct}=require('../projection.js');
const start=1792108800000,now=start+30*60000+10000;
function harness(patch={}) {
 const calls=[];
 const query=createClient(async raw=>{
  const u=new URL(raw);calls.push(u.pathname);let data;
  if(u.pathname.endsWith('/instruments'))data=[{symbol:'INTWUSDT',baseCoin:'INTW',category:'USDT-FUTURES',quoteCoin:'USDT',symbolType:'stock',type:'perpetual',status:'online',...patch}];
  else if(u.pathname.endsWith('/current-fund-rate'))data=[{symbol:'INTWUSDT',fundingRateInterval:'8',nextUpdate:String(start+8*3600000),maxFundingRate:'.01',minFundingRate:'-.01',fundingRate:'0'}];
  else if(u.pathname.endsWith('/candles')){
   assert.equal(u.searchParams.get('type'),'premium');
   data=Array.from({length:30},(_,i)=>[String(start+i*60000),'0','0','0','0','0','0']);
  }else throw Error('unexpected endpoint');
  return{ok:true,json:async()=>({code:'00000',requestTime:now,data})};
 },()=>now,async()=>{});
 return{query,calls};
}
test('Bitget stock/ETF perpetuals calculate with zero interest; ordinary crypto retains interest',async()=>{
 const stock=harness();const r=await stock.query('bitget','INTW');
 assert.equal(r.ok,true,r.error);assert.equal(r.predicted,0);assert.equal(r.hours,8);assert.equal(r.cap,.01);assert.equal(r.observedMinutes,30);
 assert.equal(stock.calls.length,4);
 const crypto=await harness({symbolType:'crypto'}).query('bitget','INTW');assert.equal(crypto.ok,true,crypto.error);assert.equal(crypto.predicted,.0001);
});
test('Bitget stock eligibility rejects fallback-prone or mismatched products before loading candles',async()=>{
 for(const patch of [{symbolType:'rtoken'},{symbolType:'unknown'},{isReality:'yes'},{isReality:'YES'},{category:'SPOT'},{category:'USDC-FUTURES'},{quoteCoin:'USD'},{quoteCoin:undefined},{baseCoin:'OTHER'},{symbol:'OTHERUSDT'},{type:'delivery'},{status:'offline'}]){
  const h=harness(patch);assert.equal((await h.query('bitget','INTW')).ok,false,JSON.stringify(patch));assert.deepEqual(h.calls,['/api/v3/market/instruments']);
 }
});
test('INTW actual zero and nonzero settlements use stock base interest and original complete minutes',()=>{
 const fixtures=require('./fixtures/bitget-stock-settlements.json');
 assert.ok(fixtures.some(x=>x.actual===0)&&fixtures.some(x=>x.actual!==0));
 for(const p of fixtures){assert.equal(p.rows.length,480);assert.ok(Math.abs(reconstruct(p.config,p.rows)-p.actual)*100<.002);}
 const plateau=fixtures.find(x=>x.actual===0);
 assert.ok(Math.abs(reconstruct({...plateau.config,interest:.0001},plateau.rows)-plateau.actual)*100>.009,'crypto interest must fail the stock plateau');
});
