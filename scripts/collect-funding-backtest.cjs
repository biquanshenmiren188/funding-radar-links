// Public market data only. Resumable raw-response cache; no trading/account APIs.
// node scripts/collect-funding-backtest.cjs OUTPUT_DIRECTORY [exchange,...]
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { gatePremiumRows } = require('../projection.js');
const out = path.resolve(process.argv[2]);
fs.mkdirSync(path.join(out, 'raw'), { recursive: true });
const pause = ms => new Promise(r => setTimeout(r, ms));
async function get(url) {
  const file = path.join(out, 'raw', crypto.createHash('sha256').update(url).digest('hex') + '.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file)).data;
  for (let i = 0; i < 3; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error('HTTP ' + response.status);
      const data = await response.json();
      if (data.retCode || (data.code !== undefined && ![0, '0', '00000'].includes(data.code))) throw Error(JSON.stringify(data).slice(0, 200));
      fs.writeFileSync(file, JSON.stringify({ url, fetchedAt: new Date().toISOString(), data }));
      await pause(250);
      return data;
    } catch (e) { if (i === 2) throw e; await pause(1000 * (i + 1)); }
  }
}
const url = (base, route, params) => base + route + '?' + new URLSearchParams(params);
async function collect(exchange) {
  const periods = [], failures = [];
  // Fixed before measuring results: liquid majors + user-reported/problem markets.
  for (const coin of (process.env.BACKTEST_COINS || 'BTC,ETH,BLUR,ZEREBRO,WAL,RLC').split(',')) {
    try {
      const symbol = coin + 'USDT', instId = coin + '-USDT-SWAP', contract = coin + '_USDT';
      const base = exchange === 'binance' ? 'https://fapi.binance.com' : 'https://fapi.asterdex.com';
      const count = Number(process.env.BACKTEST_PERIODS || (exchange === 'okx' || exchange === 'gate' ? 7 : 13));
      let data, source;
      if (['binance', 'aster'].includes(exchange)) source = url(base, '/fapi/v1/fundingRate', { symbol, limit: count });
      if (exchange === 'bybit') source = url('https://api.bybit.com', '/v5/market/funding/history', { category: 'linear', symbol, limit: count });
      if (exchange === 'bitget') source = url('https://api.bitget.com', '/api/v3/market/history-fund-rate', { category: 'USDT-FUTURES', symbol, limit: count, cursor: 1 });
      if (exchange === 'okx') source = url('https://www.okx.com', '/api/v5/public/funding-rate-history', { instId, limit: count });
      if (exchange === 'gate') source = url('https://api.gateio.ws', '/api/v4/futures/usdt/funding_rate', { contract, limit: count });
      data = await get(source);
      const list = Array.isArray(data) ? data : exchange === 'bybit' ? data.result.list : exchange === 'bitget' ? data.data.resultList : data.data;
      const history = list.map(r => ({ t: Math.floor(Number(r.fundingTime ?? r.fundingRateTimestamp ?? r.t * 1000) / 60000) * 60000, actual: Number(r.realizedRate ?? r.fundingRate ?? r.r) })).sort((a, b) => b.t - a.t);
      for (let k = 0; k < history.length - 1; k++) {
        const start = history[k + 1].t, end = history[k].t, hours = (end - start) / 3600000;
        if (![1, 2, 4, 8].includes(hours)) { failures.push({ coin, start, end, reason: 'unsupported/changed interval' }); continue; }
        let rows = [], sources = [source];
        async function request(u) { sources.push(u); return get(u); }
        if (['binance', 'aster'].includes(exchange)) rows = await request(url(base, '/fapi/v1/premiumIndexKlines', { symbol, interval: '1m', startTime: start, endTime: end - 1, limit: 1000 }));
        if (exchange === 'bitget') rows = (await request(url('https://api.bitget.com', '/api/v3/market/candles', { category: 'USDT-FUTURES', symbol, interval: '1m', type: 'premium', startTime: start, endTime: end - 1, limit: 1000 }))).data;
        if (exchange === 'bybit') rows = (await request(url('https://api.bybit.com', '/v5/market/premium-index-price-kline', { category: 'linear', symbol, interval: '1', start, end, limit: 1000 }))).result.list;
        if (exchange === 'okx') {
          let cursor = end;
          for (let page = 0; page < 6; page++) {
            const part = (await request(url('https://www.okx.com', '/api/v5/public/premium-history', { instId, after: cursor, limit: 100 }))).data;
            if (!part?.length) break;
            rows.push(...part.map(r => ({ t: +r.ts, p: +r.premium, close: +r.premium })));
            const oldest = Math.min(...part.map(r => +r.ts));
            if (oldest <= start || oldest >= cursor) break;
            cursor = oldest;
          }
        } else if (exchange === 'gate') {
          const premium = await request(url('https://api.gateio.ws', '/api/v4/futures/usdt/premium_index', { contract, from: start / 1000, to: end / 1000, interval: '1m', limit: 1000 }));
          const prices = [];
          for (const prefix of ['mark_', 'index_']) prices.push(await request(url('https://api.gateio.ws', '/api/v4/futures/usdt/candlesticks', { contract: prefix + contract, from: start / 1000, to: end / 1000, interval: '1m' })));
          rows = gatePremiumRows(premium, ...prices);
        } else rows = rows.map(r => ({ t: +r[0], p: exchange === 'bybit' ? +r[4] : r.slice(1, 5).reduce((s, v) => s + +v, 0) / 4, close: +r[4], low: +r[3], high: +r[2], ...(['binance', 'aster'].includes(exchange) ? { count: +r[8] } : {}) }));
        const offset = ['bybit', 'gate'].includes(exchange) ? 1 : 0;
        rows = [...new Map(rows.map(r => [r.t, r])).values()].filter(r => Math.floor((r.t - start) / 60000) >= offset && Math.floor((r.t - start) / 60000) < hours * 60 + offset).sort((a, b) => a.t - b.t);
        // Historical caps are not available: do not silently substitute today's caps.
        const config = { start, end, hours, samples: ['binance', 'aster', 'bitget'].includes(exchange) ? 12 : 1, sampleOffset: offset, equal: ['binance', 'aster'].includes(exchange) && hours === 1, interest: exchange === 'bybit' ? .0003 * hours / 24 : .0001, divisor: exchange === 'bybit' ? 1 : 8 / hours, floor: -1, cap: 1 };
        periods.push({ exchange, coin, actual: history[k].actual, config, rows, sources, capPolicy: 'historical unknown; uncapped comparison', collection: 'expanded' });
      }
      console.log(exchange, coin, periods.filter(p => p.coin === coin).length, 'periods');
    } catch (e) { failures.push({ coin, reason: e.message }); console.log(exchange, coin, 'ERROR', e.message); }
    fs.writeFileSync(path.join(out, exchange + '.json'), JSON.stringify({ periods, failures }));
  }
}
Promise.allSettled((process.argv[3] || 'binance,aster,bybit,bitget,gate,okx').split(',').map(collect)).then(results => { results.forEach(r => { if (r.status === 'rejected') { console.error(r.reason); process.exitCode = 1; } }); });
