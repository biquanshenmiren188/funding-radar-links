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
  const client = { defaults: { baseURL: '/', withCredentials: true },
    request() {}, getUri() {}, interceptors: { request: { use() {} }, response: { use() {} } }, get: async path => {
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
  return { calls, imports, client, context, read: () => context.readAstroRiskSnapshot(context.location.origin) };
}
for (const [build, exp] of [['index-CW16nN3e.js', 'cD'], ['index-UbpzoVda.js', 'cE'], ['index-CftXA7IB.js', 'cF']]) {
  test(`verified ${build} uses its correct export and only returns risk fields`, async () => {
    const h = harness(build, exp), snapshot = await h.read();
    assert.deepEqual(h.calls, ['/api/config', '/api/ex-position?ex=bitget']);
    assert.equal(snapshot.accounts.bitget.prices.TEST, 2);
    assert.equal(snapshot.pairs[0].privateExtra, undefined);
    assert.equal(JSON.stringify(snapshot).includes('do-not-export'), false);
  });
}
test('new build and renamed export work without a version table', async () => {
  const h = harness('index-future2027.js', 'renamed');
  await h.read();
  assert.equal(h.calls.length, 2);
});
test('foreign and non-entry scripts fail before import or account requests', async () => {
  for (const h of [harness('vendor.js', 'cE'), harness('index-UbpzoVda.js', 'cE', 'https://other.example.com')]) {
    await assert.rejects(h.read(), /入口/);
    assert.equal(h.imports.length, 0);
    assert.equal(h.calls.length, 0);
  }
});
test('unconfigured or foreign clients are never called', async () => {
  for (const change of [c => delete c.request, c => c.defaults.baseURL = 'https://foreign.example', c => c.defaults.withCredentials = false]) {
    const h = harness('index-BWbHljeY.js', 'cF');
    change(h.client);
    await assert.rejects(h.read(), /只读接口/);
    assert.equal(h.calls.length, 0);
  }
});

test('ambiguous clients fail without probing any API', async () => {
  const h = harness('index-future.js', 'a');
  h.context.loadModule = async () => ({ a: h.client, b: { ...h.client } });
  await assert.rejects(h.read(), /只读接口/);
  assert.equal(h.calls.length, 0);
});
test('aliases to the same client are deduplicated', async () => {
  const h = harness('index-future.js', 'a');
  h.context.loadModule = async () => ({ a: h.client, b: h.client, unrelated: { get() { throw Error('must not call'); } } });
  await h.read();
  assert.equal(h.calls.length, 2);
});
test('changed config schema stops before account reads', async () => {
  for (const data of [{ coinPairs: [null], mmr: {} }, { coinPairs: [], mmr: [] }, { pairs: [], mmr: {} }]) {
    const h = harness('index-future.js', 'a');
    h.client.get = async path => { h.calls.push(path); return { data: { code: 0, data } }; };
    await assert.rejects(h.read(), /数据结构/);
    assert.deepEqual(h.calls, ['/api/config']);
  }
});
test('malformed account produces an error instead of a numeric estimate', async () => {
  const h = harness('index-future.js', 'a'), get = h.client.get;
  h.client.get = async path => path === '/api/config' ? get(path) : { data: { code: 0, data: { futureMargin: null } } };
  const result = await h.read();
  assert.match(result.accounts.bitget.error, /查询失败/);
  assert.equal(result.accounts.bitget.displayedMargin, undefined);
});
