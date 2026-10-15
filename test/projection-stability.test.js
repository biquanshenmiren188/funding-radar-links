const test = require('node:test');
const assert = require('node:assert/strict');
const { project, createClient } = require('../projection.js');
const f = require('./fixtures/rlc-minute-stability.json');

test('captured RLC: a new unfinished candle cannot change the same-minute forecast', () => {
  const early = project(f.config, f.rows, f.early);
  const late = project(f.config, [...f.rows, f.partial], f.late);
  assert.ok(Math.abs(f.oldPredictions[1] - f.oldPredictions[0]) > .0003);
  assert.equal(early.predicted, late.predicted);
  assert.equal(early.currentPremium, late.currentPremium);
  assert.equal(early.dataAsOf, late.dataAsOf);
  assert.ok(early.futureWeightRatio > .79);
});

test('all local adapters anchor to validated history, respecting the Bybit candle delay', () => {
  for (const exchange of ['binance', 'aster', 'bitget', 'bybit', 'okx', 'gate']) {
    const start = f.config.start;
    const samples = ['binance', 'aster', 'bitget'].includes(exchange) ? 12 : 1;
    const offset = ['bybit', 'gate'].includes(exchange) ? 1 : 0;
    const lag = exchange === 'bybit' ? 1 : 0;
    const config = { ...f.config, samples, sampleOffset: offset, forecastLagMinutes: lag, bounded: samples === 12 };
    const rows = Array.from({ length: 30 - lag }, (_, i) => ({ t: start + (i + offset) * 60000, p: -.01, close: -.01, low: -.01, high: -.01, count: samples }));
    const future = { t: start + (30 - lag + offset) * 60000, p: -.08, close: -.09, low: -.1, high: -.01, count: 1 };
    const before = project(config, rows, start + 30 * 60000 + 10000);
    const after = project(config, [...rows, future], start + 30 * 60000 + 50000);
    assert.equal(before.predicted, after.predicted, exchange);
    assert.equal(after.observedMinutes, 30 - lag, exchange);
    assert.equal(after.currentPremium, -.01, exchange);
  }
});

test('new completed minute updates the estimate; first-minute and missing-history gaps stay errors', () => {
  const complete = { ...f.partial, p: f.partial.close, count: 12 };
  const before = project(f.config, f.rows, f.early);
  const after = project(f.config, [...f.rows, complete], f.partial.t + 60000);
  assert.notEqual(before.predicted, after.predicted);
  assert.equal(after.currentPremium, complete.close);
  assert.throws(() => project(f.config, [f.rows[0]], f.config.start + 10000), /完整分钟/);
  assert.throws(() => project(f.config, f.rows.slice(1), f.early), /缺口/);
});

test('same-minute cache shares a validated snapshot; minute rollover refetches inputs', async () => {
  let now = f.early, calls = 0;
  const fetcher = async url => {
    calls++;
    let data;
    if (url.includes('premiumIndex?')) data = { symbol: 'RLCUSDT', interestRate: '.0001', lastFundingRate: '-.00063238', nextFundingTime: f.config.end, time: now };
    else if (url.includes('fundingInfo')) data = [{ symbol: 'RLCUSDT', fundingIntervalHours: 4, adjustedFundingRateCap: '.02', adjustedFundingRateFloor: '-.02' }];
    else data = [...f.rows, { ...f.partial, count: 12 }].map(r => [r.t,r.p,r.high,r.low,r.close,0,r.t+59999,0,r.count]);
    return { ok: true, json: async () => data };
  };
  const q = createClient(fetcher, () => now, async () => {});
  const a = await q('binance', 'RLC'); assert.equal(a.ok, true);
  const firstCalls = calls;
  now = f.late; assert.equal(await q('binance', 'RLC'), a); assert.equal(calls, firstCalls);
  now = f.partial.t + 60000;
  const b = await q('binance', 'RLC'); assert.equal(b.ok, true); assert.notEqual(b.dataAsOf, a.dataAsOf); assert.ok(calls > firstCalls);
});
