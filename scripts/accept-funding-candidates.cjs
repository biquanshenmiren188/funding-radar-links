// node scripts/accept-funding-candidates.cjs DEV_DATA DEV_REPORT FROZEN HOLDOUT_DIR OUTPUT
const fs = require('node:fs'), path = require('node:path');
const { reconstruct } = require('../projection.js');
const { forecast } = require('./backtest-funding.cjs');
const read = p => JSON.parse(fs.readFileSync(p));
const development = read(process.argv[2]), report = read(process.argv[3]), frozen = read(process.argv[4]), directory = process.argv[5];
const used = new Set(development.map(p => [p.exchange, p.coin, p.config.end].join(':')));
function metrics(xs) {
  const errors = xs.map(p => Math.abs(p.predicted - p.actual) * 100).sort((a, b) => a - b);
  return errors.length ? { n: errors.length, maePP: errors.reduce((a, b) => a + b, 0) / errors.length, p95PP: errors[Math.ceil(errors.length * .95) - 1], maxPP: errors.at(-1), signErrors: xs.filter(p => p.predicted * p.actual < 0).length } : null;
}
const results = {};
for (const [ex, selection] of Object.entries(frozen.selected)) {
  const downloaded = read(path.join(directory, ex + '.json')), periods = [], excluded = [];
  for (const p of downloaded.periods) {
    const key = [ex, p.coin, p.config.end].join(':');
    if (used.has(key)) { excluded.push({ key, reason: 'seen in development; removed from holdout' }); continue; }
    try {
      if (p.rows.length !== p.config.hours * 60) throw Error('incomplete history');
      reconstruct(p.config, p.rows);
      periods.push(p);
    } catch (e) { excluded.push({ key, reason: e.message }); }
  }
  const method = selection.method, points = { last: [], candidate: [], lagLast: [], lagCandidate: [] };
  for (const p of periods) for (const h of [.05, .10, .25, .50, .75, .90, .95]) {
    const elapsed = Math.max(2, Math.floor(p.config.hours * 60 * h));
    for (const [key, m, lag] of [['last', 'last', 0], ['candidate', method, 0], ['lagLast', 'last', 3], ['lagCandidate', method, 3]]) points[key].push({ coin: p.coin, end: p.config.end, horizon: h, actual: p.actual, predicted: forecast(p, elapsed, m, lag) });
  }
  const holdout = Object.fromEntries(Object.entries(points).map(([k, p]) => [k, metrics(p)]));
  const dev = report.reports[ex], checks = {};
  for (const [label, baseline, candidate] of [['temporal', dev.test.last, dev.test[method]], ['newCoins', holdout.last, holdout.candidate]]) {
    checks[label + 'LowerMAE'] = !!candidate && candidate.maePP < baseline.maePP;
    checks[label + 'Tail'] = !!candidate && candidate.p95PP <= baseline.p95PP * 1.1 + 1e-10 && candidate.maxPP <= baseline.maxPP * 1.1 + 1e-10;
  }
  checks.delayed = !!holdout.lagCandidate && holdout.lagCandidate.maePP <= holdout.lagLast.maePP && dev.lag3Test[method].maePP <= dev.lag3Test.last.maePP;
  checks.minimumCoverage = periods.length >= 12 && new Set(periods.map(p => p.coin)).size >= 2;
  const accepted = method !== 'last' && Object.values(checks).every(Boolean);
  results[ex] = { candidate: method, adopted: accepted ? method : 'last', accepted, checks, periods: periods.length, coins: [...new Set(periods.map(p => p.coin))], holdout, byCoin: Object.fromEntries([...new Set(periods.map(p => p.coin))].map(coin => [coin, { last: metrics(points.last.filter(p => p.coin === coin)), candidate: metrics(points.candidate.filter(p => p.coin === coin)) }])), excluded, failures: downloaded.failures };
}
fs.writeFileSync(process.argv[6], JSON.stringify({ frozenAt: frozen.frozenAt, evaluatedAt: new Date().toISOString(), note: 'Same frozen candidate for all checks; never choose another using holdout. Passing establishes relative historical improvement only, not a bound on future error.', results }, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([ex, r]) => [ex, { candidate: r.candidate, adopted: r.adopted, checks: r.checks, periods: r.periods, holdout: r.holdout }]))));
