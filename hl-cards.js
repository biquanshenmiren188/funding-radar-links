// Serialized into the configured page by chrome.scripting. Return contract identity fields only.
async function readHlCardMarkets(origin) {
  if (location.origin !== origin) return null;
  const entries = [...new Set([...document.querySelectorAll('script[type="module"][src]')]
    .map(el => new URL(el.src, location.href))
    .filter(url => url.origin === origin && /\/assets\/index-[\w-]+\.js$/.test(url.pathname))
    .map(url => url.href))];
  if (entries.length !== 1) return null;
  const entry = await import(entries[0]);
  const clients = [...new Set(Object.values(entry))].filter(c =>
    typeof c?.get === "function" && typeof c.getUri === "function" &&
    c.defaults?.withCredentials === true && typeof c.defaults.baseURL === "string" &&
    new URL(c.defaults.baseURL, location.href).origin === origin);
  if (clients.length !== 1) return null;
  const response = await clients[0].get("/api/config", { timeout: 8000 });
  const pairs = response?.data?.data?.coinPairs;
  if (location.origin !== origin || response?.data?.code !== 0 || !Array.isArray(pairs)) return null;
  return pairs.filter(p => p && [p.buyEx, p.sellEx].some(ex => ["gc-hl", "hl", "hyperliquid"].includes(ex)))
    .map(({name, type, buyEx, sellEx, aHlDex, bHlDex, aEffectiveHlDex, bEffectiveHlDex, aMarketSymbol, bMarketSymbol}) =>
      ({name, type, buyEx, sellEx, aHlDex, bHlDex, aEffectiveHlDex, bEffectiveHlDex, aMarketSymbol, bMarketSymbol}));
}

function resolveHlMarket(title, pairs) {
  const markets = new Set();
  for (const pair of pairs) {
    if (typeof pair.name !== "string" || !["FF","SF","FS","FR","SR"].includes(pair.type)) continue;
    const spread = pair.type === "FR" || pair.type === "SR";
    const parts = (spread ? pair.name.split("-") : [pair.name]).map(s => s.trim().toUpperCase().replace(/USDT$/, ""));
    if (spread && parts.length !== 2) continue;
    const display = parts.join("-");
    if (title.toUpperCase() !== display && !(spread && parts[0] === parts[1] && title.toUpperCase() === parts[0])) continue;
    for (const [index, side, exchange] of [[0,"a",pair.buyEx],[1,"b",pair.sellEx]]) {
      if (!["gc-hl","hl","hyperliquid"].includes(exchange)) continue;
      if (index === 0 ? ["SF","SR"].includes(pair.type) : pair.type === "FS") continue;
      const configured = pair[side + "EffectiveHlDex"] || pair[side + "HlDex"] || "default";
      const dex = String(configured).trim().toLowerCase();
      const raw = String(pair[side + "MarketSymbol"] || parts[spread ? index : 0]).trim();
      const names = raw.split(":");
      if (!/^[a-z0-9]{1,20}$/.test(dex) || names.length > 2 ||
          (names.length === 2 && names[0].toLowerCase() !== dex)) return null;
      const coin = names.at(-1).toUpperCase();
      if (!/^[A-Z0-9._-]{1,60}$/.test(coin)) return null;
      markets.add(dex === "default" ? coin : dex + ":" + coin);
    }
  }
  return markets.size === 1 ? [...markets][0] : null;
}
if (typeof module !== "undefined") module.exports = { readHlCardMarkets, resolveHlMarket };
