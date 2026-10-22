const test = require('node:test');
const assert = require('node:assert/strict');
const { forecast, methods, run } = require('../scripts/backtest-funding.cjs');
const { project, reconstruct, gatePremiumRows, FORECAST_METHODS } = require('../projection.js');
const fixtures = require('./fixtures/approximate-settlements.json');
const exact = require('./fixtures/funding-settlements.json');
function normalized(p) {
  return { ...p, rows: p.rows.map(r => p.config.samples === 12 ? { t: +r[0], p: r.slice(1, 5).reduce((s, v) => s + +v, 0) / 4, close: +r[4], low: +r[3], high: +r[2], ...(p.exchange === 'bitget' ? {} : { count: +r[8] }) } : { t: +r[0], p: +r[1], close: +r[1] }) };
}
test('backtest baseline replays production weights, minute boundaries and Bybit lag', () => {
  for (const fixture of [...fixtures, ...exact]) {
    const p = normalized(fixture);
    p.rows = p.rows.filter(r => Math.floor((r.t - p.config.start) / 60000) >= (p.config.sampleOffset || 0));
    p.rows.sort((a, b) => a.t - b.t);
    for (const elapsed of [5, 15, Math.floor(p.config.hours * 30)]) {
      const actual = project({ ...p.config, forecastLagMinutes: p.exchange === 'bybit' ? 1 : 0 }, p.rows, p.config.start + elapsed * 60000);
      assert.ok(Math.abs(forecast(p, elapsed, 'last') - actual.predicted) < 1e-12, `${p.exchange} ${elapsed}`);
    }
  }
});
test('all candidate forecasts are invariant to future prices and future target rates', () => {
  const p = normalized(fixtures[0]);
  p.rows.sort((a, b) => a.t - b.t);
  const elapsed = 15;
  for (const method of methods) {
    const expected = forecast(p, elapsed, method);
    const poisoned = { ...p, actual: 999, rows: p.rows.map((r, i) => i >= elapsed ? { ...r, p: 1000, close: -1000 } : r) };
    assert.equal(forecast(poisoned, elapsed, method), expected, method);
    assert.equal(forecast({ ...p, rows: p.rows.slice(0, elapsed) }, elapsed, method), expected, method);
  }
});
test('three-minute delayed replay cannot consume the delayed samples', () => {
  const p = normalized(fixtures[0]);
  p.rows.sort((a, b) => a.t - b.t);
  for (const method of methods) {
    assert.equal(forecast(p, 15, method, 3), forecast({ ...p, rows: p.rows.slice(0, 12) }, 12, method));
  }
});
test('holdout realized rates cannot choose the candidate method', () => {
  const periods = Array.from({ length: 20 }, (_, k) => {
    const start = 1700002800000 + k * 3600000;
    const config = { start, end: start + 3600000, hours: 1, samples: 1, equal: true, interest: .0001, divisor: 8, floor: -1, cap: 1 };
    const rows = Array.from({ length: 60 }, (_, i) => ({ t: start + i * 60000, p: i % 2 ? .004 : 0, close: i % 2 ? .004 : 0 }));
    return { exchange: 'example', coin: 'AAA', config, rows, actual: reconstruct(config, rows) };
  });
  const a = run(periods).reports.example;
  assert.notEqual(a.selected, 'last');
  const changed = periods.map(p => p.config.start >= a.boundaries.validationEnd ? { ...p, actual: .5 } : p);
  assert.equal(run(changed).reports.example.selected, a.selected);
});
test('adopted production methods match the independently evaluated replay on official histories', () => {
  const periods = fixtures.map(normalized);
  for (const f of require('./fixtures/gate-settlements.json')) periods.push({ ...f, exchange: 'gate', rows: gatePremiumRows(f.premium, f.marks, f.indices) });
  for (const p of periods) {
    p.rows.sort((a, b) => a.t - b.t);
    const method = FORECAST_METHODS[p.exchange];
    for (const elapsed of [15, 30, Math.floor(p.config.hours * 30)]) {
      const live = project({ ...p.config, forecastMethod: method }, p.rows, p.config.start + elapsed * 60000);
      assert.ok(Math.abs(live.predicted - forecast(p, elapsed, method)) < 1e-12, `${p.exchange} ${method} ${elapsed}`);
      const poisoned = p.rows.map(r => r.t >= p.config.start + elapsed * 60000 + (p.config.sampleOffset || 0) * 60000 ? { ...r, p: .9, close: .9 } : r);
      assert.equal(project({ ...p.config, forecastMethod: method }, poisoned, p.config.start + elapsed * 60000).predicted, live.predicted);
      assert.equal(live.forecastMethod, method);
    }
  }
});
test('Gate smoothing leaves its accrued-rate reconciliation and completed settlement unchanged', () => {
  const f = require('./fixtures/gate-settlements.json')[0];
  const rows = gatePremiumRows(f.premium, f.marks, f.indices);
  const config = { ...f.config, forecastMethod: 'ema30' };
  assert.equal(reconstruct(config, rows), reconstruct(f.config, rows));
  assert.throws(() => project({ ...config, verifyGate: true, officialRate: .9 }, rows, config.start + 15 * 60000), /官方费率/);
});
test('captured Aster ZEREBRO zero-close jump retains the historical minute-anchor regression', () => {
  const f = require('./fixtures/aster-zerebro-forecast.json');
  const p = normalized({ ...f, exchange: 'aster' });
  const display = (n, method) => (project({ ...f.config, forecastMethod: method }, p.rows, f.config.start + n * 60000).predicted * 100).toFixed(3);
  assert.deepEqual([display(13, 'last'), display(14, 'last')], ['0.005', '0.043']);
  assert.deepEqual([display(13, 'minute'), display(14, 'minute')], ['0.041', '0.043']);
  for (const n of [13,14]) assert.equal(display(n, FORECAST_METHODS.aster), (forecast(p,n,'mean10')*100).toFixed(3));
  // This regression checks snapshot behavior, not its eventual realized error.
});
test('runtime venue policy matches development-only recent-window selection and explicit user adoption', () => {
  for (const [exchange, r] of Object.entries(require('../audit/recent-window-20261022.json').reports)) assert.equal(FORECAST_METHODS[exchange], r.selected);
  assert.equal(FORECAST_METHODS.hyperliquid, 'official');
});
