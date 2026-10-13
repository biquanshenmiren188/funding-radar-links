(function (root) {
  "use strict";
  // Fixed-tier, single-coin upward stress. E and M are ACCOUNT totals, not card totals.
  const thresholds = { binance: 1.05, bitget: 1 };
  function number(value, label, min = 0, max = Infinity) {
    if (value === null || value === undefined || String(value).trim() === "") throw new Error(`请填写${label}`);
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label}超出有效范围`);
    return n;
  }
  function model(input) {
    if (!Object.hasOwn(thresholds, input.exchange)) throw new Error("仅支持币安 Portfolio Margin 或 Bitget UTA");
    const equity = number(input.equity, "账户调整后权益", Number.MIN_VALUE);
    const maintenance = number(input.maintenance, "账户总维持保证金");
    const price = number(input.price, "当前标记价格", Number.MIN_VALUE);
    const debt = number(input.debt, "该币净负债市值");
    const borrowed = number(input.borrowed, "计提维持保证金的借款市值");
    const borrowRate = number(input.borrowRate, "借款维持保证金率", 0, 100) / 100;
    // Net liability can differ from gross borrowing (held coins, interest and account rules).
    const same = input.hedge === "same";
    if (!["same", "elsewhere"].includes(input.hedge)) throw new Error("请选择合约所在账户");
    const hedge = same ? number(input.hedgeNotional, "同账户合约净名义价值", -Infinity) : 0;
    const riskNotional = same ? number(input.riskNotional, "合约维保计提名义价值") : 0;
    const futuresRate = same ? number(input.futuresRate, "合约维持保证金率", 0, 100) / 100 : 0;
    const credit = same ? number(input.credit, "合约盈亏权益折算比例", 0, 100) / 100 : 0;
    if (riskNotional < Math.abs(hedge)) throw new Error("合约维保计提名义价值不能小于净名义价值的绝对值");
    const equitySlope = -debt + hedge * credit;
    // Cumulative tier deductions belong in M0; they are NOT multiplied by price.
    const maintenanceSlope = borrowed * borrowRate + riskNotional * futuresRate;
    const bound = input.tierBound === "" || input.tierBound == null ? null : number(input.tierBound, "有效档位价格倍数上限", 1);
    const software = input.software === "" || input.software == null ? null : number(input.software, "软件减仓 MMR 阈值", Number.MIN_VALUE, 100) / 100;
    const values = [equitySlope, maintenanceSlope, equity, maintenance, price];
    if (values.some(n => !Number.isFinite(n))) throw new Error("数值过大，无法可靠计算");
    return { exchange: input.exchange, equity, maintenance, price, equitySlope, maintenanceSlope, bound, software };
  }
  function at(m, multiple) {
    const k = number(multiple, "价格倍数", 1);
    const equity = m.equity + m.equitySlope * (k - 1);
    const maintenance = m.maintenance + m.maintenanceSlope * (k - 1);
    const risk = equity > 0 ? maintenance / equity : Infinity;
    if (![equity, maintenance, m.price * k].every(Number.isFinite)) throw new Error("压力情景数值过大");
    return { multiple: k, price: m.price * k, equity, maintenance, risk,
      triggered: equity <= thresholds[m.exchange] * maintenance,
      outsideTier: k > 1 && (m.bound === null || k > m.bound) };
  }
  function crossing(m, equityPerMaintenance) {
    const buffer = m.equity - equityPerMaintenance * m.maintenance;
    if (buffer <= 0) return { state: "already", multiple: 1, price: m.price };
    const loss = equityPerMaintenance * m.maintenanceSlope - m.equitySlope;
    if (loss <= 0) return { state: "none", multiple: null, price: null };
    const multiple = 1 + buffer / loss;
    const price = m.price * multiple;
    if (!Number.isFinite(multiple) || !Number.isFinite(price)) throw new Error("结果超出可计算范围");
    return { state: "crossing", multiple, price, outsideTier: m.bound === null || multiple > m.bound };
  }
  function calculate(input) {
    const m = model(input);
    return { model: m, current: at(m, 1), exchange: crossing(m, thresholds[m.exchange]),
      software: m.software ? crossing(m, 1 / m.software) : null };
  }
  root.FundingRadarLiquidation = { model, at, crossing, calculate, thresholds };
  if (typeof module !== "undefined") module.exports = root.FundingRadarLiquidation;
})(globalThis);
