const test = require('node:test'), assert = require('node:assert/strict');
const { createClient, projectCurrentPremium, fee } = require('../projection.js');
const M = 60000, start = 1792627200000;
const flush = () => new Promise(setImmediate);
const reply = data => ({ ok: true, json: async () => data });

function harness(t, initialMode = 'stall') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = start + 30 * M + 10000, mode = initialMode, patch = {}, historyCalls = 0, rateCalls = 0;
  const signals = [], progress = [];
  const query = createClient(async (raw, options) => {
    const u = new URL(raw), coin = u.searchParams.get('instId').replace('-USDT-SWAP', '');
    if (u.pathname.endsWith('/funding-rate')) {
      rateCalls++;
      return reply({ code: '0', data: [{ instId: coin + '-USDT-SWAP', formulaType: 'withRate',
        fundingTime: String(start + 4 * 60 * M), prevFundingTime: String(start),
        interestRate: '.0001', minFundingRate: '-.02', maxFundingRate: '.02', fundingRate: '-.001',
        premium: '-.004', ts: String(now), ...patch }] });
    }
    historyCalls++; signals.push(options.signal);
    if (mode === 'stall') return new Promise(() => {});
    if (mode === 'http') return { ok: false, status: 400 };
    const after = Number(u.searchParams.get('after')) || Infinity;
    const rows = Array.from({ length: Math.floor((now - start) / M) }, (_, i) => ({
      ts: String(start + i * M + 1000), premium: '-.002', instId: coin + '-USDT-SWAP'
    })).reverse().filter(r => Number(r.ts) < after && (mode !== 'gap' || Number(r.ts) !== start + 5 * M + 1000)).slice(0, 100);
    return reply({ code: '0', data: mode === 'empty' ? [] : rows });
  }, () => now, async () => {});
  return { query: (coin = 'AAA', options = {}) => query('okx', coin, { onProgress: p => progress.push(p), ...options }),
    get now() { return now; }, get rateCalls() { return rateCalls; }, get historyCalls() { return historyCalls; }, signals, progress,
    mode(value) { mode = value; }, patch(value) { patch = value; },
    async advance(ms) { now += ms; t.mock.timers.tick(ms); await flush(); }
  };
}

test('OKX stalled history switches at exactly 30 seconds and aborts its request', async t => {
  const h = harness(t), premiumAt = h.now;
  let settled = false;
  const pending = h.query().then(r => { settled = true; return r; });
  await flush(); assert.equal(h.historyCalls, 1);
  await h.advance(29999); assert.equal(settled, false);
  await h.advance(1); const r = await pending;
  assert.equal(r.ok, true, r.error); assert.equal(r.kind, 'current-only');
  assert.equal(r.currentPremium, -.004); assert.equal(r.average, -.004);
  assert.equal(r.predicted, (-.004 + .0005) / 2);
  assert.equal(r.premiumAt, premiumAt); assert.equal(r.validUntil, premiumAt + 120000);
  assert.equal(r.checkedAt, h.now); assert.equal(r.observedMinutes, 0);
  assert.equal(h.signals[0].aborted, true);
  assert.match(r.assumption, /未计入真实历史累计/);
});

test('fast HTTP failure, empty history and interior gaps still consume the initial 30-second allowance', async t => {
  for (const mode of ['http', 'empty', 'gap']) await t.test(mode, async t => {
    const h = harness(t, mode); let settled = false;
    const pending = h.query().then(r => { settled = true; return r; });
    await flush(); await h.advance(29999); assert.equal(settled, false);
    await h.advance(1); const r = await pending;
    assert.equal(r.ok, true, r.error); assert.equal(r.kind, 'current-only');
  });
});

test('complete history wins immediately and keeps the existing 10-minute scenario', async t => {
  const h = harness(t, 'complete'), r = await h.query();
  assert.equal(r.ok, true, r.error); assert.equal(r.kind, undefined);
  assert.equal(r.forecastMethod, 'mean10'); assert.equal(r.observedMinutes, 30);
  assert.equal(r.currentPremium, -.002); assert.ok(Math.abs(r.predicted - (-.002 + .0005) / 2) < 1e-14);
  assert.equal(h.progress.some(p => p.stage === 'current-only'), false);
});

test('fallback refreshes current data within the same minute, backs off history and automatically recovers', async t => {
  const h = harness(t), first = h.query(); await flush(); await h.advance(30000);
  const initial = await first; assert.equal(initial.kind, 'current-only');
  h.patch({ premium: '.004' }); await h.advance(10000);
  const second = await h.query();
  assert.equal(second.kind, 'current-only'); assert.equal(second.currentPremium, .004);
  assert.equal(h.rateCalls, 2); assert.equal(h.historyCalls, 1);
  assert.equal(Math.floor(initial.checkedAt / M), Math.floor(second.checkedAt / M));
  await h.advance(20000); h.progress.length = 0;
  const retry = h.query(); await flush();
  assert.equal(h.historyCalls, 2);
  assert.ok(h.progress.some(p => p.stage === 'current-only' && p.result.currentPremium === .004));
  await h.advance(20000); assert.equal((await retry).kind, 'current-only');
  // The second history failure backs off for 60 seconds, without freezing current snapshots.
  await h.advance(30000); await h.query(); assert.equal(h.historyCalls, 2);
  await h.advance(30000); h.mode('complete');
  const recovered = await h.query();
  assert.equal(recovered.ok, true, recovered.error); assert.equal(recovered.kind, undefined);
  assert.equal(recovered.forecastMethod, 'mean10');
  assert.ok(h.historyCalls > 2);
});

test('current-only uses official intervals and caps and never renews stale or invalid data', () => {
  const c = { start, end: start + 4 * 60 * M, hours: 4, samples: 1, divisor: 2,
    floor: -.01, cap: .02, interest: .0001, livePremium: -.004, serverTime: start + M };
  const now = start + M;
  for (const hours of [1, 2, 4, 8]) {
    const v = { ...c, hours, end: start + hours * 60 * M, divisor: 8 / hours };
    assert.equal(projectCurrentPremium(v, now).predicted, fee(v.livePremium, v));
  }
  assert.equal(projectCurrentPremium({ ...c, livePremium: 99 }, now).predicted, c.cap);
  assert.equal(projectCurrentPremium({ ...c, livePremium: -99 }, now).predicted, c.floor);
  for (const livePremium of [undefined, null, NaN, Infinity]) assert.throws(() => projectCurrentPremium({ ...c, livePremium }, now), /当前溢价/);
  assert.throws(() => projectCurrentPremium(c, now + 120000), /过期/);
  assert.throws(() => projectCurrentPremium({ ...c, serverTime: now + 30001 }, now), /参数已过期/);
  assert.throws(() => projectCurrentPremium(c, c.end), /周期/);
  for (const patch of [{ hours: 3 }, { cap: c.floor }, { divisor: 0 }, { interest: NaN }, { start: now + 1 }]) {
    assert.throws(() => projectCurrentPremium({ ...c, ...patch }, now), /参数/);
  }
  const nearEnd = { ...c, serverTime: c.end - 50000 };
  assert.equal(projectCurrentPremium(nearEnd, c.end - 10000).validUntil, c.end);
});

test('a missing premium permits normal history but cannot become a fallback number', async t => {
  const h = harness(t); h.patch({ premium: '' });
  const pending = h.query(); await flush(); await h.advance(30000);
  const failed = await pending; assert.equal(failed.ok, false); assert.equal(failed.predicted, undefined);
  h.mode('complete'); await h.advance(30000);
  const recovered = await h.query(); assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.kind, undefined);
});

test('metadata aging or crossing settlement during the wait cannot yield current-only output', async t => {
  for (const mode of ['aged', 'settled']) await t.test(mode, async t => {
    const h = harness(t);
    h.patch(mode === 'aged' ? { ts: String(h.now - 100000) } : {
      fundingTime: String(h.now + 20000), prevFundingTime: String(h.now + 20000 - 4 * 60 * M)
    });
    const pending = h.query(); await flush(); await h.advance(30000);
    const r = await pending; assert.equal(r.ok, false); assert.equal(r.predicted, undefined);
    assert.match(r.error, /过期|周期/);
  });
});

test('canceling one shared consumer preserves the other; canceling the last cannot emit a late fallback', async t => {
  const h = harness(t), a = new AbortController(), b = new AbortController();
  const one = h.query('AAA', { signal: a.signal }), two = h.query('AAA', { signal: b.signal });
  await flush(); a.abort(); await assert.rejects(one);
  assert.equal(h.signals[0].aborted, false); assert.equal(h.rateCalls, 1);
  await h.advance(30000); assert.equal((await two).kind, 'current-only');
  const last = new AbortController();
  const pending = h.query('BBB', { signal: last.signal }); await flush(); last.abort();
  await assert.rejects(pending); await flush();
  assert.equal(h.signals.at(-1).aborted, true);
  const count = h.progress.filter(p => p.result).length;
  await h.advance(30000); assert.equal(h.progress.filter(p => p.result).length, count);
});

test('a new settlement cycle receives its own 30-second history allowance', async t => {
  const h = harness(t), first = h.query(); await flush(); await h.advance(30000); await first;
  await h.advance(10000);
  const boundary = Math.floor(h.now / M) * M;
  h.patch({ prevFundingTime: String(boundary), fundingTime: String(boundary + 60 * M), premium: '.002' });
  let done = false; const next = h.query().then(r => { done = true; return r; }); await flush();
  await h.advance(29999); assert.equal(done, false);
  await h.advance(1); const r = await next;
  assert.equal(r.kind, 'current-only'); assert.equal(r.hours, 1); assert.equal(r.end, boundary + 60 * M);
});
