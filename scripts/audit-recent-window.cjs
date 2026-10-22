// Public historical replay: user's constant recent-5/10-minute premium scenario.
// Does not fit exchange formulas, interest, sampling weights or historical caps.
const fs = require('node:fs'), path = require('node:path');
const { reconstruct, reconstructRange } = require('../projection.js');
const { forecast } = require('./backtest-funding.cjs');
const BASELINE = Object.freeze({binance:'minute',aster:'minute',bybit:'last',bitget:'last',gate:'ema30',okx:'last'});
const HOLDOUT = new Set(['RLC','IRYS','BULLA','SAND']);
function metric(points) {
  if (!points.length) return null;
  const xs = points.map(p=>Math.abs(p.predicted-p.actual)*100).sort((a,b)=>a-b);
  return {n:xs.length,maePP:xs.reduce((a,b)=>a+b,0)/xs.length,p95PP:xs[Math.ceil(xs.length*.95)-1],maxPP:xs.at(-1)};
}
function run(directory) {
  const reports = {};
  for (const [ex,baseline] of Object.entries(BASELINE)) {
    const source=JSON.parse(fs.readFileSync(path.join(directory,ex+'.json'))), valid=[],excluded=[];
    for(const p of source.periods) {
      try {
        if(p.rows.length!==p.config.hours*60) throw Error('incomplete history');
        const rebuilt=reconstruct(p.config,p.rows);
        const range=p.config.samples===12?reconstructRange(p.config,p.rows):null;
        valid.push({...p,rebuilt,range});
      } catch(e) {excluded.push({coin:p.coin,end:p.config.end,reason:e.message});}
    }
    const development=valid.filter(p=>!HOLDOUT.has(p.coin));
    const ends=[...new Set(development.map(p=>p.config.end))].sort((a,b)=>a-b);
    const cutoff=ends[Math.max(0,Math.floor(ends.length*.65)-1)];
    const folds={development:development.filter(p=>p.config.end<=cutoff),timeTest:development.filter(p=>p.config.start>=cutoff),coinTest:valid.filter(p=>HOLDOUT.has(p.coin))};
    const results={};
    for(const [fold,periods] of Object.entries(folds)) {
      const points={baseline:[],mean5:[],mean10:[]};
      const horizons=[.05,.10,.25,.5,.75,.9,.95];
      for(const p of periods) for(const horizon of horizons) {
        const elapsed=Math.max(11,Math.floor(p.config.hours*60*horizon));
        // Deduplicate early horizons that map to the same minute (especially 1h).
        if(horizons.some(h=>h<horizon && Math.max(11,Math.floor(p.config.hours*60*h))===elapsed)) continue;
        for(const method of Object.keys(points)) points[method].push({coin:p.coin,end:p.config.end,hours:p.config.hours,elapsed,horizon,actual:p.actual,predicted:forecast(p,elapsed,method==='baseline'?baseline:method)});
      }
      results[fold]={cycles:periods.length,metrics:Object.fromEntries(Object.entries(points).map(([m,ps])=>[m,metric(ps)])),byHours:Object.fromEntries([...new Set(periods.map(p=>p.config.hours))].map(h=>[h,Object.fromEntries(Object.entries(points).map(([m,ps])=>[m,metric(ps.filter(p=>p.hours===h))]))])),byCoin:Object.fromEntries([...new Set(periods.map(p=>p.coin))].map(c=>[c,Object.fromEntries(Object.entries(points).map(([m,ps])=>[m,metric(ps.filter(p=>p.coin===c))]))]))};
    }
    // Select 5 vs 10 using development only. Never use test targets to tune.
    const dev=results.development.metrics;
    const selected=dev.mean5 && dev.mean10 && dev.mean5.maePP<dev.mean10.maePP?'mean5':'mean10';
    reports[ex]={baseline,selected,complete:valid.length,excluded,failures:source.failures,cutoff,results,reconstruction:metric(valid.map(p=>({actual:p.actual,predicted:p.rebuilt}))),outsideSamplingEnvelope:valid.filter(p=>p.range&&(p.actual<p.range[0]-1e-8||p.actual>p.range[1]+1e-8)).map(p=>({coin:p.coin,end:p.config.end,actual:p.actual,range:p.range})),worstReconstruction:valid.sort((a,b)=>Math.abs(b.actual-b.rebuilt)-Math.abs(a.actual-a.rebuilt)).slice(0,8).map(p=>({coin:p.coin,hours:p.config.hours,end:p.config.end,actual:p.actual,rebuilt:p.rebuilt,errorPP:(p.rebuilt-p.actual)*100}))};
  }
  return {generatedAt:new Date().toISOString(),units:'percentage points',policy:'Only mean5 and mean10; development-only choice, independent time/coin tests. First 10 elapsed minutes excluded, never shorten the lookback. Historical caps and interest changes are not fully archived; uncapped replay, not exact historical plugin output.',reports};
}
if(require.main===module){const report=run(process.argv[2]);fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2));for(const[ex,r]of Object.entries(report.reports))console.log(JSON.stringify({ex,complete:r.complete,excluded:r.excluded.length,reconstruction:r.reconstruction,outsideEnvelope:r.outsideSamplingEnvelope.length,selected:r.selected,time:r.results.timeTest.metrics,coin:r.results.coinTest.metrics}));}
module.exports={run,metric,BASELINE};
