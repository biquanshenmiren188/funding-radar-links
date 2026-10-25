const test = require('node:test'), assert = require('node:assert/strict');
const { createClient, fee } = require('../projection.js');
const M = 60000, start = 1792627200000, venues = ['binance', 'aster', 'bybit', 'bitget', 'gate'];
const flush = () => new Promise(setImmediate), reply = data => ({ ok: true, json: async () => data });

function harness(t, exchange, initial = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = start + 30 * M + 10000, mode = 'stall', tailMode = 'valid', parameterAge = 0, premium = -.004;
  const calls = [], signals = [], progress = [];
  const state = Object.assign({ sourceAge: 0, badClose: false, wrongIdentity: false }, initial);
  const row = (time, value, count = 12) => [time, value, value, value, value, 0, time + M - 1, 0, count];
  const query = createClient(async (raw, options) => {
    const u = new URL(raw), p = u.pathname, tail = ['2', '3', '5'].includes(u.searchParams.get('limit'));
    calls.push(u);
    if (p.endsWith('/premiumIndex')) return reply({ symbol: 'AAAUSDT', nextFundingTime: start + 4 * 60 * M,
      lastFundingRate: '-.0007', interestRate: '.0001', time: now - parameterAge });
    if (p.endsWith('/fundingInfo')) return reply([{ symbol: 'AAAUSDT', fundingIntervalHours: 4,
      adjustedFundingRateCap: '.02', adjustedFundingRateFloor: '-.02', fundingFeeCap: '.02', fundingFeeFloor: '-.02' }]);
    if (p.endsWith('/instruments-info')) return reply({ retCode: 0, result: { list: [{ symbol: 'AAAUSDT', baseCoin: 'AAA',
      quoteCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', fundingInterval: 240, upperFundingRate: '.02', lowerFundingRate: '-.02' }] } });
    if (p.endsWith('/tickers')) return reply({ retCode: 0, time: now - parameterAge, result: { list: [{ symbol: 'AAAUSDT', nextFundingTime: start + 4 * 60 * M, fundingRate: '-.0007' }] } });
    if (p.endsWith('/instruments')) return reply({ code: '00000', data: [{ symbol: 'AAAUSDT', baseCoin: 'AAA', quoteCoin: 'USDT',
      category: 'USDT-FUTURES', symbolType: 'crypto', type: 'perpetual', status: 'online' }] });
    if (p.endsWith('/current-fund-rate')) return reply({ code: '00000', requestTime: now - parameterAge,
      data: [{ symbol: 'AAAUSDT', fundingRateInterval: '4', nextUpdate: start + 4 * 60 * M, minFundingRate: '-.02', maxFundingRate: '.02', fundingRate: '-.0007' }] });
    if (p.includes('/contracts/')) return reply({ name: 'AAA_USDT', type: 'direct', status: 'trading', funding_interval: 14400,
      funding_next_apply: (start + 4 * 60 * M) / 1000, funding_rate_limit: '.02', interest_rate: '.0003', funding_rate: '-.0007' });
    const sampled = Math.floor(now / M) * M - state.sourceAge;
    if (tail) {
      signals.push(options.signal);
      if (tailMode === 'stall') return new Promise(() => {});
      if (tailMode === 'empty') return reply(exchange === 'bybit' ? { retCode: 0, result: { symbol: 'AAAUSDT', category: 'linear', list: [] } } : exchange === 'bitget' ? { code: '00000', data: [] } : []);
      if (exchange === 'gate') {
        assert.equal(u.searchParams.has('from'), false); assert.equal(u.searchParams.has('to'), false);
        if (p.endsWith('/premium_index')) return reply([{ t: (sampled - M) / 1000, c: '.5' }, { t: sampled / 1000, c: String(premium) }]);
        const mark = u.searchParams.get('contract').startsWith('mark_');
        return reply([{ t: sampled / 1000, c: mark ? '1' : '100' },
          ...(tailMode === 'missing-join' ? [] : [{ t: (sampled - M) / 1000, c: mark ? '95' : '100' }])]);
      }
      const latest = row(sampled, premium, 2);
      if (state.badClose) latest[6] += M;
      const rows = [latest, row(sampled - M, '.7')]; // Deliberately newest first.
      if (tailMode === 'conflict') rows.push(row(sampled, '.8'));
      if (exchange === 'bybit') return reply({ retCode: 0, result: { symbol: state.wrongIdentity ? 'OTHERUSDT' : 'AAAUSDT', category: 'linear', list: rows } });
      if (exchange === 'bitget') { assert.equal(u.searchParams.get('type'), 'premium'); return reply({ code: '00000', data: rows }); }
      return reply(rows);
    }
    signals.push(options.signal);
    if (mode === 'stall') return new Promise(() => {});
    const count = Math.floor((now - start) / M);
    if (exchange === 'gate') {
      const isPremium = p.endsWith('/premium_index'), mark = u.searchParams.get('contract')?.startsWith('mark_');
      return reply(Array.from({ length: count + 1 }, (_, i) => ({ t: start / 1000 + i * 60, c: isPremium ? '-.002' : mark ? '95' : '100' }))
        .filter((_, i) => mode !== 'gap' || i !== 5));
    }
    const rows = Array.from({ length: count }, (_, i) => row(start + i * M, '-.002')).filter((_, i) => mode !== 'gap' || i !== 5);
    if (exchange === 'bybit') return reply({ retCode: 0, result: { list: rows } });
    if (exchange === 'bitget') return reply({ code: '00000', data: rows });
    return reply(rows);
  }, () => now, async () => {});
  return { query: options => query(exchange, 'AAA', { onProgress: p => progress.push(p), ...options }), calls, signals, progress,
    get now() { return now; }, mode(v) { mode = v; }, tail(v) { tailMode = v; }, premium(v) { premium = v; }, parameterAge(v) { parameterAge = v; },
    async advance(ms) { now += ms; t.mock.timers.tick(ms); await flush(); } };
}

test('every historical venue waits exactly 30 seconds, uses its own premium and recovers normal history', async t => {
  for (const exchange of venues) await t.test(exchange, async t => {
    const h = harness(t, exchange), sourceTime = Math.floor(h.now / M) * M;
    let done = false; const pending = h.query().then(r => { done = true; return r; }); await flush();
    await h.advance(29999); assert.equal(done, false);
    await h.advance(1); const r = await pending;
    assert.equal(r.ok, true, r.error); assert.equal(r.kind, 'current-only');
    const current = exchange === 'gate' ? -.004 * 95 / 100 : -.004;
    assert.equal(r.currentPremium, current); assert.equal(r.sourceTime, sourceTime); assert.equal(r.premiumAt, sourceTime);
    assert.equal(r.predicted, fee(current, { interest: exchange === 'bybit' ? .00005 : .0001, divisor: exchange === 'bybit' ? 1 : 2, floor: -.02, cap: .02 }));
    assert.equal(h.signals.at(-1).aborted, true);
    await h.advance(10000); h.premium(0);
    const refreshed = await h.query(); assert.equal(refreshed.kind, 'current-only'); assert.equal(refreshed.currentPremium, 0);
    await h.advance(20000); h.mode('complete');
    const recovered = await h.query(); assert.equal(recovered.ok, true, recovered.error); assert.equal(recovered.kind, undefined);
    assert.equal(recovered.forecastMethod, exchange === 'bybit' ? 'mean5' : 'mean10');
    assert.ok(h.progress.some(p => p.stage === 'current-only'));
  });
});

test('a hung current-premium probe is canceled after five seconds and does not block normal history', async t => {
  for (const exchange of venues) await t.test(exchange, async t => {
    const h = harness(t, exchange); h.tail('stall'); h.mode('complete');
    const pending = h.query(); await flush(); await h.advance(5000);
    const r = await pending; assert.equal(r.ok, true, r.error); assert.equal(r.kind, undefined);
    assert.equal(h.signals[0].aborted, true);
  });
});

test('closed candle time is distinct from sourceTime; future or malformed close timestamps cannot renew data', async t => {
  for (const exchange of ['binance', 'aster', 'bybit', 'bitget']) await t.test(exchange, async t => {
    const h = harness(t, exchange, { sourceAge: 2 * M });
    const sourceTime = Math.floor(h.now / M) * M - 2 * M;
    const pending = h.query(); await flush(); await h.advance(30000);
    const r = await pending; assert.equal(r.ok, true, r.error);
    assert.equal(r.sourceTime, sourceTime);
    assert.equal(r.premiumAt, sourceTime + M - (['binance', 'aster'].includes(exchange) ? 1 : 0));
    assert.equal(r.validUntil, r.premiumAt + 120000);
  });
  await t.test('bad explicit closeTime', async t => {
    const h = harness(t, 'aster', { badClose: true }); const pending = h.query(); await flush(); await h.advance(30000);
    const r = await pending; assert.equal(r.ok, false); assert.equal(r.predicted, undefined);
  });
});

test('missing, conflicting, stale or mismatched current sources never become fallback numbers', async t => {
  const cases = [
    ['binance', 'empty', {}], ['aster', 'valid', { sourceAge: 4 * M }],
    ['bybit', 'valid', { wrongIdentity: true }], ['bitget', 'conflict', {}], ['gate', 'missing-join', {}]
  ];
  for (const [exchange, mode, state] of cases) await t.test(exchange, async t => {
    const h = harness(t, exchange, state); h.tail(mode);
    const pending = h.query(); await flush(); await h.advance(30000);
    const r = await pending; assert.equal(r.ok, false); assert.equal(r.predicted, undefined);
  });
});

test('fresh premium cannot extend fee parameters that expire during the history allowance', async t => {
  for (const exchange of ['binance', 'aster', 'bybit', 'bitget']) await t.test(exchange, async t => {
    const h = harness(t, exchange); h.parameterAge(100000);
    const pending = h.query(); await flush(); await h.advance(30000);
    const r = await pending; assert.equal(r.ok, false); assert.match(r.error, /参数已过期/);
  });
});

test('Gate repair metadata retains the separate, timestamped current snapshot after a persistent gap', async t => {
  const h = harness(t, 'gate'); h.mode('gap');
  const pending = h.query(); await flush(); await h.advance(30000);
  const r = await pending;
  assert.equal(r.ok, true, r.error); assert.equal(r.kind, 'current-only');
  assert.equal(r.currentPremium, -.004 * 95 / 100);
  assert.equal(h.calls.filter(u => u.pathname.includes('/contracts/')).length, 2);
});
