// node scripts/assemble-funding-backtest.cjs EXPANDED_DIRECTORY [PRIOR_AUDIT_DIRECTORY]
// The optional archive is the original raw-response audit folder. Without it,
// only new public API downloads are used; do not mix the resulting reports.
const fs = require('node:fs'), path = require('node:path');
const { gatePremiumRows } = require('../projection.js');
const read = p => JSON.parse(fs.readFileSync(p));
const out = path.resolve(process.argv[2]), prior = process.argv[3], dataset = [];
for (const ex of ['binance', 'aster', 'bybit', 'bitget', 'gate', 'okx']) dataset.push(...read(path.join(out, ex + '.json')).periods);
if (prior) {
  for (const r of require('../test/fixtures/approximate-settlements.json')) dataset.push({ ...r, collection: 'prior-curated-regression', rows: r.rows.map(x => ({ t: +x[0], p: x.slice(1, 5).reduce((s, v) => s + +v, 0) / 4, close: +x[4], low: +x[3], high: +x[2], ...(r.exchange === 'bitget' ? {} : { count: +x[8] }) })) });
  for (const r of require('../test/fixtures/funding-settlements.json').filter(r => r.exchange === 'okx')) dataset.push({ ...r, coin: r.symbol.split('-')[0], collection: 'prior', rows: r.rows.map(x => ({ t: +x[0], p: +x[1], close: +x[1] })) });
  for (const r of read(path.join(prior, 'audit/bybit-boundary-report.json'))) {
    const raw = read(path.join(prior, `audit/bybit-check-${r.symbol}-${r.end}.json`));
    dataset.push({ exchange: 'bybit', coin: r.symbol.replace(/USDT$/, ''), actual: r.actual, collection: 'prior', config: { start: r.start, end: r.end, hours: r.hours, samples: 1, sampleOffset: 1, interest: .0003 * r.hours / 24, divisor: 1, floor: -1, cap: 1 }, rows: raw.data.result.list.filter(x => +x[0] > r.start && +x[0] <= r.end).map(x => ({ t: +x[0], p: +x[4], close: +x[4] })), sources: [raw.url] });
  }
  for (const sub of ['gate-deep', 'gate-holdout']) {
    const dir = path.join(prior, sub);
    for (const r of read(path.join(dir, 'report.json'))) {
      const start = Math.floor(r.start / 60) * 60, end = Math.floor(r.end / 60) * 60, prices = {};
      for (const prefix of ['mark_', 'index_']) prices[prefix] = [...new Map(fs.readdirSync(dir).filter(f => f.startsWith(prefix + r.contract + '-')).flatMap(f => read(path.join(dir, f)).data).map(p => [p.t, p])).values()].filter(p => p.t >= start && p.t < end);
      const premium = read(path.join(dir, r.contract + '-' + r.end + '.json')).data.filter(p => p.t > start && p.t <= end);
      dataset.push({ exchange: 'gate', coin: r.contract.replace(/_USDT$/, ''), collection: 'prior', actual: r.actual, config: { start: start * 1000, end: end * 1000, hours: r.hours, samples: 1, sampleOffset: 1, equal: false, interest: r.interest, divisor: 8 / r.hours, floor: -1, cap: 1 }, rows: gatePremiumRows(premium, prices.mark_, prices.index_) });
    }
  }
}
fs.writeFileSync(path.join(out, 'dataset.json'), JSON.stringify(dataset));
console.log(dataset.length, 'input periods; duplicate/quality checks run in backtest-funding.cjs');
