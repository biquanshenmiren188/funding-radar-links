(function (root) {
  "use strict";
  const MINUTE = 60000;
  const EXCHANGES = ["binance", "aster", "bybit", "bitget", "gate", "okx", "hyperliquid"];
  const UNVERIFIED = Object.freeze({});
  // 0.005 percentage points, exclusively the historical sampling uncertainty.
  // Future market movement is not bounded by this threshold.
  const MAX_SAMPLING_ERROR = 0.00005;
  const finite = value => value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value));
  function number(value) { if (!finite(value)) throw new Error("官方数据字段缺失"); return Number(value); }
  const clamp = (x, low, high) => Math.max(low, Math.min(high, x));
  // Gate API adapter, established by historical settlement and live-rate replays.
  // Premium stamped t pairs with the mark/index closes of the candle at t - 1m.
  // Do not use t's candle close: that introduces a minute of look-ahead.
  // This normalization is an empirical API finding, not a documented fee formula.
  function gatePremiumRows(premium, marks, indices) {
    function indexed(rows) {
      if (!Array.isArray(rows)) throw new Error("Gate 历史数据返回异常");
      const map = new Map();
      for (const row of rows) {
        const t = number(row.t) * 1000, close = number(row.c);
        if (map.has(t) && map.get(t) !== close) throw new Error("Gate 同一分钟历史数据冲突");
        map.set(t, close);
      }
      return map;
    }
    const p = indexed(premium), m = indexed(marks), ind = indexed(indices), result = [];
    for (const [t, value] of p) {
      const previous = t - MINUTE;
      if (!m.has(previous) || !ind.has(previous)) continue; // gap repair handles missing inputs
      const mark = m.get(previous), index = ind.get(previous);
      if (mark <= 0 || index <= 0) throw new Error("Gate 标记价或指数价异常");
      const normalized = value * mark / index;
      if (!Number.isFinite(normalized)) throw new Error("Gate 溢价换算异常");
      result.push({ t, p: normalized, close: normalized });
    }
    return result;
  }
  function weightedHistory(config, rows, minutes, asOf) {
    const { start, samples, equal, sampleOffset = 0 } = config;
    const byMinute = new Map();
    let latest;
    for (const row of [...rows].sort((a, b) => a.t - b.t)) {
      if (row.t > asOf) continue;
      const index = Math.floor((row.t - start) / MINUTE) - sampleOffset;
      if (index < 0 || index >= config.hours * 60) continue;
      if (![row.t, row.p, row.close].every(Number.isFinite)) throw new Error("溢价数据异常");
      const old = byMinute.get(index);
      if (old && old.t !== row.t) throw new Error("同一分钟存在多个溢价采样，口径未核实");
      byMinute.set(index, row); latest = row;
    }
    let past = 0, weight = 0, low = 0, high = 0;
    for (let i = 0; i < minutes; i++) {
      const r = byMinute.get(i);
      if (!r || (r.count !== undefined && r.count !== samples)) throw new Error("本周期历史溢价有缺口，正在等待补齐");
      const first = i * samples + 1;
      const w = equal ? samples : (first + first + samples - 1) * samples / 2;
      past += r.p * w; weight += w;
      if (config.bounded) {
        if (![r.low, r.high].every(Number.isFinite) || r.low > r.high || r.p < r.low || r.p > r.high || r.close < r.low || r.close > r.high) throw new Error("溢价高低值异常");
        // Every positive-weight five-second observation lies inside its minute's
        // extrema. This encloses all unknown intra-minute orderings, not a CI.
        low += r.low * w; high += r.high * w;
      } else { low += r.p * w; high += r.p * w; }
    }
    return { past, weight, latest, low, high };
  }
  // Uses the same sample alignment and weights as live projections, for historical audits.
  function reconstruct(config, rows) {
    const { past, weight } = weightedHistory(config, rows, config.hours * 60, config.end);
    return fee(past / weight, config);
  }
  function reconstructRange(config, rows) {
    const { low, high, weight } = weightedHistory({ ...config, bounded: true }, rows, config.hours * 60, config.end);
    return [fee(low / weight, config), fee(high / weight, config)];
  }
  function fee(premium, config) {
    const { interest, divisor, floor, cap } = config;
    return clamp((premium + clamp(interest - premium, -0.0005, 0.0005)) / divisor, floor, cap);
  }
  // All inputs are decimal fractions, never display percentages. OHLC averages are
  // approximations of unavailable five-second samples, explicitly labelled in UI.
  function project(config, rows, now) {
    const { start, end, hours, samples, equal, floor, cap, interest, divisor } = config;
    if (![start, end, hours, samples, floor, cap, interest, divisor, now].every(Number.isFinite) ||
        ![1, 2, 4, 8].includes(hours) || end - start !== hours * 3600000 ||
        now < start || now >= end || floor >= cap || divisor <= 0 || ![1, 12].includes(samples)) throw new Error("结算周期或费率参数未核实");
    const elapsed = Math.floor((now - start) / MINUTE);
    if (!rows.length) throw new Error("最新溢价尚未更新，稍后重试");
    const { past, weight, latest, low, high } = weightedHistory(config, rows, elapsed, now);
    if (!latest || now - latest.t > 120000) throw new Error("最新溢价尚未更新，稍后重试");
    if (config.verifyGate && weight > 0 &&
        (!Number.isFinite(config.officialRate) || Math.abs(fee(past / weight, config) - config.officialRate) > 0.00000050001)) {
      throw new Error("Gate 本周期计算与官方费率尚未同步，正在重新核对");
    }
    const n = hours * 60 * samples;
    const total = equal ? n : n * (n + 1) / 2;
    const futureWeight = total - weight;
    const average = (past + latest.close * futureWeight) / total;
    const lower = fee((low + latest.close * futureWeight) / total, config);
    const upper = fee((high + latest.close * futureWeight) / total, config);
    const predicted = fee(average, config);
    const samplingError = Math.max(predicted - lower, upper - predicted, 0);
    return { predicted, lower, upper, samplingError, rangeOnly: !!config.bounded && samplingError > MAX_SAMPLING_ERROR,
      currentPremium: latest.close, average,
      observedMinutes: elapsed, totalMinutes: hours * 60, end, hours, floor, cap,
      officialRate: config.officialRate, checkedAt: now,
      method: config.verifyGate ? "Gate 分钟溢价按标记价/指数价换算 · 时间递增加权 · 已核对官方当前费率" : samples === 12 ? "分钟 OHLC 近似 5 秒采样；用每分钟高低值计算采样误差区间" : "官方分钟溢价采样",
      assumption: "当前分钟及剩余时间维持最新溢价；非最终结算费率" };
  }
  function createClient(fetcher = fetch, clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms))) {
    const flights = new Map(), cache = new Map(), history = new Map(), requests = new Map();
    const lanes = new Map();
    async function json(url, body) {
      const requestKey = url + (body ? "#" + JSON.stringify(body) : "");
      const old = requests.get(requestKey);
      if (old && clock() - old.at < 15000) return old.promise;
      const host = new URL(url).host;
      const previous = lanes.get(host) || Promise.resolve();
      const promise = previous.catch(() => {}).then(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetcher(url, { signal: AbortSignal.timeout(10000), credentials: "omit", redirect: "error", cache: "no-store",
              ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
            if (!response.ok) {
              if (response.status === 429 || response.status >= 500) {
                if (attempt < 2) { await sleep(Math.min(10000, Math.max(1000 * 2 ** attempt, Number(response.headers?.get("retry-after")) * 1000 || 0))); continue; }
              }
              throw new Error(`官方接口 HTTP ${response.status}`);
            }
            const data = await response.json();
            if ((data.code !== undefined && !["0", "00000", 0].includes(data.code)) || (data.retCode !== undefined && data.retCode !== 0)) throw new Error("官方接口暂未返回有效数据");
            return data;
          } catch (e) {
            if (attempt < 2 && ["TimeoutError", "AbortError", "TypeError"].includes(e.name)) { await sleep(1000 * 2 ** attempt); continue; }
            throw e;
          }
        }
      });
      const lane = promise.then(() => sleep(250), () => sleep(250));
      lanes.set(host, lane);
      lane.then(() => { if (lanes.get(host) === lane) lanes.delete(host); });
      requests.set(requestKey, { at: clock(), promise });
      promise.catch(() => { if (requests.get(requestKey)?.promise === promise) requests.delete(requestKey); });
      if (requests.size > 200) requests.delete(requests.keys().next().value);
      return promise;
    }
    const url = (base, path, params) => `${base}${path}?${new URLSearchParams(params)}`;
    function one(rows, field, value) {
      const found = Array.isArray(rows) ? rows.filter(x => x[field] === value) : [];
      if (found.length !== 1) throw new Error("官方目录未匹配到唯一合约");
      return found[0];
    }
    async function hyperliquid(coin) {
      const endpoint = "https://api.hyperliquid.xyz/info";
      const contexts = await json(endpoint, { type: "metaAndAssetCtxs" });
      const instrument = one(contexts[0]?.universe, "name", coin);
      if (instrument.isDelisted || coin.includes(":")) throw new Error("HL 合约不在原生永续范围");
      const predictions = await json(endpoint, { type: "predictedFundings" });
      const item = one(predictions, 0, coin);
      const p = one(item[1], 0, "HlPerp")[1];
      const predicted = number(p.fundingRate), now = clock();
      let end = number(p.nextFundingTime);
      // The live HlPerp feed can label its prediction with the already-settled
      // hour boundary. Confirm that boundary with fundingHistory, then use the
      // documented hourly schedule; never advance arbitrary stale timestamps.
      if (end === Math.floor(now / 3600000) * 3600000 && Number(p.fundingIntervalHours) === 1) {
        const settled = await json(endpoint, { type: "fundingHistory", coin, startTime: end - 3600000 });
        const latest = Array.isArray(settled) ? Math.max(...settled.filter(r => r.coin === coin && finite(r.time)).map(r => Number(r.time))) : NaN;
        if (Math.floor(latest / 3600000) * 3600000 !== end) throw new Error("HL 最新结算边界尚未核实");
        end += 3600000;
      }
      if (end <= now || end - now > 3600000 || Math.abs(predicted) > .04) throw new Error("HL 官方预测已过期或参数异常");
      return { ok: true, exchange: "hyperliquid", symbol: coin, predicted, officialRate: predicted,
        kind: "official", hours: 1, end, checkedAt: now, floor: -.04, cap: .04,
        method: "HL 官方 predictedFundings · HlPerp · 已为每小时费率，不再除以 8",
        assumption: "官方当前预测，会随后续溢价变化；非最终结算费率" };
    }
    async function metadata(exchange, coin) {
      if (UNVERIFIED[exchange]) throw new Error(UNVERIFIED[exchange]);
      const symbol = `${coin}USDT`;
      let hours, end, floor, cap, interest = 0.0001, officialRate, serverTime;
      if (exchange === "binance" || exchange === "aster") {
        const base = exchange === "binance" ? "https://fapi.binance.com" : "https://fapi.asterdex.com";
        const p = await json(url(base, "/fapi/v1/premiumIndex", { symbol }));
        if (p.symbol !== symbol) throw new Error("合约身份不匹配");
        const info = one(await json(`${base}/fapi/v1/fundingInfo`), "symbol", symbol);
        hours = number(info.fundingIntervalHours); end = number(p.nextFundingTime);
        cap = number(exchange === "binance" ? info.adjustedFundingRateCap : info.fundingFeeCap);
        floor = number(exchange === "binance" ? info.adjustedFundingRateFloor : info.fundingFeeFloor);
        interest = number(p.interestRate); officialRate = number(p.lastFundingRate); serverTime = number(p.time);
      } else if (exchange === "bybit") {
        const base = "https://api.bybit.com";
        const data = await json(url(base, "/v5/market/instruments-info", { category: "linear", symbol }));
        const info = one(data.result?.list, "symbol", symbol);
        if (info.baseCoin !== coin || info.quoteCoin !== "USDT" || info.contractType !== "LinearPerpetual" || info.status !== "Trading" || info.isPreListing) throw new Error("该合约不是已核实的普通永续");
        const ticker = await json(url(base, "/v5/market/tickers", { category: "linear", symbol }));
        const p = one(ticker.result?.list, "symbol", symbol);
        hours = number(info.fundingInterval) / 60; end = number(p.nextFundingTime);
        floor = number(info.lowerFundingRate); cap = number(info.upperFundingRate);
        interest = ["USDC", "ETHBTC"].includes(coin) ? 0 : 0.0003 * hours / 24;
        officialRate = number(p.fundingRate); serverTime = number(ticker.time);
      } else if (exchange === "bitget") {
        const base = "https://api.bitget.com";
        const info = one((await json(url(base, "/api/v3/market/instruments", { category: "USDT-FUTURES", symbol }))).data, "symbol", symbol);
        if (info.baseCoin !== coin || info.symbolType !== "crypto" || info.type !== "perpetual" || info.status !== "online") throw new Error("该合约未核实支持官方溢价历史");
        const data = await json(url(base, "/api/v2/mix/market/current-fund-rate", { productType: "USDT-FUTURES", symbol }));
        const p = one(data.data, "symbol", symbol);
        hours = number(p.fundingRateInterval); end = number(p.nextUpdate);
        cap = number(p.maxFundingRate); floor = number(p.minFundingRate); officialRate = number(p.fundingRate); serverTime = number(data.requestTime);
      } else if (exchange === "okx") {
        const instId = `${coin}-USDT-SWAP`;
        const p = one((await json(url("https://www.okx.com", "/api/v5/public/funding-rate", { instId }))).data, "instId", instId);
        if (p.formulaType !== "withRate") throw new Error("该合约资金费公式尚未适配");
        end = number(p.fundingTime); hours = (end - number(p.prevFundingTime)) / 3600000;
        interest = number(p.interestRate); floor = number(p.minFundingRate); cap = number(p.maxFundingRate);
        officialRate = number(p.fundingRate); serverTime = number(p.ts);
      } else if (exchange === "gate") {
        const p = await json(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${encodeURIComponent(coin + "_USDT")}`);
        if (p.name !== coin + "_USDT" || p.type !== "direct" || p.contract_type || p.is_pre_market || p.in_delisting || p.status !== "trading") throw new Error("该合约当前不在普通永续范围");
        hours = number(p.funding_interval) / 3600; end = number(p.funding_next_apply) * 1000;
        cap = number(p.funding_rate_limit); floor = -cap; interest = number(p.interest_rate) / 3;
        officialRate = number(p.funding_rate); serverTime = clock();
      } else {
        throw new Error("HL 暂无可回补的本周期历史溢价接口，不能按当前指数冒充整周期估算");
      }
      if (Math.abs(clock() - serverTime) > 120000) throw new Error("官方行情时间已过期");
      const samples = ["binance", "aster", "bitget"].includes(exchange) ? 12 : 1;
      return { hours, end, start: end - hours * 3600000, floor, cap, interest, officialRate,
        divisor: exchange === "bybit" ? 1 : 8 / hours, samples,
        // Bybit's 1m close stamped at start + 1m is the first settlement sample.
        // Confirmed against 1h, 4h, 8h completed periods; OKX uses [start, end).
        sampleOffset: ["bybit", "gate"].includes(exchange) ? 1 : 0,
        verifyGate: exchange === "gate",
        bounded: samples === 12,
        equal: ["binance", "aster"].includes(exchange) && hours === 1, serverTime };
    }
    async function candles(exchange, coin, start, end) {
      const symbol = coin + "USDT";
      let data;
      if (["binance", "aster"].includes(exchange)) {
        data = await json(url(exchange === "binance" ? "https://fapi.binance.com" : "https://fapi.asterdex.com", "/fapi/v1/premiumIndexKlines", { symbol, interval: "1m", startTime: start, endTime: end, limit: 1000 }));
      } else if (exchange === "bitget") {
        data = (await json(url("https://api.bitget.com", "/api/v3/market/candles", { category: "USDT-FUTURES", symbol, interval: "1m", type: "premium", startTime: start, endTime: end, limit: 1000 }))).data;
      } else if (exchange === "bybit") {
        data = (await json(url("https://api.bybit.com", "/v5/market/premium-index-price-kline", { category: "linear", symbol, interval: "1", start, end, limit: 1000 }))).result?.list;
      } else if (exchange === "gate") {
        data = await json(url("https://api.gateio.ws", "/api/v4/futures/usdt/premium_index", { contract: coin + "_USDT", from: Math.floor(start / 1000), to: Math.floor(end / 1000), interval: "1m", limit: 1000 }));
        const priceParams = { from: Math.floor((start - MINUTE) / 1000), to: Math.floor(end / 1000), interval: "1m" };
        const marks = await json(url("https://api.gateio.ws", "/api/v4/futures/usdt/candlesticks", { ...priceParams, contract: "mark_" + coin + "_USDT" }));
        const indices = await json(url("https://api.gateio.ws", "/api/v4/futures/usdt/candlesticks", { ...priceParams, contract: "index_" + coin + "_USDT" }));
        return gatePremiumRows(data, marks, indices);
      } else if (exchange === "okx") {
        let cursor = "", rows = [];
        for (let page = 0; page < 6; page++) {
          const part = (await json(url("https://www.okx.com", "/api/v5/public/premium-history", { instId: coin + "-USDT-SWAP", limit: 100, ...(cursor ? { after: cursor } : {}) }))).data;
          if (!Array.isArray(part) || !part.length) break;
          rows.push(...part.map(r => ({ t: number(r.ts), p: number(r.premium), close: number(r.premium) })));
          const oldest = Math.min(...part.map(r => number(r.ts)));
          if (oldest <= start || String(oldest) === cursor) break;
          cursor = String(oldest);
        }
        return rows;
      }
      if (!Array.isArray(data)) throw new Error("历史溢价返回异常");
      return data.map(r => ({ t: number(r[0]), p: exchange === "bybit" ? number(r[4]) : r.slice(1, 5).map(number).reduce((a, b) => a + b, 0) / 4,
        low: number(r[3]), high: number(r[2]),
        close: number(r[4]), ...(["binance", "aster"].includes(exchange) ? { count: number(r[8]) } : {}) }));
    }
    async function query(exchange, coin) {
      if (!EXCHANGES.includes(exchange) || typeof coin !== "string" || !/^[\p{L}\p{N}_-]{1,60}$/u.test(coin)) return { ok: false, error: "币种或交易所未识别" };
      coin = coin.toUpperCase();
      const key = exchange + ":" + coin;
      const old = cache.get(key);
      if (old && clock() - old.checkedAt < (old.ok ? 15000 : 5000) && (!old.end || clock() < old.end)) return old;
      if (flights.has(key)) return flights.get(key);
      const task = (async () => {
        try {
          if (exchange === "hyperliquid") return await hyperliquid(coin);
          let config = await metadata(exchange, coin);
          let saved = history.get(key);
          if (saved?.start !== config.start || saved?.hours !== config.hours) saved = null;
          const from = saved?.rows.length ? Math.max(config.start, Math.max(...saved.rows.map(r => r.t)) - 2 * MINUTE) : config.start;
          let rows = await candles(exchange, coin, from, config.serverTime);
          const merged = new Map((saved?.rows || []).map(r => [r.t, r]));
          rows.forEach(r => merged.set(r.t, r)); rows = [...merged.values()].filter(r => r.t >= config.start);
          let result;
          try { result = project(config, rows, config.serverTime); }
          catch (e) {
            if (!e.message.includes("缺口") && !e.message.includes("尚未同步")) throw e;
            // Retry gaps against the full cycle. Never fill missing historical data with zero.
            const venueHost = { gate: "api.gateio.ws", bybit: "api.bybit.com", okx: "www.okx.com", binance: "fapi.binance.com", aster: "fapi.asterdex.com", bitget: "api.bitget.com" }[exchange];
            for (const k of requests.keys()) {
              const u = new URL(k);
              if (venueHost && u.host === venueHost &&
                  (u.searchParams.get("symbol") === coin + "USDT" || u.searchParams.get("instId") === coin + "-USDT-SWAP" ||
                   [coin + "_USDT", "mark_" + coin + "_USDT", "index_" + coin + "_USDT"].includes(u.searchParams.get("contract")) ||
                   u.pathname.endsWith("/contracts/" + encodeURIComponent(coin + "_USDT")))) requests.delete(k);
            }
            await sleep(700);
            if (exchange === "gate") {
              config = await metadata(exchange, coin);
              merged.clear(); // new settlement cycle or a corrected input must not retain an old join
            }
            const repaired = await candles(exchange, coin, config.start, clock());
            repaired.forEach(r => merged.set(r.t, r)); rows = [...merged.values()].filter(r => r.t >= config.start);
            result = project(config, rows, config.serverTime);
          }
          if (clock() >= config.end || clock() - result.checkedAt >= 120000) throw new Error("周期已切换或响应超时，请重新计算");
          history.set(key, { start: config.start, hours: config.hours, rows });
          if (history.size > 100) history.delete(history.keys().next().value);
          return { ok: true, exchange, symbol: coin, ...result };
        } catch (e) { return { ok: false, error: e.message || "查询失败，稍后重试", checkedAt: clock() }; }
      })();
      flights.set(key, task);
      try { const result = await task; cache.set(key, result); if (cache.size > 100) cache.delete(cache.keys().next().value); return result; }
      finally { flights.delete(key); }
    }
    return query;
  }
  root.FundingRadarProjection = { project, reconstruct, reconstructRange, fee, gatePremiumRows, createClient, EXCHANGES, UNVERIFIED, MAX_SAMPLING_ERROR };
  if (typeof module !== "undefined") module.exports = root.FundingRadarProjection;
})(globalThis);
