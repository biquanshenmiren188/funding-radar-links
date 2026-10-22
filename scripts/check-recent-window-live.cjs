// Public API smoke check. Usage: node ... OUTPUT_DIRECTORY
const fs=require('node:fs'),path=require('node:path');
const {createClient,EXCHANGES}=require('../projection.js');
const out=path.resolve(process.argv[2]),raw=[];fs.mkdirSync(out,{recursive:true});
const query=createClient(async(url,options)=>{
  const response=await fetch(url,options),copy=response.clone();
  try{raw.push({url,body:options?.body,status:response.status,fetchedAt:new Date().toISOString(),data:await copy.json()});}catch{}
  return response;
});
(async()=>{
  const pairs=[...EXCHANGES.map(ex=>[ex,'BTC']),['binance','IRYS'],['aster','IRYS'],['bitget','IRYS'],['gate','BULLA'],['binance','RLC']];
  const results=await Promise.all(pairs.map(async([exchange,coin])=>{
    const r=await query(exchange,coin);console.log(exchange,coin,r.ok,r.error||r.forecastMethod||r.kind);return {exchange,coin,...r};
  }));
  fs.writeFileSync(path.join(out,'live-new.json'),JSON.stringify(results,null,2));
  fs.writeFileSync(path.join(out,'live-new-raw.json'),JSON.stringify(raw));
  if(results.some(r=>!r.ok)) process.exitCode=1;
})();
