"use strict";
const form = document.querySelector("#calculator");
const field = name => form.elements.namedItem(name);
const text = (id, value) => { document.getElementById(id).textContent = value; };
const fmt = n => Number.isFinite(n) ? n.toLocaleString("zh-CN", { minimumFractionDigits: 4, maximumFractionDigits: 4 }) : "—";
const priceFmt = n => n > 0 && n < 0.0001 ? n.toPrecision(6) : fmt(n);
const seed = new URLSearchParams(location.hash.slice(1));
if (["binance", "bitget"].includes(seed.get("exchange"))) field("exchange").value = seed.get("exchange");
if (seed.get("symbol")) field("symbol").value = seed.get("symbol").slice(0, 60);
if (seed.has("exchange")) text("context", `来自 FS 卡片 · 借 ${field("exchange").value.toUpperCase()} ${field("symbol").value}。仅带入币种和平台；卡片仓位不是账户总负债，请补齐账户数据。`);
function syncHedge() {
  const same = field("hedge").value === "same";
  document.querySelector("#hedge-fields").hidden = !same;
  for (const name of ["hedgeNotional", "riskNotional", "futuresRate", "credit"]) {
    field(name).required = same;
    field(name).disabled = !same;
  }
}
function invalidate() {
  document.querySelector("#result-content").hidden = true;
  document.querySelector("#empty").hidden = false;
  text("empty", "数据已更改，请重新计算。旧结果已清除。");
  text("error", "");
}
form.addEventListener("input", invalidate);
form.addEventListener("change", () => { syncHedge(); invalidate(); });
form.addEventListener("invalid", invalidate, true);
form.addEventListener("reset", () => {
  queueMicrotask(() => { syncHedge(); invalidate(); text("context", "输入已清空。请使用同一时刻、同一账户的完整数据。"); });
});
syncHedge();

function metric(label, value) {
  const dt = document.createElement("dt"); dt.textContent = label;
  const dd = document.createElement("dd"); dd.textContent = value;
  document.querySelector("#metrics").append(dt, dd);
}
function boundaryText(result) {
  if (result.state === "already") return "当前已达到该风险线";
  if (result.state === "none") return "该假设下未找到上涨触发点";
  return `涨至当前 ${fmt(result.multiple)} 倍`;
}
form.addEventListener("submit", event => {
  event.preventDefault();
  invalidate();
  try {
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    if (!field("assumptions").checked) throw new Error("请确认估算条件");
    const result = FundingRadarLiquidation.calculate(values);
    const { model, current, exchange, software } = result;
    const scenarios = [1, 1.5, 2, 3, 5].map(k => FundingRadarLiquidation.at(model, k));
    const venue = values.exchange === "binance" ? "BINANCE Portfolio Margin" : "BITGET UTA";
    text("result-label", `${venue} · ${values.symbol} · 交易所首个风险边界（估算）`);
    text("main-result", boundaryText(exchange));
    text("price-result", exchange.state === "crossing" ? `即再上涨 ${fmt((exchange.multiple - 1) * 100)}% · 对应价格 ${priceFmt(exchange.price)} U` : exchange.state === "none" ? "不代表不会爆仓：其他币波动、档位变化或后续费用仍会改变风险。" : "请核对同一时刻的权益与维保数据；这里不是交易所实时强平判定。");
    text("confidence", model.bound === null ? "档位范围未核实：结果为固定档位数学外推，不能当作已核实的爆仓价格。" : exchange.state === "crossing" && exchange.outsideTier ? `计算触发点超过已填的 ${fmt(model.bound)} 倍档位上限。必须更新档位，不能据此判断还能涨到该价格。` : "结果仅在填写的档位与折扣范围内适用；持仓、费用和其他币种价格变化后需重算。");
    document.querySelector("#metrics").replaceChildren();
    metric("当前 M/E（越高越危险）", `${fmt(current.risk * 100)}%`);
    if (values.exchange === "binance") metric("对应币安 uniMMR（E/M）", current.maintenance === 0 ? "无维保 · 无有限比值" : `${fmt(current.equity / current.maintenance * 100)}%`);
    metric("交易所风险边界 M/E", `${fmt(100 / FundingRadarLiquidation.thresholds[values.exchange])}%`);
    metric("该币价格翻倍的权益变化", `${fmt(model.equitySlope)} U`);
    metric("该币价格翻倍的维保增加", `${fmt(model.maintenanceSlope)} U`);
    text("software-result", software ? `${boundaryText(software)}${software.state === "crossing" ? `（再涨 ${fmt((software.multiple - 1) * 100)}%）` : ""}。软件 MMR 阈值 ${fmt(model.software * 100)}%；使用相同的固定档位假设。` : "未填写软件减仓阈值；不使用默认值替你推断设置。");
    const tbody = document.querySelector("#scenarios"); tbody.replaceChildren();
    for (const row of scenarios) {
      const tr = document.createElement("tr"); if (row.triggered) tr.className = "danger";
      for (const value of [`${fmt(row.multiple)}×`, `${fmt(row.equity)} U`, row.equity <= 0 ? "权益≤0" : `${fmt(row.risk * 100)}%`, `${row.triggered ? "已触及" : "未触及"}${row.outsideTier ? " · 外推" : ""}`]) {
        const td = document.createElement("td"); td.textContent = value; tr.append(td);
      }
      tbody.append(tr);
    }
    document.querySelector("#empty").hidden = true;
    document.querySelector("#result-content").hidden = false;
    if (matchMedia("(max-width: 800px)").matches) document.querySelector("#results").scrollIntoView({ behavior: "auto", block: "start" });
  } catch (error) { text("error", error.message); }
});
document.querySelector("#example").addEventListener("click", () => {
  const example = { exchange: "bitget", symbol: "DEMO", price: "1", equity: "10000", maintenance: "1000", debt: "5000", borrowed: "5000", borrowRate: "10", hedge: "elsewhere", software: "50", tierBound: "" };
  for (const [key, value] of Object.entries(example)) field(key).value = value;
  for (const name of ["hedgeNotional", "riskNotional", "futuresRate", "credit"]) field(name).value = "";
  field("assumptions").checked = true;
  syncHedge();
  text("context", "虚拟示例：全部为演示数字，10% 是假设借款维保率，不是此平台或币种的实际费率。");
  form.requestSubmit();
});
