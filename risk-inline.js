(function (root) {
  "use strict";
  function describe(row, error) {
    const assumptions = "单币上涨，其余币及 BTC 抵押品价格不变；显示保证金近似权益，FS 卖出量近似借款，维保按持仓市值分摊。未核实抵押折扣、完整负债和动态档位，并非交易所确认的爆仓价。";
    if (error || row?.error) return { label: "—", state: "unknown", detail: error || row.error };
    if (!row) return { label: "—", state: "unknown", detail: "未找到匹配的全仓借币持仓" };
    if (row.weighted?.state === "already") return { label: "0%", state: "danger", detail: `上涨空间粗估：当前近似权益已到参考风险线。${assumptions}` };
    if (row.weighted?.state === "none") return { label: "—", state: "unknown", detail: `此假设下未算出上涨风险交点，不代表不会爆仓。${assumptions}` };
    const multiple = row.weighted?.multiple;
    if (!Number.isFinite(multiple) || multiple < 1) return { label: "—", state: "unknown", detail: "数据不足，无法计算" };
    const percent = Math.round((multiple - 1) * 100);
    return { label: `${percent.toFixed(0)}%`, state: Number(percent.toFixed(0)) <= 100 ? "danger" : "space", detail: `上涨空间粗估：借 ${row.exchange.toUpperCase()} ${row.symbol} 再涨 ${percent.toFixed(0)}% 达到参考风险线。≤100% 标红，>100% 标绿；绿色仅表示估算空间较大。同账户同币持仓合并计算，其他交易所盈利不抵扣。${assumptions}` };
  }
  function create({ linking }) {
    let running = false, busy = false, timer, generation = 0, attempted = 0, report = null, error = "正在读取账户";
    const cards = () => [...document.querySelectorAll(".ant-card")];
    function remove(card) {
      card.querySelectorAll(".funding-radar-borrow-button, .funding-radar-risk, .funding-radar-risk-detail").forEach(el => el.remove());
      card.querySelector(".funding-radar-risk-row")?.classList.remove("funding-radar-risk-row");
    }
    function render(card) {
      const details = linking.readBorrowCard(card), row = card.querySelector(".mmr-row");
      if (!running || !details || !row) { remove(card); return; }
      card.querySelector(".funding-radar-borrow-button")?.remove();
      let wrap = card.querySelector(".funding-radar-risk");
      if (wrap && wrap.parentElement !== row) { remove(card); wrap = null; }
      if (!wrap) {
        wrap = document.createElement("span"); wrap.className = "funding-radar-risk";
        const button = document.createElement("button"); button.type = "button";
        button.setAttribute("aria-expanded", "false");
        button.addEventListener("click", event => {
          event.preventDefault(); event.stopPropagation();
          let detail = card.querySelector(".funding-radar-risk-detail");
          if (detail) { detail.remove(); button.setAttribute("aria-expanded", "false"); return; }
          detail = document.createElement("div"); detail.className = "funding-radar-risk-detail";
          detail.textContent = button.title;
          row.insertAdjacentElement("afterend", detail);
          button.setAttribute("aria-expanded", "true");
        });
        wrap.append(button); row.append(wrap);
      }
      if (!row.classList.contains("funding-radar-risk-row")) row.classList.add("funding-radar-risk-row");
      const fresh = report && Date.now() - report.capturedAt <= 60000;
      const result = report?.rows.find(r => r.exchange === details.exchange && r.symbol === details.symbol);
      const view = describe(result, error);
      // Keep the last value through visibility changes, without presenting it as live.
      const previous = report && !fresh;
      if (previous) view.state = "unknown";
      const button = wrap.firstElementChild;
      if (button.textContent !== view.label) button.textContent = view.label;
      if (button.dataset.state !== view.state) button.dataset.state = view.state;
      const status = previous ? "上次结果，已过期，等待更新。" : "";
      const title = status + view.detail + (report ? ` 读取 ${new Date(report.capturedAt).toLocaleTimeString("zh-CN", { hour12: false })}，每 30 秒自动更新。` : "");
      if (button.title !== title) { button.title = title; button.setAttribute("aria-label", `${status}上涨空间粗估 ${view.label}，点击查看估算口径`); }
      const detail = card.querySelector(".funding-radar-risk-detail");
      if (detail && detail.textContent !== title) detail.textContent = title;
      if (!busy && Date.now() - attempted >= 30000) schedule(0);
    }
    function renderAll() { cards().forEach(render); }
    function schedule(delay) {
      clearTimeout(timer);
      if (running) timer = setTimeout(read, delay);
    }
    async function read() {
      if (!running || busy) return;
      if (!cards().some(card => linking.readBorrowCard(card) && card.querySelector(".mmr-row"))) { schedule(30000); return; }
      busy = true; attempted = Date.now(); const token = generation;
      renderAll();
      try {
        const response = await chrome.runtime.sendMessage({ type: "read-frontend-risk" });
        if (token !== generation || !running) return;
        if (!response?.ok || !Array.isArray(response.report?.rows) || !Number.isFinite(response.report.capturedAt) || Date.now() - response.report.capturedAt > 60000 || response.report.capturedAt > Date.now() + 5000) throw new Error(response?.error || "读取失败，旧结果已弃用");
        report = response.report; error = null;
      } catch (e) {
        if (token === generation) { report = null; error = e.message || "读取失败"; }
      } finally {
        busy = false;
        if (running) { renderAll(); schedule(Math.max(0, 30000 - (Date.now() - attempted))); }
      }
    }
    return {
      render,
      start() { running = true; schedule(0); },
      visibilityChanged() { renderAll(); if (!busy && Date.now() - attempted >= 30000) schedule(0); },
      stop() { running = false; generation++; report = null; clearTimeout(timer); cards().forEach(remove); }
    };
  }
  root.FundingRadarInlineRisk = { create, describe };
  if (typeof module !== "undefined") module.exports = root.FundingRadarInlineRisk;
})(globalThis);
