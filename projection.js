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
      if (index < 0 || index >= minutes) continue;
      if (![row.t, row.p, row.close].every(Number.isFinite)) throw new Error("溢价数据异常");
      const old = byMinute.get(index);
      if (old && old.t !== row.t) throw new Error("同一分钟存在多个溢价采样，口径未核实");
      byMinute.set(index, row);
    }
    let past = 0, weight = 0, low = 0, high = 0;
    for (let i = 0; i < minutes; i++) {
      const r = byMinute.get(i);
      if (!r || (r.count !== undefined && r.count !== samples)) {
        const stamp = new Date(start + (i + sampleOffset) * MINUTE).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
        throw new Error(`本周期历史溢价有缺口：${stamp}（UTC+8）${r ? `采样 ${r.count}/${samples}` : "尚未返回"}，等待官方补齐后自动重试`);
      }
      latest = r; // The extrapolation anchor must belong to validated, completed history.
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
    const expectedAsOf = Math.floor(now / MINUTE) * MINUTE - (config.forecastLagMinutes || 0) * MINUTE;
    let elapsed = Math.floor((expectedAsOf - start) / MINUTE);
    if (elapsed < 1) throw new Error("本周期首个完整分钟尚未发布，稍后重试");
    if (!rows.length) throw new Error("最新溢价尚未更新，稍后重试");
    const maxLag = config.maxHistoryLagMinutes || 0;
    if (maxLag) {
      const indexed = new Map(rows.map(r => [r.t, r]));
      const expected = elapsed;
      while (elapsed > 0) {
        const r = indexed.get(start + (elapsed - 1 + (config.sampleOffset || 0)) * MINUTE);
        if (r && (r.count === undefined || r.count === samples)) break;
        elapsed--;
      }
      if (!elapsed || expected - elapsed > maxLag) throw new Error(`官方完整历史延迟超过 ${maxLag} 分钟，等待更新后自动重试`);
    }
    const dataAsOf = start + elapsed * MINUTE;
    const historyLagMinutes = Math.max(0, (expectedAsOf - dataAsOf) / MINUTE);
    const { past, weight, latest, low, high } = weightedHistory(config, rows, elapsed, dataAsOf);
    if (!latest || now - latest.t > 120000 + maxLag * MINUTE) throw new Error("最新溢价尚未更新，稍后重试");
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
      currentPremium: latest.close, premiumAt: latest.t, dataAsOf, historyLagMinutes, futureWeightRatio: futureWeight / total, average,
      observedMinutes: elapsed, totalMinutes: hours * 60, end, hours, floor, cap,
      officialRate: config.officialRate, checkedAt: now,
      method: config.verifyGate ? "Gate 分钟溢价按标记价/指数价换算 · 时间递增加权 · 已核对官方当前费率" : samples === 12 ? "分钟 OHLC 近似 5 秒采样；用每分钟高低值计算采样误差区间" : "官方分钟溢价采样",
      assumption: "以最新完整分钟的末次溢价外推剩余时间；分钟内保持同一数据快照，非最终结算费率" };
  }
  function createClient(fetcher = fetch, clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), { queryTimeoutMs = 20000 } = {}) {
    const flights = new Map(), cache = new Map(), history = new Map(), requests = new Map();
    const lanes = new Map();
    function publish(entry, progress) {
      entry.progress = progress;
      for (const listener of entry.listeners || []) { try { listener(progress); } catch (_) {} }
    }
    function bounded(promise, signal) {
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve(promise).then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
      });
    }
    function consume(entry, signal, onProgress) {
      const consumer = Symbol(); entry.consumers.add(consumer);
      if (onProgress) { entry.listeners.add(onProgress); if (entry.progress) { try { onProgress(entry.progress); } catch (_) {} } }
      return bounded(entry.promise, signal).finally(() => {
        entry.consumers.delete(consumer);
        if (onProgress) entry.listeners.delete(onProgress);
        // Shared metadata remains alive while another market still needs it.
        if (!entry.settled && !entry.consumers.size) entry.controller.abort(new Error("本轮查询已结束"));
      });
    }
    async function requestJson(url, body, signal, onProgress) {
      signal.throwIfAborted();
      const requestKey = url + (body ? "#" + JSON.stringify(body) : "");
      const old = requests.get(requestKey);
      if (old && !old.controller.signal.aborted && (!old.settled || clock() - old.at < 9000)) {
        if (old.settled) { onProgress?.({ stage: "cache", endpoint: new URL(url).pathname, queueMs: 0, requestMs: 0 }); return consume(old, signal); }
        return consume(old, signal, onProgress);
      }
      const host = new URL(url).host;
      const previous = lanes.get(host) || Promise.resolve();
      const entry = { at: clock(), controller: new AbortController(), consumers: new Set(), listeners: new Set(), settled: false };
      const requestSignal = entry.controller.signal;
      const queuedAt = clock(), endpoint = new URL(url).pathname;
      publish(entry, { stage: "queued", endpoint });
      const promise = previous.catch(() => {}).then(async () => {
        requestSignal.throwIfAborted();
        const began = clock(), queueMs = began - queuedAt;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            publish(entry, { stage: attempt ? "retry" : "request", endpoint, attempt: attempt + 1, queueMs });
            const attemptSignal = AbortSignal.any([requestSignal, AbortSignal.timeout(10000)]);
            const response = await bounded(fetcher(url, { signal: attemptSignal, credentials: "omit", redirect: "error", cache: "no-store",
              ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }), attemptSignal);
            if (!response.ok) {
              if (response.status === 429 || response.status >= 500) {
                if (attempt < 2) {
                  publish(entry, { stage: "retry", endpoint, attempt: attempt + 1, queueMs });
                  await bounded(sleep(Math.min(10000, Math.max(1000 * 2 ** attempt, Number(response.headers?.get("retry-after")) * 1000 || 0))), requestSignal); continue;
                }
              }
              throw new Error(`官方接口 HTTP ${response.status}`);
            }
            const data = await bounded(response.json(), attemptSignal);
            if ((data.code !== undefined && !["0", "00000", 0].includes(data.code)) || (data.retCode !== undefined && data.retCode !== 0)) throw new Error("官方接口暂未返回有效数据");
            publish(entry, { stage: "received", endpoint, attempts: attempt + 1, queueMs, requestMs: clock() - began });
            return data;
          } catch (e) {
            publish(entry, { stage: "failed-attempt", endpoint, attempt: attempt + 1, queueMs, requestMs: clock() - began });
            requestSignal.throwIfAborted();
            if (attempt < 2 && ["TimeoutError", "AbortError", "TypeError"].includes(e.name)) {
              publish(entry, { stage: "retry", endpoint, attempt: attempt + 1, queueMs });
              await bounded(sleep(1000 * 2 ** attempt), requestSignal); continue;
            }
            throw e;
          }
        }
      });
      entry.promise = promise;
      promise.then(() => { entry.settled = true; entry.at = clock(); }, () => { entry.settled = true; });
      const lane = promise.then(() => sleep(250), () => sleep(250));
      lanes.set(host, lane);
      lane.then(() => { if (lanes.get(host) === lane) lanes.delete(host); });
      requests.set(requestKey, entry);
      promise.catch(() => { if (requests.get(requestKey)?.promise === promise) requests.delete(requestKey); });
      if (requests.size > 200) requests.delete(requests.keys().next().value);
      return consume(entry, signal, onProgress);
    }
    const url = (base, path, params) => `${base}${path}?${new URLSearchParams(params)}`;
    function one(rows, field, value) {
      const found = Array.isArray(rows) ? rows.filter(x => x[field] === value) : [];
      if (found.length !== 1) throw new Error("官方目录未匹配到唯一合约");
      return found[0];
    }
    async function hyperliquid(coin, signal, progress) {
      const json = (url, body) => requestJson(url, body, signal, progress);
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
    async function metadata(exchange, coin, signal, progress) {
      const json = (url, body) => requestJson(url, body, signal, progress);
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
        // Bybit's audited settlement alignment uses the candle stamped at the
        // sample endpoint. That candle itself must finish before a live forecast.
        forecastLagMinutes: exchange === "bybit" ? 1 : 0,
        verifyGate: exchange === "gate", maxHistoryLagMinutes: 5,
        bounded: samples === 12,
        equal: ["binance", "aster"].includes(exchange) && hours === 1, serverTime };
    }
    async function candles(exchange, coin, start, end, signal, progress) {
      const json = (url, body) => requestJson(url, body, signal, progress);
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
    async function query(exchange, coin, { signal: consumerSignal = new AbortController().signal, onProgress } = {}) {
      consumerSignal.throwIfAborted();
      if (!EXCHANGES.includes(exchange) || typeof coin !== "string" || !/^[\p{L}\p{N}_-]{1,60}$/u.test(coin)) return { ok: false, error: "币种或交易所未识别" };
      coin = coin.toUpperCase();
      const key = exchange + ":" + coin;
      const old = cache.get(key);
      if (old?.ok && exchange !== "hyperliquid" && old.end > clock() &&
          Math.floor(old.checkedAt / MINUTE) === Math.floor(clock() / MINUTE)) return old;
      if (old && clock() - old.checkedAt < (old.ok ? 9000 : 5000) && (!old.end || clock() < old.end)) return old;
      const inFlight = flights.get(key);
      if (inFlight && !inFlight.controller.signal.aborted) return consume(inFlight, consumerSignal, onProgress);
      const entry = { controller: new AbortController(), consumers: new Set(), listeners: new Set(), settled: false };
      const began = clock(), timings = [];
      const progress = detail => {
        if (["received", "failed-attempt"].includes(detail.stage)) {
          const previous = timings.at(-1);
          if (previous?.endpoint === detail.endpoint && previous.stage === "failed-attempt") timings.pop();
          timings.push(detail); if (timings.length > 40) timings.shift();
        }
        publish(entry, { ...detail, elapsedMs: clock() - began });
      };
      const task = (async () => {
        const controller = entry.controller, signal = controller.signal;
        const deadline = setTimeout(() => controller.abort(new Error(`计算超过 ${queryTimeoutMs / 1000} 秒，本轮已结束，稍后自动重试`)), queryTimeoutMs);
        try {
          if (exchange === "hyperliquid") return { ...await hyperliquid(coin, signal, progress), diagnostics: { elapsedMs: clock() - began, requests: timings } };
          let config = await metadata(exchange, coin, signal, progress);
          let saved = history.get(key);
          if (saved?.start !== config.start || saved?.hours !== config.hours) saved = null;
          const merged = new Map((saved?.rows || []).map(r => [r.t, r]));
          const complete = r => r && [r.t, r.p, r.close].every(Number.isFinite) && (r.count === undefined || r.count === config.samples) &&
            (!config.bounded || ([r.low, r.high].every(Number.isFinite) && r.low <= r.p && r.p <= r.high && r.low <= r.close && r.close <= r.high));
          function gaps(overlap) {
            const count = Math.max(0, Math.floor((Math.floor(config.serverTime / MINUTE) * MINUTE - (config.forecastLagMinutes || 0) * MINUTE - config.start) / MINUTE));
            const wanted = [];
            for (let i = 0; i < count; i++) {
              const t = config.start + (i + (config.sampleOffset || 0)) * MINUTE;
              if (!complete(merged.get(t)) || (overlap && i >= count - 3)) wanted.push(t);
            }
            const ranges = [];
            for (const t of wanted) {
              const last = ranges.at(-1);
              if (last && last.end + 1 === t) last.end = t + MINUTE - 1;
              else ranges.push({ start: t, end: t + MINUTE - 1 });
            }
            return ranges;
          }
          async function fetchRanges(ranges) {
            // OKX only exposes a backwards cursor, not independent bounded ranges.
            if (exchange === "okx" && ranges.length > 1) ranges = [{ start: ranges[0].start, end: ranges.at(-1).end }];
            for (const range of ranges) {
              progress({ stage: "history", from: range.start, to: Math.min(range.end, config.serverTime) });
              const part = await candles(exchange, coin, range.start, Math.min(range.end, config.serverTime), signal, progress);
              for (const r of part) if (!complete(merged.get(r.t)) || complete(r)) merged.set(r.t, r);
              // Preserve validated minutes even when a later gap or request fails.
              // Gate consistency repairs replace the whole three-series snapshot.
              if (exchange !== "gate") history.set(key, { start: config.start, hours: config.hours,
                rows: [...merged.values()].filter(r => r.t >= config.start && r.t < config.end && complete(r)) });
              if (history.size > 100) history.delete(history.keys().next().value);
            }
          }
          await fetchRanges(gaps(true));
          let rows = [...merged.values()].filter(r => r.t >= config.start);
          let result;
          try { result = project(config, rows, config.serverTime); }
          catch (e) {
            if (!e.message.includes("缺口") && !e.message.includes("尚未同步")) throw e;
            // Retry only missing minutes; Gate revalidates its joined snapshot.
            const venueHost = { gate: "api.gateio.ws", bybit: "api.bybit.com", okx: "www.okx.com", binance: "fapi.binance.com", aster: "fapi.asterdex.com", bitget: "api.bitget.com" }[exchange];
            for (const k of requests.keys()) {
              const u = new URL(k);
              if (venueHost && u.host === venueHost &&
                  (u.searchParams.get("symbol") === coin + "USDT" || u.searchParams.get("instId") === coin + "-USDT-SWAP" ||
                   [coin + "_USDT", "mark_" + coin + "_USDT", "index_" + coin + "_USDT"].includes(u.searchParams.get("contract")) ||
                   u.pathname.endsWith("/contracts/" + encodeURIComponent(coin + "_USDT")))) requests.delete(k);
            }
            await bounded(sleep(700), signal);
            if (exchange === "gate") {
              config = await metadata(exchange, coin, signal, progress);
              merged.clear(); // new settlement cycle or a corrected input must not retain an old join
            }
            progress({ stage: "repair" });
            await fetchRanges(gaps(false));
            rows = [...merged.values()].filter(r => r.t >= config.start);
            result = project(config, rows, config.serverTime);
          }
          if (clock() >= config.end || clock() - result.checkedAt >= 120000) throw new Error("周期已切换或响应超时，请重新计算");
          history.set(key, { start: config.start, hours: config.hours, rows: rows.filter(complete) });
          if (history.size > 100) history.delete(history.keys().next().value);
          return { ok: true, exchange, symbol: coin, ...result, diagnostics: { elapsedMs: clock() - began, requests: timings } };
        } catch (e) { return { ok: false, error: e.message || "查询失败，稍后重试", checkedAt: clock(), diagnostics: { elapsedMs: clock() - began, requests: timings } }; }
        finally { clearTimeout(deadline); }
      })();
      entry.promise = task;
      flights.set(key, entry);
      task.then(result => {
        entry.settled = true;
        if (!entry.controller.signal.aborted) { cache.set(key, result); if (cache.size > 100) cache.delete(cache.keys().next().value); }
        if (flights.get(key) === entry) flights.delete(key);
      }, () => { entry.settled = true; if (flights.get(key) === entry) flights.delete(key); });
      return consume(entry, consumerSignal, onProgress);
    }
    return query;
  }
  root.FundingRadarProjection = { project, reconstruct, reconstructRange, fee, gatePremiumRows, createClient, EXCHANGES, UNVERIFIED, MAX_SAMPLING_ERROR };
  if (typeof module !== "undefined") module.exports = root.FundingRadarProjection;
})(globalThis);
