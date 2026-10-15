// Offline chronological evaluation against realized settlement rates.
// node scripts/backtest-funding.cjs DATASET.json REPORT.json
const fs = require('node:fs');
const { fee, reconstruct } = require('../projection.js');
const methods = ['last', 'minute', 'mean5', 'mean15', 'mean30', 'mean60', 'elapsed', 'ema15', 'ema30'];
const horizons = [.05, .10, .25, .50, .75, .90, .95];
function anchor(rows, minutes, method, config) {
  const prefix = rows.slice(0, minutes);
  if (method === 'last') return prefix.at(-1).close;
  if (method === 'minute') return prefix.at(-1).p;
  if (method.startsWith('mean')) {
    const tail = prefix.slice(-Number(method.slice(4)));
    return tail.reduce((s, r) => s + r.p, 0) / tail.length;
  }
  if (method.startsWith('ema')) {
    const alpha = 2 / (Number(method.slice(3)) + 1);
    return prefix.reduce((v, r) => alpha * r.p + (1 - alpha) * v, prefix[0].p);
  }
  let sum = 0, weight = 0;
  prefix.forEach((r, i) => { const w = minuteWeight(config, i); sum += r.p * w; weight += w; });
  return sum / weight;
}
function minuteWeight(c, i) { const first = i * c.samples + 1; return c.equal ? c.samples : (2 * first + c.samples - 1) * c.samples / 2; }
function forecast(period, elapsed, method, lag = 0) {
  const c = period.config, minutes = Math.max(1, elapsed - lag - (period.exchange === 'bybit' ? 1 : 0));
  // Replay only closed, observable minutes. No future samples enter the anchor.
  const prefix = period.rows.slice(0, minutes);
  let past = 0, weight = 0;
  prefix.forEach((r, i) => { const w = minuteWeight(c, i); past += r.p * w; weight += w; });
  const n = c.hours * 60 * c.samples, total = c.equal ? n : n * (n + 1) / 2;
  return fee((past + anchor(prefix, minutes, method, c) * (total - weight)) / total, c);
}
function metrics(points) {
  if (!points.length) return null;
  const errors = points.map(p => Math.abs(p.predicted - p.actual) * 100).sort((a, b) => a - b);
  return { n: points.length, maePP: errors.reduce((a, b) => a + b, 0) / errors.length, p95PP: errors[Math.ceil(errors.length * .95) - 1], maxPP: errors.at(-1), signErrors: points.filter(p => p.predicted * p.actual < 0).length };
}
function improvementInterval(baseline, candidate) {
  // Bootstrap settlement-time clusters, not the seven correlated forecasts
  // inside a cycle. Descriptive uncertainty only, not a future error guarantee.
  const clusters = new Map();
  baseline.forEach((p, i) => {
    const bucket = clusters.get(p.end) || [];
    bucket.push((Math.abs(p.predicted - p.actual) - Math.abs(candidate[i].predicted - candidate[i].actual)) * 100);
    clusters.set(p.end, bucket);
  });
  const groups = [...clusters.values()];
  if (groups.length < 2) return null;
  let seed = 12345;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const samples = [];
  for (let k = 0; k < 1000; k++) {
    let sum = 0, n = 0;
    for (let j = 0; j < groups.length; j++) for (const v of groups[Math.floor(random() * groups.length)]) { sum += v; n++; }
    samples.push(sum / n);
  }
  samples.sort((a, b) => a - b);
  return { clusters: groups.length, lowPP: samples[25], highPP: samples[974] };
}
function run(dataset) {
  const excluded = [], periods = [], seen = new Set();
  for (const p of dataset) {
    const c = p.config, key = [p.exchange, p.coin, c.end].join(':');
    if (seen.has(key)) continue;
    try {
      if (!Number.isFinite(p.actual)) throw Error('invalid realized rate');
      p.rows = [...p.rows].sort((a, b) => a.t - b.t);
      if (p.rows.length !== c.hours * 60) throw Error('incomplete minute history');
      const rebuilt = reconstruct(c, p.rows);
      p.reconstructionErrorPP = (rebuilt - p.actual) * 100;
      // Keep every complete cycle, including possible historical cap/parameter
      // mismatches. Do not select evaluation data by whether it fits our formula.
      periods.push(p); seen.add(key);
    } catch (e) { excluded.push({ key, reason: e.message, rows: p.rows.length }); }
  }
  const venues = [...new Set(periods.map(p => p.exchange))], reports = {};
  for (const exchange of venues) {
    const all = periods.filter(p => p.exchange === exchange);
    const ends = [...new Set(all.map(p => p.config.end))].sort((a, b) => a - b);
    const trainEnd = ends[Math.max(0, Math.floor(ends.length * .6) - 1)];
    const validationEnd = ends[Math.max(1, Math.floor(ends.length * .8) - 1)];
    const folds = { train: [], validation: [], test: [] }, purged = [];
    for (const p of all) {
      const c = p.config;
      if (c.end <= trainEnd) folds.train.push(p);
      else if (c.start >= trainEnd && c.end <= validationEnd) folds.validation.push(p);
      else if (c.start >= validationEnd) folds.test.push(p);
      else purged.push([p.coin, c.end]);
    }
    function evaluate(items, lag = 0) {
      const points = Object.fromEntries(methods.map(m => [m, []]));
      for (const p of items) for (const horizon of horizons) {
        const elapsed = Math.max(2, Math.floor(p.config.hours * 60 * horizon));
        for (const method of methods) points[method].push({ coin: p.coin, end: p.config.end, horizon, actual: p.actual, predicted: forecast(p, elapsed, method, lag) });
      }
      return { metrics: Object.fromEntries(methods.map(m => [m, metrics(points[m])])), points };
    }
    const train = evaluate(folds.train), validation = evaluate(folds.validation);
    const baselineTrain = train.metrics.last, baselineValidation = validation.metrics.last;
    // Freeze selection using train/validation ONLY. Test results cannot select a
    // replacement. Require lower MAE in both, and no >10% P95/max degradation.
    const eligible = methods.filter(m => m !== 'last' && baselineTrain && baselineValidation &&
      train.metrics[m].maePP < baselineTrain.maePP && validation.metrics[m].maePP < baselineValidation.maePP * .95 &&
      validation.metrics[m].p95PP <= baselineValidation.p95PP * 1.1 + 1e-10 && validation.metrics[m].maxPP <= baselineValidation.maxPP * 1.1 + 1e-10);
    eligible.sort((a, b) => validation.metrics[a].maePP - validation.metrics[b].maePP);
    const selected = eligible[0] || 'last';
    const test = evaluate(folds.test), lagged = evaluate(folds.test, 3);
    const byHorizon = Object.fromEntries(horizons.map(h => [h, Object.fromEntries(['last', selected].map(m => [m, metrics(test.points[m].filter(p => p.horizon === h))]))]));
    const byCoin = Object.fromEntries([...new Set(folds.test.map(p => p.coin))].map(coin => [coin, Object.fromEntries(['last', selected].map(m => [m, metrics(test.points[m].filter(p => p.coin === coin))]))]));
    const worst = test.points[selected].map(p => ({ ...p, errorPP: (p.predicted - p.actual) * 100 })).sort((a, b) => Math.abs(b.errorPP) - Math.abs(a.errorPP)).slice(0, 10);
    const improvement95 = improvementInterval(test.points.last, test.points[selected]);
    const reconstructionMethods = {};
    if (all[0].config.samples === 12) for (const method of ['ohlc', 'close', 'openClose', 'hlc3']) {
      reconstructionMethods[method] = {};
      for (const [fold, items] of Object.entries(folds)) reconstructionMethods[method][fold] = metrics(items.map(p => {
        const rows = p.rows.map(r => {
          const open = 4 * r.p - r.high - r.low - r.close;
          return { ...r, p: method === 'close' ? r.close : method === 'openClose' ? (open + r.close) / 2 : method === 'hlc3' ? (r.high + r.low + r.close) / 3 : r.p };
        });
        return { actual: p.actual, predicted: reconstruct(p.config, rows) };
      }));
    }
    reports[exchange] = { cycles: all.length, coins: [...new Set(all.map(p => p.coin))], range: [new Date(Math.min(...all.map(p => p.config.start))).toISOString(), new Date(Math.max(...all.map(p => p.config.end))).toISOString()], boundaries: { trainEnd, validationEnd }, counts: Object.fromEntries(Object.entries(folds).map(([k, v]) => [k, v.length])), purged, selected, train: train.metrics, validation: validation.metrics, test: test.metrics, lag3Test: lagged.metrics, improvement95, reconstructionMethods, byHorizon, byCoin, worst, reconstruction: metrics(all.map(p => ({ actual: p.actual, predicted: p.actual + p.reconstructionErrorPP / 100 }))), reconstructionOutliers: all.filter(p => Math.abs(p.reconstructionErrorPP) > .005).map(p => ({ coin: p.coin, end: p.config.end, errorPP: p.reconstructionErrorPP })) };
  }
  return { generatedAt: new Date().toISOString(), methods, horizons, units: 'percentage points; decimal predictions in worst records', periods: periods.length, excluded, reports };
}
if (require.main === module) {
  const report = run(JSON.parse(fs.readFileSync(process.argv[2])));
  fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
  for (const [ex, r] of Object.entries(report.reports)) console.log(JSON.stringify({ ex, counts: r.counts, selected: r.selected, baseline: r.test.last, candidate: r.test[r.selected], lagBaseline: r.lag3Test.last, lagCandidate: r.lag3Test[r.selected], reconstruction: r.reconstruction }));
  console.log('periods', report.periods, 'excluded', report.excluded.length);
}
module.exports = { anchor, forecast, run, methods };
