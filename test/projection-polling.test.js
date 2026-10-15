const test = require('node:test');
const assert = require('node:assert/strict');
const { createPolling, compactRate } = require('../projection-inline.js');
const { fundingSettings } = require('../limits.js');

test('funding settings migrate old off safely and support all requested intervals', () => {
  assert.deepEqual(fundingSettings(), { startMode: 'manual', interval: 30, coins: [] });
  assert.equal(fundingSettings({ enabled: false, interval: 60 }).interval, 30);
  assert.deepEqual(fundingSettings({ enabled: true, mode: 'selected', interval: 60, coins: 'blur，BTC blur' }),
    { startMode: 'selected', interval: 60, coins: ['BLUR', 'BTC'] });
  for (const interval of [10, 30, 60, 300]) assert.equal(fundingSettings({ startMode: 'manual', interval }).interval, interval);
  assert.equal(fundingSettings({ startMode: 'all', interval: 120 }).interval, 30);
});

test('click starts immediately, polling respects 30 seconds, stop invalidates late response', () => {
  let now = 100000; const p = createPolling(() => now), key = 'gate:BLUR';
  assert.equal(p.active(key, 'BLUR'), false);
  p.toggle(key, 'BLUR'); assert.equal(p.ready(key, 'BLUR'), true);
  const requestRevision = p.revision(key); p.requested(key);
  now += 29999; assert.equal(p.ready(key, 'BLUR'), false);
  now++; assert.equal(p.ready(key, 'BLUR'), true);
  p.toggle(key, 'BLUR'); assert.notEqual(p.revision(key), requestRevision);
  now += 300000; assert.equal(p.ready(key, 'BLUR'), false);
  p.toggle(key, 'BLUR'); assert.equal(p.ready(key, 'BLUR'), true);
});

test('selected scope, shared market key and stop override survive interval edits', () => {
  let now = 100000; const p = createPolling(() => now);
  p.configure(fundingSettings({ startMode: 'selected', interval: 10, coins: 'BLUR' }));
  assert.equal(p.active('gate:BLUR', 'BLUR'), true);
  assert.equal(p.active('gate:BTC', 'BTC'), false);
  p.requested('gate:BLUR'); assert.equal(p.ready('gate:BLUR', 'BLUR'), false);
  now += 10000; assert.equal(p.ready('gate:BLUR', 'BLUR'), true);
  p.toggle('gate:BLUR', 'BLUR');
  p.configure(fundingSettings({ startMode: 'all', interval: 60 }));
  assert.equal(p.active('gate:BLUR', 'BLUR'), false);
  assert.equal(p.active('okx:BLUR', 'BLUR'), true);
  assert.equal(p.active('gate:BTC', 'BTC'), true);
  p.toggle('gate:BLUR', 'BLUR'); p.requested('gate:BLUR');
  now += 59999; assert.equal(p.ready('gate:BLUR', 'BLUR'), false);
  now++; assert.equal(p.ready('gate:BLUR', 'BLUR'), true);
});

test('compact estimate preserves percentage scale, three decimals and signed zero', () => {
  assert.equal(compactRate(-.001234), '-0.123');
  assert.equal(compactRate(.00015), '+0.015');
  assert.equal(compactRate(-.00000001), '+0.000');
});

test('a slow or failed market waits at least thirty seconds after failure',()=>{
  let now=100000;const p=createPolling(()=>now);
  p.configure({startMode:'all',interval:10,coins:[]});p.requested('gate:BLUR');
  now+=20000;p.failed('gate:BLUR');
  assert.equal(p.ready('gate:BLUR','BLUR'),false);
  assert.equal(p.ready('gate:BTC','BTC'),true);
  now+=29999;assert.equal(p.ready('gate:BLUR','BLUR'),false);
  now++;assert.equal(p.ready('gate:BLUR','BLUR'),true);
});
