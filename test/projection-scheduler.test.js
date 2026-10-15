const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
function harness(responder) {
  const timers = new Map(), calls = []; let next = 0, now = 100000, reads = 0, scans = 0;
  const cards = [['BLUR', 'FF', ['binance', 'okx']], ['BLUR', 'SF', ['gate', 'okx']], ['BTC', 'FS', ['binance', 'gate']]]
    .map(([symbol, mode, exchanges]) => ({ symbol, mode, exchanges, querySelectorAll: () => [] }));
  const document = { hidden: false, querySelectorAll: selector => { scans++; return selector === '.ant-card' ? cards : []; } };
  const context = { document, Date, setInterval: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, clearInterval: n => timers.delete(n) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../projection-inline.js'), 'utf8'), context);
  const ui = context.FundingRadarProjectionInline.create({ now: () => now, linking: { readCard: c => { reads++; return c; } }, limits: require('../limits.js'), send: async m => { calls.push(m); return responder ? responder(m) : { ok: false, error: 'test' }; } });
  return { ui, calls, timers, document, cards, counts:()=>({reads,scans}), async flush() { await new Promise(resolve => setImmediate(resolve)); }, async tick(elapsed = 1000) { now += elapsed; const t = [...timers.values()].find(t => t.ms === 1000); assert.ok(t); t.fn(); await this.flush(); } };
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

test('steady polling and result updates never rescan or reparse the dashboard', async () => {
  const h = harness(); h.ui.start({ startMode: 'all', interval: 300 }); await h.flush();
  const initial = h.counts();
  for (let i=0;i<60;i++) await h.tick();
  [...h.timers.values()].find(t=>t.ms===5000).fn();
  assert.deepEqual(h.counts(), initial);
  assert.equal(h.calls.length, 3);
  h.ui.stop();
});

test('removed cards stop requesting; changed identities and added cards are registered', async () => {
  const h = harness(); h.ui.start({ startMode: 'all', interval: 10 }); await h.flush(); await h.tick();
  h.cards[0].isConnected=false; h.cards[1].isConnected=false;
  h.cards[2].symbol='ETH'; h.ui.render(h.cards[2]);
  const added={symbol:'NEW',mode:'SF',exchanges:['gate','okx'],querySelectorAll:()=>[]};
  h.cards.push(added);h.ui.render(added);
  const n=h.calls.length;await h.tick(10000);
  assert.deepEqual(h.calls.slice(n).map(m=>m.exchange+':'+m.symbol).sort(), ['binance:ETH','okx:NEW']);
  h.ui.stop();
});

test('a slow exchange cannot monopolize slots and completed slots immediately serve queued markets', async () => {
  const waiting = new Map();
  const h = harness(m => new Promise(resolve => waiting.set(m.exchange+':'+m.symbol, resolve)));
  for (const exchange of ['gate','bitget','bybit']) h.cards.push({symbol:'NEW',mode:'SF',exchanges:['gate',exchange],querySelectorAll:()=>[]});
  h.ui.start({startMode:'all',interval:30}); await h.flush();
  assert.equal(waiting.size,4);
  assert.equal(new Set(h.calls.map(m=>m.exchange)).size,4);
  assert.ok(!waiting.has('binance:BTC'));
  waiting.get('okx:BLUR')({ok:false}); await h.flush();
  assert.ok(waiting.has('bybit:NEW'), 'other exchanges proceed while Binance is pending');
  waiting.get('binance:BLUR')({ok:false}); await h.flush();
  assert.ok(waiting.has('binance:BTC'), 'next market starts without another timer tick');
  h.document.hidden=true; const count=h.calls.length;
  for(const resolve of waiting.values())resolve({ok:false}); await h.flush();
  assert.equal(h.calls.length,count);
  h.ui.stop();
});
