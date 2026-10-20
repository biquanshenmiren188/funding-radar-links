/* Runs only in the configured dashboard's MAIN world. Uses its existing signed HTTP client.
   No credentials leave the page; only three allowlisted, read-only endpoint shapes are used. */
async function readAstroRiskSnapshot(expectedOrigin) {
  if (location.origin !== expectedOrigin) throw new Error("看板地址已改变，请重新打开插件");
  // Build/export pairs are verified against the dashboard's own GET calls.
  // Minified export names can change independently of the response schema.
  const clients = { "index-CW16nN3e.js": "cD", "index-UbpzoVda.js": "cE", "index-CftXA7IB.js": "cF" };
  const entry = [...document.querySelectorAll('script[type="module"][src]')]
    .map(el => new URL(el.src, location.href))
    .find(url => url.origin === expectedOrigin && /\/assets\/index-[\w-]+\.js$/.test(url.pathname) &&
      Object.hasOwn(clients, url.pathname.split("/").pop()));
  if (!entry) throw new Error("当前软件版本尚未适配账户读取，请保持交易看板页面打开");
  // This export was verified against the running build. Fail closed after a build change.
  const module = await import(entry.href);
  const client = module[clients[entry.pathname.split("/").pop()]];
  if (!client || typeof client.get !== "function") throw new Error("软件只读接口版本不匹配");
  const read = async path => {
    const response = await client.get(path, { timeout: 10000 });
    if (response?.data?.code !== 0 || !response.data.data) throw new Error("软件账户查询失败，请确认已登录");
    return response.data.data;
  };
  const config = await read("/api/config");
  if (!Array.isArray(config.coinPairs) || !config.mmr) throw new Error("软件未返回持仓或 MMR");
  const pairs = config.coinPairs.map(p => ({ id: p.id, type: p.type, name: p.name,
    buyEx: p.buyEx, sellEx: p.sellEx, aExPosition: p.aExPosition, bExPosition: p.bExPosition,
    avgOpenAExPrice: p.avgOpenAExPrice, avgOpenBExPrice: p.avgOpenBExPrice, spotMarginType: p.spotMarginType }));
  const venues = ["binance", "bitget"].filter(ex => pairs.some(p =>
    p.type === "FS" && p.spotMarginType === "cross" && p.sellEx === ex && Number(p.bExPosition) > 0));
  const accounts = {};
  await Promise.all(venues.map(async ex => {
    try {
      const account = await read(`/api/ex-position?ex=${ex}`);
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
