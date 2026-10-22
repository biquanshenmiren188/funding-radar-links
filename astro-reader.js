/* Runs only in the configured dashboard's MAIN world. Uses its existing signed HTTP client.
   No credentials leave the page; only three allowlisted, read-only endpoint shapes are used. */
async function readAstroRiskSnapshot(expectedOrigin) {
  if (location.origin !== expectedOrigin) throw new Error("看板地址已改变，请重新打开插件");
  // Discover the page's configured client by capabilities, never by build hash or
  // minified export name. Import only the already-loaded same-origin entry.
  const entries = [...document.querySelectorAll('script[type="module"][src]')]
    .map(el => new URL(el.src, location.href))
    .filter(url => url.origin === expectedOrigin && /\/assets\/index-[\w-]+\.js$/.test(url.pathname));
  const urls = [...new Set(entries.map(url => url.href))];
  if (urls.length !== 1) throw new Error("无法唯一识别看板入口，请刷新看板");
  const entry = new URL(urls[0]);
  const module = await import(entry.href);
  const clients = [...new Set(Object.values(module))].filter(value => {
    if (!value || typeof value.get !== "function" || typeof value.request !== "function" ||
        typeof value.getUri !== "function" || value.defaults?.withCredentials !== true ||
        typeof value.defaults?.baseURL !== "string" ||
        typeof value.interceptors?.request?.use !== "function" ||
        typeof value.interceptors?.response?.use !== "function") return false;
    try { return new URL(value.defaults.baseURL, location.href).origin === expectedOrigin; }
    catch (_) { return false; }
  });
  if (clients.length !== 1) throw new Error("无法唯一识别看板只读接口");
  const client = clients[0];
  const read = async path => {
    const response = await client.get(path, { timeout: 10000 });
    if (response?.data?.code !== 0 || !response.data.data) throw new Error("软件账户查询失败，请确认已登录");
    return response.data.data;
  };
  const config = await read("/api/config");
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!Array.isArray(config.coinPairs) || !record(config.mmr) ||
      !config.coinPairs.every(p => record(p) && typeof p.name === "string" &&
        typeof p.type === "string" && typeof p.buyEx === "string" && typeof p.sellEx === "string"))
    throw new Error("软件持仓或 MMR 数据结构已改变");
  const pairs = config.coinPairs.map(p => ({ id: p.id, type: p.type, name: p.name,
    buyEx: p.buyEx, sellEx: p.sellEx, aExPosition: p.aExPosition, bExPosition: p.bExPosition,
    avgOpenAExPrice: p.avgOpenAExPrice, avgOpenBExPrice: p.avgOpenBExPrice, spotMarginType: p.spotMarginType }));
  const venues = ["binance", "bitget"].filter(ex => pairs.some(p =>
    p.type === "FS" && p.spotMarginType === "cross" && p.sellEx === ex && Number(p.bExPosition) > 0));
  const accounts = {};
  await Promise.all(venues.map(async ex => {
    try {
      const account = await read(`/api/ex-position?ex=${ex}`);
      if (!record(account.spot) || !record(account.future) ||
          !["number", "string"].includes(typeof account.futureMargin) ||
          String(account.futureMargin).trim() === "" || !Number.isFinite(Number(account.futureMargin)))
        throw new Error("账户数据结构已改变");
      const coins = new Set(pairs.filter(p => p.buyEx === ex || p.sellEx === ex).map(p => p.name));
      for (const key of Object.keys(account.future || {})) coins.add(key.replace(/-(LONG|SHORT|PRICE|MARGIN_MODE)$/, ""));
      const prices = {};
      for (const coin of coins) {
        if (typeof coin !== "string" || coin.length > 60) continue;
        const live = window[ex];
        const candidates = [live?.spot?.[coin], live?.future?.[coin], account.future?.[`${coin}-PRICE`]];
        const price = candidates.find(value => (typeof value === "number" || typeof value === "string") && Number.isFinite(Number(value)) && Number(value) > 0);
        if (price !== undefined) prices[coin] = Number(price);
      }
      accounts[ex] = { displayedMargin: account.futureMargin, mmr: config.mmr[ex],
        spot: account.spot, future: account.future, prices };
    } catch (_) { accounts[ex] = { error: "该交易所账户查询失败，旧结果已弃用" }; }
  }));
  if (location.origin !== expectedOrigin) throw new Error("读取时页面已切换");
  return { capturedAt: Date.now(), pairs, accounts };
}
if (typeof module !== "undefined") module.exports = { readAstroRiskSnapshot };
