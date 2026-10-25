const test = require('node:test');
const assert = require('node:assert/strict');
const { project, reconstruct, fee, gatePremiumRows, createClient, UNVERIFIED } = require('../projection.js');
const start = 1792051200000;
function config(hours = 4, exchange = 'binance') {
  return { start, end: start + hours * 3600000, hours, samples: exchange === 'bybit' ? 1 : 12,
    equal: hours === 1 && exchange === 'binance', interest: exchange === 'bybit' ? .0003 * hours / 24 : .0001,
    divisor: exchange === 'bybit' ? 1 : 8 / hours, floor: -.02, cap: .02, officialRate: .0001 };
}
function rows(n, premium = -.01, samples = 12) { return Array.from({ length: n }, (_, i) => ({ t: start + i * 60000, p: premium, close: premium, count: samples })); }
test('constant premium: interval divisor and venue differences match official examples', () => {
  for (const h of [1, 2, 4, 8]) {
    const c = config(h), r = project(c, rows(20, -.01), start + 20 * 60000);
    assert.ok(Math.abs(r.predicted - (-.01 + .0005) * h / 8) < 1e-12);
  }
  assert.equal(fee(.001, config(1)), .0000625); // OKX example: 0.1% -> 0.00625%.
  assert.equal(fee(.001, config(1, 'bybit')), .0005);
  assert.ok(Math.abs(fee(0, config(4, 'bybit')) - .00005) < 1e-12);
});
test('one-hour equal weights and four-hour increasing weights use elapsed history', () => {
  const r = rows(30, 0); r.at(-1).close = .01;
  const equal = project(config(1), r, start + 30 * 60000);
  assert.equal(equal.average, .005);
  const weighted = project(config(4), r, start + 30 * 60000);
  const all = 2880 * 2881 / 2, past = 360 * 361 / 2;
  assert.ok(Math.abs(weighted.average - .01 * (all - past) / all) < 1e-12);
});
test('caps apply after cycle normalization; empty and partial history never becomes zero', () => {
  assert.equal(project(config(), rows(20, -.8), start + 20 * 60000).predicted, -.02);
  assert.equal(project(config(), rows(20, .8), start + 20 * 60000).predicted, .02);
  assert.throws(() => project(config(), [], start + 60000), /尚未更新/);
  const r = rows(20); r.splice(3, 1);
  assert.throws(() => project(config(), r, start + 20 * 60000), /缺口/);
  const partial = rows(20); partial[3].count = 9;
  assert.throws(() => project(config(), partial, start + 20 * 60000), /缺口/);
});
test('settlement rollover, stale rows and invalid parameters cannot produce a number', () => {
  assert.throws(() => project(config(), rows(20), config().end), /周期/);
  assert.throws(() => project(config(), rows(20), start + 25 * 60000), /缺口|尚未更新/);
  assert.throws(() => project({ ...config(), cap: NaN }, rows(20), start + 20 * 60000), /参数/);
});
function clientHarness({ failOnce = false, missing = false } = {}) {
  let now = start + 30 * 60000, calls = [], attempt = 0;
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (failOnce && attempt++ === 0) return { ok: false, status: 429, headers: { get: () => '1' } };
    let data;
    if (url.includes('tickers?')) data = { retCode: 0, time: now, result: { list: [{ symbol: 'BLURUSDT', nextFundingTime: config().end, fundingRate: '-.001' }] } };
    else if (url.includes('instruments-info?')) data = { retCode: 0, result: { list: [{ symbol: 'BLURUSDT', baseCoin: 'BLUR', quoteCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', fundingInterval: 240, upperFundingRate: '.02', lowerFundingRate: '-.02' }] } };
    else {
      const list = rows(Math.floor((now - start) / 60000)).map(r => [r.t + 60000, '-.01', '-.01', '-.01', '-.01']);
      if (missing) list.splice(3, 1);
      data = { retCode: 0, result: { list } };
    }
    return { ok: true, json: async () => data };
  };
  const query = createClient(fetcher, () => now, async () => {}, {fallbackAfterMs:30});
  return { query, calls, advance(ms) { now += ms; } };
}
test('shared queries coalesce and cached histories fetch only an overlap after refresh', async () => {
  const h = clientHarness();
  const [a, b] = await Promise.all([h.query('bybit', 'BLUR'), h.query('bybit', 'BLUR')]);
  assert.equal(a.ok, true); assert.equal(a, b); assert.equal(h.calls.length, 4);
  await h.query('bybit', 'BLUR'); assert.equal(h.calls.length, 4);
  h.advance(60000); assert.equal((await h.query('bybit', 'BLUR')).ok, true);
  const candle = h.calls.filter(x => x.url.includes('kline')).at(-1);
  assert.ok(Number(new URL(candle.url).searchParams.get('start')) > start);
  for (const c of h.calls) { assert.equal(c.options.credentials, 'omit'); assert.equal(c.options.redirect, 'error'); }
});
test('429 retries, persistent gaps fail closed and invalid query cannot request an arbitrary URL', async () => {
  const h = clientHarness({ failOnce: true }); assert.equal((await h.query('bybit', 'BLUR')).ok, true); assert.equal(h.calls.length, 5);
  const gap = clientHarness({ missing: true }); assert.equal((await gap.query('bybit', 'BLUR')).ok, false);
  assert.equal(gap.calls.filter(x => x.url.includes('kline') && new URL(x.url).searchParams.get('limit') !== '2').length, 2);
  const bad = clientHarness();
  assert.equal((await bad.query('evil.example', 'BLUR')).ok, false);
  assert.equal((await bad.query('binance', '../../account')).ok, false);
  assert.equal(bad.calls.length, 0);
  assert.equal((await bad.query('hyperliquid', 'BLUR')).ok, false);
});
test('real settled rates reproduce with exchange-specific minute boundaries', () => {
  const fixtures = require('./fixtures/funding-settlements.json');
  for (const f of fixtures) {
    const samples = f.rows.map(([t,p]) => ({ t, p: Number(p), close: Number(p) }));
    assert.ok(Math.abs(reconstruct(f.config, samples) - f.actual) < f.tolerance, `${f.exchange} ${f.symbol} ${f.config.hours}h`);
    if (f.exchange === 'bybit') {
      assert.ok(Math.abs(reconstruct({ ...f.config, sampleOffset: 0 }, samples) - f.actual) > f.tolerance, 'old boundary must fail against non-plateau settlement');
    }
  }
});
test('Bybit first minute excludes the preceding settlement sample and includes the minute endpoint', () => {
  const c = { ...config(1, 'bybit'), sampleOffset: 1 };
  const r = [{ t: start, p: .7, close: .7 }, { t: start + 60000, p: -.001, close: -.001 }];
  assert.ok(Math.abs(project(c, r, start + 60000).average + .001) < 1e-12);
  assert.throws(() => project(c, r.slice(0, 1), start + 60000), /缺口/);
});

test('Gate raw premium, previous-minute mark/index and weights reproduce official settlements', () => {
  const fixtures = require('./fixtures/gate-settlements.json');
  assert.ok(fixtures.some(f => f.config.hours === 1));
  assert.ok(fixtures.some(f => f.config.hours === 4));
  assert.ok(fixtures.some(f => f.config.hours === 8));
  assert.ok(fixtures.some(f => f.actual > 0));
  assert.ok(fixtures.some(f => f.actual < 0));
  for (const f of fixtures) {
    const normalized = gatePremiumRows(f.premium, f.marks, f.indices);
    const result = reconstruct(f.config, normalized);
    assert.ok(Math.abs(result - f.actual) <= 0.0000005, f.symbol);
    assert.ok(Math.abs(Math.round(result * 1e6) / 1e6 - f.actual) < 1e-12, f.symbol + ' API precision');
    if (f.symbol === 'COOL_USDT' || f.symbol === 'BLUR_USDT') {
      const raw = f.premium.map(r => ({ t: r.t * 1000, p: Number(r.c), close: Number(r.c) }));
      assert.ok(Math.abs(reconstruct(f.config, raw) - f.actual) > 0.00001, 'old direct-premium implementation must fail');
    }
  }
});

test('Gate joins three timestamped series without future prices, zero filling or conflicting values', () => {
  const t = start / 1000, premium = [{ t: t + 60, c: '-.01' }];
  const mark = [{ t, c: '95' }, { t: t + 60, c: '80' }];
  const index = [{ t, c: '100' }, { t: t + 60, c: '200' }];
  const joined = gatePremiumRows(premium, mark, index);
  assert.equal(joined.length, 1); assert.equal(joined[0].t, start + 60000);
  assert.ok(Math.abs(joined[0].p + .0095) < 1e-15); assert.equal(joined[0].close, joined[0].p);
  assert.deepEqual(gatePremiumRows(premium, mark.slice(1), index), []);
  assert.throws(() => gatePremiumRows(premium, mark, [{ t, c: '0' }]), /异常/);
  assert.throws(() => gatePremiumRows([...premium, { t: t + 60, c: '.02' }], mark, index), /冲突/);
  assert.throws(() => gatePremiumRows(premium, [{ t, c: 'oops' }], index), /缺失/);
});

function gateHarness({ mismatch = false, missing = false, delayed = false } = {}) {
  let now = start + 30 * 60000 + 10000, calls = [], metadataCalls = 0;
  const fetcher = async rawUrl => {
    calls.push(rawUrl); const u = new URL(rawUrl); let data;
    if (u.pathname.includes('/contracts/')) {
      metadataCalls++;
      data = { name: 'BLUR_USDT', type: 'direct', contract_type: '', status: 'trading', funding_interval: 14400,
        funding_next_apply: (start + 14400000) / 1000, funding_rate_limit: '.02', interest_rate: '.0003',
        funding_rate: mismatch || (delayed && metadataCalls === 1) ? '-.005' : '-.0045' };
    } else {
      const premium = u.pathname.endsWith('/premium_index');
      const c = premium ? '-.01' : u.searchParams.get('contract').startsWith('mark_') ? '95' : '100';
      data = Array.from({ length: Math.floor((now - start) / 60000) + 1 }, (_, i) => ({ t: start / 1000 + i * 60, c }));
      if (missing && !premium && u.searchParams.get('contract').startsWith('index_')) data.splice(5, 1);
    }
    return { ok: true, json: async () => data };
  };
  return { query: createClient(fetcher, () => now, async () => {}, {fallbackAfterMs:30}), calls, advance(ms) { now += ms; } };
}

test('Gate client estimates with live consistency check and incremental three-series history', async () => {
  const h = gateHarness(), r = await h.query('gate', 'BLUR');
  assert.equal(r.ok, true, r.error);
  assert.ok(Math.abs(r.predicted + .0045) < 1e-12);
  assert.equal(r.observedMinutes, 30);
  assert.match(r.method, /已核对/);
  assert.equal(h.calls.length, 7);
  h.advance(60000);
  assert.equal((await h.query('gate', 'BLUR')).ok, true);
  const priceUrl = new URL(h.calls.filter(u => u.includes('candlesticks')).at(-1));
  assert.ok(Number(priceUrl.searchParams.get('from')) > start / 1000);
});

test('Gate repairs unsynchronized history and uses only marked current snapshots after persistent failure', async () => {
  const recovered = gateHarness({ delayed: true });
  assert.equal((await recovered.query('gate', 'BLUR')).ok, true);
  assert.equal(recovered.calls.filter(u => u.includes('/contracts/')).length, 2);
  const bad = gateHarness({ mismatch: true });
  const result = await bad.query('gate', 'BLUR');
  assert.equal(result.ok, true, result.error); assert.equal(result.kind, 'current-only'); assert.ok(Math.abs(result.predicted + .0045) < 1e-12);
  const gap = gateHarness({ missing: true });
  assert.equal((await gap.query('gate', 'BLUR')).kind, 'current-only');
  assert.equal(gap.calls.filter(u => u.includes('/premium_index') && new URL(u).searchParams.get('limit') !== '3').length, 2);
});
