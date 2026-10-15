const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
function harness() {
  const timers = new Map(), calls = []; let next = 0;
  const cards = [['BLUR', 'FF', ['binance', 'okx']], ['BLUR', 'SF', ['gate', 'okx']], ['BTC', 'FS', ['binance', 'gate']]]
    .map(([symbol, mode, exchanges]) => ({ symbol, mode, exchanges, querySelectorAll: () => [] }));
  const document = { hidden: false, querySelectorAll: selector => selector === '.ant-card' ? cards : [] };
  const context = { document, Date, setTimeout: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, clearTimeout: n => timers.delete(n), setInterval: () => 99, clearInterval() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../projection-inline.js'), 'utf8'), context);
  const ui = context.FundingRadarProjectionInline.create({ linking: { readCard: c => c }, limits: require('../limits.js'), send: async m => { calls.push(m); return { ok: false, error: 'test' }; } });
  return { ui, calls, timers, document, async tick(ms = 0) { const [id, t] = [...timers].find(([, t]) => t.ms === ms) || []; assert.ok(t); timers.delete(id); await t.fn(); } };
}
test('selected symbols query only future legs and deduplicate exchange-symbol pairs', async () => {
  const h = harness(); h.ui.start({ enabled: true, mode: 'selected', coins: 'BLUR' }); await h.tick();
  assert.deepEqual(h.calls.map(m => `${m.exchange}:${m.symbol}`).sort(), ['binance:BLUR', 'okx:BLUR']);
  h.ui.stop(); assert.equal(h.timers.size, 0);
});
test('all mode, explicit disable, background pause and foreground resume', async () => {
  const h = harness(); h.ui.start({ enabled: true, mode: 'all', interval: 30 }); await h.tick(); assert.equal(h.calls.length, 3);
  h.document.hidden = true; h.ui.visibilityChanged(); assert.equal(h.timers.size, 0);
  h.document.hidden = false; h.ui.visibilityChanged(); await h.tick(); assert.equal(h.calls.length, 6);
  h.ui.configure({ enabled: false }); assert.equal(h.timers.size, 0); h.ui.stop();
});
test('defaults and empty specified list never silently enable broad polling', () => {
  for (const config of [undefined, { enabled: true, mode: 'selected', coins: '' }]) {
    const h = harness(); h.ui.start(config); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0); h.ui.stop();
  }
});
