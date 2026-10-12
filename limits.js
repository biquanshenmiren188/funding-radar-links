(function (root) {
  "use strict";
  const FRESH_MS = 30000;
  function settings(value = {}) {
    const coins = [...new Set(String(value.coins || "").split(/[\s,，;；]+/)
      .map(s => s.trim().toUpperCase()).filter(s => s && s.length <= 60))].slice(0, 100);
    return { enabled: value.enabled === true, interval: [30, 60, 120, 300].includes(Number(value.interval)) ? Number(value.interval) : 60, coins };
  }
  function classify(symbol, meta, caps) {
    if (typeof symbol !== "string" || !symbol.trim() || symbol.length > 60 || symbol.includes(":")) {
      return { state: "unknown", reason: "币种未识别或不在原生永续查询范围" };
    }
    if (!Array.isArray(meta?.universe) || !meta.universe.length ||
        !meta.universe.every(x => x && typeof x.name === "string" && x.name && (x.isDelisted === undefined || typeof x.isDelisted === "boolean")) ||
        !Array.isArray(caps) || !caps.every(x => typeof x === "string" && x)) {
      throw new Error("接口返回格式异常");
    }
    const coin = symbol.trim().toUpperCase();
    const matches = meta.universe.filter(x => x.name.toUpperCase() === coin);
    if (matches.length !== 1) return { state: "unknown", reason: "未精确匹配到唯一的 HL 永续币种" };
    if (matches[0].isDelisted) return { state: "restricted", reason: "HL 已下架该合约" };
    if (caps.some(x => x.toUpperCase() === coin)) return { state: "restricted", reason: "HL 已触及公共持仓上限，限制增加持仓" };
    return { state: "open", reason: "HL 未触及公共持仓上限（仅检查该项开仓限制）" };
  }
  function createClient(fetcher = fetch, now = Date.now, timeoutMs = 10000) {
    let cached, flight, retryAfter = 0;
    async function snapshot() {
      if (cached && now() - cached.checkedAt < 10000) return cached;
      if (flight) return flight;
      if (now() < retryAfter) throw new Error("查询暂不可用，请稍后重试");
      flight = (async () => {
        const checkedAt = now();
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), timeoutMs);
        try {
          const post = async type => {
            const response = await fetcher("https://api.hyperliquid.xyz/info", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type }), credentials: "omit", cache: "no-store",
              redirect: "error", signal: abort.signal
            });
            if (!response.ok) throw new Error(`HL 接口 HTTP ${response.status}`);
            return response.json();
          };
          const [meta, caps] = await Promise.all([post("meta"), post("perpsAtOpenInterestCap")]);
          classify("BTC", meta, caps); // Reject malformed snapshots before sharing the cache.
          cached = { meta, caps, checkedAt };
          return cached;
        } catch (error) {
          abort.abort();
          cached = undefined;
          retryAfter = now() + 5000;
          throw error;
        } finally { clearTimeout(timer); }
      })();
      try { return await flight; } finally { flight = undefined; }
    }
    return async symbol => {
      if (typeof symbol !== "string" || !symbol.trim() || symbol.length > 60 || symbol.includes(":")) {
        return { state: "unknown", reason: "币种未识别或不在原生永续查询范围", checkedAt: now() };
      }
      try {
        const data = await snapshot();
        return { ...classify(symbol, data.meta, data.caps), checkedAt: data.checkedAt };
      } catch (error) {
        return { state: "unknown", reason: error.name === "AbortError" ? "HL 查询超时" : String(error.message || error), checkedAt: now() };
      }
    };
  }
  root.FundingRadarLimits = { settings, classify, createClient, FRESH_MS };
  if (typeof module !== "undefined") module.exports = root.FundingRadarLimits;
})(globalThis);
