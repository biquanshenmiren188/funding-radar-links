(function (root) {
  "use strict";

  const DEFAULT_RADAR_ORIGIN = "https://47.79.37.237";
  const radarExchanges = new Set(["binance", "bybit", "gate", "okx", "bitget", "aster", "hyperliquid"]);
  const gcExchanges = new Set(["binance", "bybit", "gate", "okx", "hl"]);

  function normalizeExchange(value) {
    let exchange = String(value || "").trim().toLowerCase();
    if (exchange.startsWith("gc-")) {
      exchange = exchange.slice(3);
      if (!gcExchanges.has(exchange)) return null;
    }
    if (exchange === "hl") exchange = "hyperliquid";
    return radarExchanges.has(exchange) ? exchange : null;
  }

  function normalizeSymbol(value) {
    return String(value || "")
      .trim()
      .replace(/^(?:\p{Extended_Pictographic}|\uFE0F|\u200D|\s)+/u, "")
      .trim();
  }

  function legType(classList) {
    if (classList.contains("ant-tag-green")) return "S";
    if (classList.contains("ant-tag-gold")) return "F";
    return null;
  }

  function cardElements(card) {
    const nameElement = card.querySelector(".ant-card-head .pair-name-link");
    const symbol = normalizeSymbol(nameElement?.textContent);
    if (!symbol) return null;

    const exchangeRow = Array.from(card.querySelectorAll("p"))
      .find(row => /^交易所\s*[:：]/.test(row.textContent.trim()));
    const tags = Array.from(exchangeRow?.querySelectorAll(".ant-tag") || [])
      .filter(tag => legType(tag.classList));
    if (tags.length !== 2) return null;
    return { nameElement, symbol, tags };
  }

  function readCard(card) {
    const elements = cardElements(card);
    if (!elements) return null;
    const { nameElement, symbol, tags } = elements;

    const mode = legType(tags[0].classList) + legType(tags[1].classList);
    if (!(["FF", "FS", "SF"].includes(mode))) return null;

    const exchanges = Array.from(tags, tag => normalizeExchange(tag.textContent));
    if (exchanges.some(value => value === null)) return null;
    return { nameElement, symbol, mode, exchanges };
  }

  function readBorrowCard(card) {
    const e = cardElements(card);
    if (!e || e.symbol.length > 60 || legType(e.tags[0].classList) !== "F" || legType(e.tags[1].classList) !== "S") return null;
    // Do not normalize GC into a native unified account: the collateral pool differs.
    const exchange = e.tags[1].textContent.trim().toLowerCase();
    if (!["binance", "bitget"].includes(exchange)) return null;
    return { nameElement: e.nameElement, symbol: e.symbol, exchange };
  }

  function readLimitCard(card) {
    const elements = cardElements(card);
    if (!elements || elements.symbol.length > 60) return null;
    const hlTags = elements.tags.filter(tag =>
      legType(tag.classList) === "F" && normalizeExchange(tag.textContent) === "hyperliquid");
    return hlTags.length ? { nameElement: elements.nameElement, symbol: elements.symbol, hlTags } : null;
  }

  function makeRadarUrl({ symbol, mode, exchanges }, radarOrigin = DEFAULT_RADAR_ORIGIN) {
    if (!(["FF", "FS", "SF"].includes(mode)) || !symbol || exchanges?.length !== 2) {
      throw new Error("Invalid card details");
    }
    const venues = exchanges.map(normalizeExchange);
    if (venues.some(value => value === null)) throw new Error("Unsupported Radar exchange");
    const base = new URL(radarOrigin);
    if (!["http:", "https:"].includes(base.protocol) || !base.hostname) {
      throw new Error("Invalid Radar site address");
    }
    const url = new URL("/radar/", base.origin);
    url.searchParams.set("tab", mode);
    url.searchParams.set("mode", mode);
    url.searchParams.set("q", symbol);
    url.searchParams.set("combo", `${mode}.${symbol}.${venues[0]}.${venues[1]}`);
    return url.href;
  }

  root.FundingRadarLinking = { normalizeSymbol, normalizeExchange, readCard, makeRadarUrl, readLimitCard, readBorrowCard, DEFAULT_RADAR_ORIGIN };
  if (typeof module !== "undefined") module.exports = root.FundingRadarLinking;
})(globalThis);
