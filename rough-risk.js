(function (root) {
  "use strict";
  const finite = v => (typeof v === "number" || typeof v === "string") && String(v).trim() !== "" && Number.isFinite(Number(v));
  const positive = v => finite(v) && Number(v) > 0;
  function crossing(equity, maintenance, equitySlope, maintenanceSlope, threshold) {
    const buffer = equity - threshold * maintenance;
    if (buffer <= 0) return { state: "already", multiple: 1 };
    const slope = threshold * maintenanceSlope - equitySlope;
    if (slope <= 0) return { state: "none", multiple: null };
    const multiple = 1 + buffer / slope;
    return Number.isFinite(multiple) ? { state: "estimated", multiple } : { state: "missing", multiple: null };
  }
  function analyze(snapshot, now = Date.now()) {
    if (!snapshot || !Array.isArray(snapshot.pairs) || !finite(snapshot.capturedAt) ||
      now - snapshot.capturedAt > 60000 || snapshot.capturedAt > now + 5000) throw new Error("账户快照已过期，请重新读取");
    const rows = [];
    for (const ex of ["binance", "bitget"]) {
      const loans = new Map(), seen = new Set();
      let ambiguous = false;
      for (const p of snapshot.pairs) {
        if (p.type !== "FS" || p.spotMarginType !== "cross" || p.sellEx !== ex) continue;
        if (!finite(p.bExPosition) || Number(p.bExPosition) < 0 || typeof p.name !== "string" || !p.name || !p.id) { ambiguous = true; continue; }
        if (seen.has(p.id)) { ambiguous = true; continue; }
        seen.add(p.id);
        if (Number(p.bExPosition) === 0) continue;
        const old = loans.get(p.name) || { quantity: 0, cost: 0, hasCost: true };
        old.quantity += Number(p.bExPosition);
        if (positive(p.avgOpenBExPrice)) old.cost += Number(p.avgOpenBExPrice) * Number(p.bExPosition);
        else old.hasCost = false;
        loans.set(p.name, old);
      }
      if (!loans.size) continue;
      const account = snapshot.accounts?.[ex];
      let error = ambiguous ? "卡片数量或身份不完整，不能汇总" : account?.error;
      if (!account || !positive(account.displayedMargin) || !positive(account.mmr)) error ||= "缺少有效的实时保证金或 MMR";
      if (!account?.future || Array.isArray(account.future) || !account?.spot || Array.isArray(account.spot)) error ||= "账户持仓数据不完整";
      const exposures = new Map();
      const get = symbol => { if (!exposures.has(symbol)) exposures.set(symbol, { long: 0, short: 0, loan: 0 }); return exposures.get(symbol); };
      for (const [symbol, loan] of loans) get(symbol).loan = loan.quantity;
      for (const [key, value] of Object.entries(account?.future || {})) {
        if (/-PRICE$|-MARGIN_MODE$/.test(key)) continue;
        const match = /^(.*)-(LONG|SHORT)$/.exec(key);
        if (!match || !finite(value) || Number(value) < 0) { error ||= "存在未识别的合约持仓，无法分配维保"; continue; }
        get(match[1])[match[2] === "LONG" ? "long" : "short"] += Number(value);
      }
      let totalWeight = 0;
      for (const [symbol, exposure] of exposures) {
        const gross = exposure.long + exposure.short + exposure.loan;
        if (!gross) continue;
        if (!positive(account?.prices?.[symbol])) { error ||= `缺少 ${symbol} 当前价格`; continue; }
        exposure.price = Number(account.prices[symbol]);
        exposure.weight = gross * exposure.price;
        totalWeight += exposure.weight;
      }
      if (!positive(totalWeight)) error ||= "缺少账户持仓市值";
      for (const [symbol, loan] of loans) {
        const result = { exchange: ex, symbol, quantity: loan.quantity, error,
          displayedMargin: Number(account?.displayedMargin), mmr: Number(account?.mmr) };
        // BTC collateral moves with BTC itself; fixing its collateral price would be inconsistent.
        if (["BTC", "USDT"].includes(symbol.toUpperCase())) result.error ||= "该币同时是抵押资产，固定抵押价格假设不适用";
        if (result.error) { rows.push(result); continue; }
        const e = exposures.get(symbol), price = e.price;
        const held = account.spot[symbol] === undefined ? 0 : account.spot[symbol];
        if (!finite(held) || Number(held) < 0) { result.error = "现货余额口径异常，无法估算净敞口"; rows.push(result); continue; }
        // Frontend approximation: displayed margin is a proxy for adjusted equity,
        // FS sold quantity is a proxy for borrowing, and positive same-coin holdings offset it.
        const equity = result.displayedMargin, maintenance = equity * result.mmr;
        const equitySlope = (e.long - e.short - loan.quantity + Number(held)) * price;
        const share = e.weight / totalWeight;
        const threshold = ex === "binance" ? 1.05 : 1;
        Object.assign(result, { price, averageEntry: loan.hasCost ? loan.cost / loan.quantity : null,
          currentNotional: loan.quantity * price, equitySlope, maintenance, share,
          weighted: crossing(equity, maintenance, equitySlope, maintenance * share, threshold),
          fixed: crossing(equity, maintenance, equitySlope, 0, threshold),
          all: crossing(equity, maintenance, equitySlope, maintenance, threshold) });
        if (![price, maintenance, equitySlope, result.currentNotional, share].every(Number.isFinite)) result.error = "数据超出可计算范围";
        rows.push(result);
      }
    }
    return { capturedAt: snapshot.capturedAt, rows };
  }
  root.FundingRadarRoughRisk = { analyze, crossing };
  if (typeof module !== "undefined") module.exports = root.FundingRadarRoughRisk;
})(globalThis);
