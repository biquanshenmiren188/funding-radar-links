// Freeze per-exchange candidates BEFORE fetching an additional coin holdout.
// No test/holdout metrics participate in this selection.
const fs = require('node:fs'), crypto = require('node:crypto');
const input = fs.readFileSync(process.argv[2]), report = JSON.parse(input), selected = {};
for (const [exchange, r] of Object.entries(report.reports)) {
  const base = r.validation.last;
  const candidates = Object.keys(r.validation).filter(m => m === 'last' || r.train[m].maePP < r.train.last.maePP && r.validation[m].maePP < base.maePP);
  const ranking = candidates.map(method => ({ method, score: .5 * r.validation[method].maePP / base.maePP + .3 * r.validation[method].p95PP / base.p95PP + .2 * r.validation[method].maxPP / base.maxPP })).sort((a, b) => a.score - b.score);
  selected[exchange] = { method: ranking[0].method, ranking };
}
const result = { frozenAt: new Date().toISOString(), developmentReportSHA256: crypto.createHash('sha256').update(input).digest('hex'), rule: 'Require lower train and validation MAE; minimize validation score = 0.5 normalized MAE + 0.3 normalized P95 + 0.2 normalized maximum. Retain last if no better risk score. Exploratory prior holdout has been inspected; a separate newly fetched coin cohort is the next acceptance check.', additionalCoins: ['DOGE', 'SUI', 'FARTCOIN', 'HYPE'], acceptance: 'Candidate must lower MAE on both temporal test and new coin holdout; P95 and max no more than 10% worse on either; three-minute lag MAE must not worsen. Otherwise retain the previous method. No alternative may be chosen using the new holdout.', selected };
fs.writeFileSync(process.argv[3], JSON.stringify(result, null, 2));
console.log(Object.fromEntries(Object.entries(selected).map(([ex, r]) => [ex, r.method])));
