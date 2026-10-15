const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
function harness() {
  const timers = new Map(), calls = []; let next = 0, now = 100000;
  const cards = [['BLUR', 'FF', ['binance', 'okx']], ['BLUR', 'SF', ['gate', 'okx']], ['BTC', 'FS', ['binance', 'gate']]]
    .map(([symbol, mode, exchanges]) => ({ symbol, mode, exchanges, querySelectorAll: () => [] }));
  const document = { hidden: false, querySelectorAll: selector => selector === '.ant-card' ? cards : [] };
  const context = { document, Date, setInterval: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, clearInterval: n => timers.delete(n) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../projection-inline.js'), 'utf8'), context);
  const ui = context.FundingRadarProjectionInline.create({ now: () => now, linking: { readCard: c => c }, limits: require('../limits.js'), send: async m => { calls.push(m); return { ok: false, error: 'test' }; } });
  return { ui, calls, timers, document, async flush() { await new Promise(resolve => setImmediate(resolve)); }, async tick(elapsed = 1000) { now += elapsed; const t = [...timers.values()].find(t => t.ms === 1000); assert.ok(t); t.fn(); await this.flush(); } };
}
test('selected symbols query only future legs and deduplicate exchange-symbol pairs', async () => {
  const h = harness(); h.ui.start({ startMode: 'selected', coins: 'BLUR' }); await h.flush();
  assert.deepEqual(h.calls.map(m => `${m.exchange}:${m.symbol}`).sort(), ['binance:BLUR', 'okx:BLUR']);
  h.ui.stop(); assert.equal(h.timers.size, 0);
});
test('all mode, explicit disable, background pause and foreground resume', async () => {
  const h = harness(); h.ui.start({ startMode: 'all', interval: 30 }); await h.flush(); await h.tick(); assert.equal(h.calls.length, 3);
  h.document.hidden = true; h.ui.visibilityChanged(); await h.tick(30000); assert.equal(h.calls.length, 3);
  h.document.hidden = false; h.ui.visibilityChanged(); await h.flush(); await h.tick(); assert.equal(h.calls.length, 6);
  h.ui.configure({ startMode: 'manual' }); await h.tick(30000); assert.equal(h.calls.length, 6); h.ui.stop(); assert.equal(h.timers.size, 0);
});
test('defaults and empty specified list never silently enable broad polling', async () => {
  for (const config of [undefined, { startMode: 'selected', coins: '' }]) {
    const h = harness(); h.ui.start(config); await h.tick(30000); assert.equal(h.calls.length, 0); h.ui.stop(); assert.equal(h.timers.size, 0);
  }
});
