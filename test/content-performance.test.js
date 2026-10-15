const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('index mutations coalesce and use the index-only renderer instead of all card features',async()=>{
 let observer,frame, indexUpdates=0, fullUpdates=0;
 const card={isConnected:false};
 const row={textContent:'实时指数: -1 | -2',closest:selector=>selector==='.ant-card'?card:null};
 const node={nodeType:1,closest:selector=>selector==='p'?row:null};
 const context={console,Node:{TEXT_NODE:3,ELEMENT_NODE:1},location:{origin:'https://local.test'},
  document:{hidden:false,body:{},querySelectorAll:()=>[card],addEventListener(){},removeEventListener(){}},
  requestAnimationFrame:fn=>{frame=fn;return 1},cancelAnimationFrame(){},setTimeout(){},clearTimeout(){},
  MutationObserver:class{constructor(fn){observer=fn}observe(){}disconnect(){}},
  FundingRadarLinking:{DEFAULT_RADAR_ORIGIN:'https://radar.test',readCard(){fullUpdates++;throw Error('unexpected full render')}},
  FundingRadarLimits:{settings:()=>({enabled:false}),parseCoins:()=>[],createReleaseTracker:()=>()=>false},
  FundingRadarAlerts:{createNotifier:()=>({clear(){}})},
  FundingRadarInlineRisk:{create:()=>({start(){},stop(){},render(){},visibilityChanged(){}})},
  FundingRadarProjectionInline:{create:()=>({start(){},stop(){},updateIndex(){indexUpdates++},render(){fullUpdates++}})},
  chrome:{storage:{local:{get:async()=>({siteOrigin:'https://local.test'})},onChanged:{addListener(){},removeListener(){}}}}
 };
 vm.runInNewContext(fs.readFileSync(require.resolve('../content.js'),'utf8'),context);
 await new Promise(r=>setImmediate(r));frame();card.isConnected=true;
 observer(Array.from({length:100},()=>({target:node,addedNodes:[]})));frame();
 assert.equal(indexUpdates,1);assert.equal(fullUpdates,0);
});
