// Separate exploratory comparison. A reconstructed rolling window is NOT an
// archived exchange prediction and must not be described as such.
const fs = require('node:fs');
const { reconstruct } = require('../projection.js');
const { forecast } = require('./backtest-funding.cjs');
const raw = JSON.parse(fs.readFileSync(process.argv[2])), valid = new Map();
for (const p of raw) {
  const key = [p.exchange, p.coin, p.config.end].join(':');
  if (valid.has(key)) continue;
  try { if (p.rows.length !== p.config.hours * 60) continue; reconstruct(p.config, p.rows); p.rows.sort((a, b) => a.t - b.t); valid.set(key, p); } catch (_) {}
}
const results = {};
function metric(xs) {
  const es = xs.map(x => Math.abs(x) * 100).sort((a, b) => a - b);
  return { n: es.length, maePP: es.reduce((a, b) => a + b, 0) / es.length, p95PP: es[Math.ceil(es.length * .95) - 1], maxPP: es.at(-1) };
}
for (const ex of [...new Set([...valid.values()].map(p => p.exchange))]) {
  const rows = [...valid.values()].filter(p => p.exchange === ex), scores = { last: [], rollingProxy: [], previousSettlement: [] };
  let cycles = 0;
  for (const p of rows) {
    const prev = valid.get([ex, p.coin, p.config.start].join(':'));
    if (!prev || prev.config.hours !== p.config.hours) continue;
    cycles++;
    for (const h of [.05, .10, .25, .50, .75, .90, .95]) {
      const elapsed = Math.max(2, Math.floor(p.config.hours * 60 * h));
      const count = elapsed - (ex === 'bybit' ? 1 : 0);
      const rolling = [...prev.rows.slice(count), ...p.rows.slice(0, count)].map((r, i) => ({ ...r, t: p.config.start + (i + (p.config.sampleOffset || 0)) * 60000 }));
      scores.last.push(forecast(p, elapsed, 'last') - p.actual);
      scores.rollingProxy.push(reconstruct(p.config, rolling) - p.actual);
      scores.previousSettlement.push(prev.actual - p.actual);
    }
  }
  results[ex] = { cycles, metrics: Object.fromEntries(Object.entries(scores).map(([m, xs]) => [m, metric(xs)])) };
}
fs.writeFileSync(process.argv[3], JSON.stringify({ note: 'Exploratory only; rolling proxy is reconstructed, not recorded official forecasts. Same adjacent complete cycles for all methods. No production selection from these results.', results }, null, 2));
console.log(JSON.stringify(results));
