const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../astro-reader.js'), 'utf8')
  .replace('await import(entry.href)', 'await loadModule(entry.href)');
function harness(build, exportName, origin = 'https://dashboard.example.com') {
  const calls = [], imports = [];
  const pair = { id: 1, type: 'FS', name: 'TEST', buyEx: 'binance', sellEx: 'bitget',
    bExPosition: 100, spotMarginType: 'cross', privateExtra: 'do-not-export' };
  const client = { get: async path => {
    calls.push(path);
    return { data: { code: 0, data: path === '/api/config'
      ? { coinPairs: [pair], mmr: { bitget: 0.02 }, privateExtra: 'do-not-export' }
      : { futureMargin: 1000, spot: { TEST: 0 }, future: {}, privateExtra: 'do-not-export' } } };
  } };
  const context = { URL, location: { origin: 'https://dashboard.example.com', href: 'https://dashboard.example.com/prefix/dashboard' },
    document: { querySelectorAll: () => [{ src: `${origin}/prefix/assets/${build}` }] },
    window: { bitget: { spot: { TEST: 2 } } },
    loadModule: async url => { imports.push(url); return { [exportName]: client }; } };
  vm.runInNewContext(source, context);
  return { calls, imports, read: () => context.readAstroRiskSnapshot(context.location.origin) };
}
for (const [build, exp] of [['index-CW16nN3e.js', 'cD'], ['index-UbpzoVda.js', 'cE']]) {
  test(`verified ${build} uses its correct export and only returns risk fields`, async () => {
    const h = harness(build, exp), snapshot = await h.read();
    assert.deepEqual(h.calls, ['/api/config', '/api/ex-position?ex=bitget']);
    assert.equal(snapshot.accounts.bitget.prices.TEST, 2);
    assert.equal(snapshot.pairs[0].privateExtra, undefined);
    assert.equal(JSON.stringify(snapshot).includes('do-not-export'), false);
  });
}
test('new build cannot accidentally call the previous minified export', async () => {
  const h = harness('index-UbpzoVda.js', 'cD');
  await assert.rejects(h.read(), /接口版本不匹配/);
  assert.equal(h.calls.length, 0);
});
test('unknown and foreign builds fail before import or account requests', async () => {
  for (const h of [harness('index-unknown.js', 'cE'), harness('index-UbpzoVda.js', 'cE', 'https://other.example.com')]) {
    await assert.rejects(h.read(), /尚未适配/);
    assert.equal(h.imports.length, 0);
    assert.equal(h.calls.length, 0);
  }
});
