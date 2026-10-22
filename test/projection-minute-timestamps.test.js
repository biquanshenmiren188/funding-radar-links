const test = require('node:test');
const assert = require('node:assert/strict');
const { project, createClient } = require('../projection.js');
const f = require('./fixtures/okx-minute-timestamps.json');
const minute = 60000;
const start = Number(f.rate.data[0].prevFundingTime);
const config = { start, end: start + 4 * 3600000, hours: 4, samples: 1,
  interest: .0001, divisor: 2, floor: -.01, cap: .01, maxHistoryLagMinutes: 5 };

test('captured OKX WAL second-resolution timestamps are available minutes, not missing history', async () => {
  const query = createClient(async raw => ({ ok: true, json: async () =>
    new URL(raw).pathname.endsWith('/funding-rate') ? f.rate : f.history
  }), () => f.at, async () => {});
  const r = await query('okx', 'WAL');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.observedMinutes, 2);
  assert.equal(r.historyLagMinutes, 0);
  assert.equal(r.premiumAt, 1792080081000);
  assert.equal(r.currentPremium, -.002837417581431);
  // 00:02:17 sample belongs to the unfinished minute, not the forecast anchor.
  assert.notEqual(r.currentPremium, Number(f.history.data[0].premium));
  const recent=f.history.data.filter(p=>Number(p.ts)>=start-8*minute&&Number(p.ts)<start+2*minute);
  assert.equal(recent.length,10);
  assert.ok(Math.abs(r.forecastPremium-recent.reduce((s,p)=>s+Number(p.premium),0)/10)<1e-14);
  // Old-cycle samples inform the scenario only, not accrued-cycle weighting.
  assert.equal(r.forecastMethod,'mean10');
});

test('OKX cached seconds timestamps need only one tail page after an initial multi-page query', async () => {
  let elapsed = 200, pages = 0;
  const query = createClient(async raw => {
    const u = new URL(raw);
    if (u.pathname.endsWith('/funding-rate')) return { ok: true, json: async () => ({
      data: [{ ...f.rate.data[0], ts: String(start + elapsed * minute + 30000) }]
    }) };
    pages++;
    const after = Number(u.searchParams.get('after')) || Infinity;
    const rows = Array.from({ length: elapsed }, (_, i) => ({
      ts: String(start + i * minute + 17000), premium: '-.002', instId: 'WAL-USDT-SWAP'
    })).reverse().filter(r => Number(r.ts) < after).slice(0, 100);
    return { ok: true, json: async () => ({ data: rows }) };
  }, () => start + elapsed * minute + 30000, async () => {});
  assert.equal((await query('okx', 'WAL')).ok, true);
  assert.equal(pages, 2);
  elapsed++;
  const next = await query('okx', 'WAL');
  assert.equal(next.ok, true, next.error);
  assert.equal(next.observedMinutes, 201);
  assert.equal(pages, 3);
});

test('minute lookup retains interior-gap and conflicting-sample rejection', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ t: start + i * minute + 17000, p: -.002, close: -.002 }));
  assert.equal(project(config, rows, start + 10 * minute).observedMinutes, 10);
  assert.throws(() => project(config, rows.filter((_, i) => i !== 4), start + 10 * minute), /缺口/);
  assert.throws(() => project(config, [...rows, { ...rows[4], t: rows[4].t + 1000 }], start + 10 * minute), /多个溢价采样/);
});

test('new-cycle incomplete first minute does not falsely claim more than five minutes of delay', () => {
  const c = { ...config, samples: 12 };
  const row = { t: start, p: 0, close: 0, count: 6 };
  assert.throws(() => project(c, [row], start + 2 * minute), /已开始 2 分钟，尚无可用完整分钟/);
  const ready = project(c, [{ ...row, count: 12 }], start + 2 * minute);
  assert.equal(ready.observedMinutes, 1);
  assert.equal(ready.historyLagMinutes, 1);
});
