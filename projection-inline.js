(function (root) {
  "use strict";
  const percent = n => Number.isFinite(n) ? `${n > 0 ? "+" : ""}${(n * 100).toFixed(4)}%` : "—";
  const estimate = r => r.kind === "official" ? `官 ${percent(r.predicted)}` : r.rangeOnly ? `${percent(r.lower)}～${percent(r.upper)}` : `≈${percent(r.predicted)}`;
  function compactRate(value) {
    if (!Number.isFinite(value)) return "算";
    const rounded = Number((value * 100).toFixed(3));
    return `${rounded < 0 ? "-" : "+"}${Math.abs(rounded).toFixed(3)}`;
  }
  // Per-market overrides ensure a stopped card stays stopped even in automatic scopes.
  function createPolling(now = Date.now) {
    const overrides = new Map(), due = new Map(), revisions = new Map();
    let config = { startMode: "manual", interval: 30, coins: [] };
    const active = (k, symbol) => overrides.has(k) ? overrides.get(k)
      : config.startMode === "all" || (config.startMode === "selected" && config.coins.includes(symbol.toUpperCase()));
    return {
      active,
      toggle(k, symbol) { overrides.set(k, !active(k, symbol)); due.delete(k); revisions.set(k, (revisions.get(k) || 0) + 1); },
      revision: k => revisions.get(k) || 0,
      ready: (k, symbol) => active(k, symbol) && now() >= (due.get(k) || 0),
      dueAt: k => due.get(k) || 0,
      requested(k) { due.set(k, now() + config.interval * 1000); },
      configure(next) { config = next; due.clear(); },
      clear() { overrides.clear(); due.clear(); revisions.clear(); }
    };
  }
  function create({ linking, limits, send = m => chrome.runtime.sendMessage(m), now = Date.now }) {
    const results = new Map(), pending = new Map();
    const polling = createPolling(now);
    let settings = limits.fundingSettings(), timer, expiryTimer, stopped = false;
    function cards() { return [...document.querySelectorAll(".ant-card")]; }
    function key(d, i) { return d.exchanges[i] + ":" + d.symbol.toUpperCase(); }
    function fresh(r) { return r?.ok && now() - r.checkedAt < 120000 && now() < r.end; }
    function text(node, value) { if (node.textContent !== value) node.textContent = value; }
    function describe(r, d, i) {
      if (!r?.ok) return r?.error || "点击计算下一次结算费率";
      if (!fresh(r)) return "估算已过期，点击重新计算";
      if (r.kind === "official") return `${d.exchanges[i].toUpperCase()} ${d.symbol} · ${r.hours}h\n官方预估 ${percent(r.predicted)}\n结算 ${new Date(r.end).toLocaleString("zh-CN", { hour12: false })}\n${r.method}\n${r.assumption}`;
      return `${d.exchanges[i].toUpperCase()} ${d.symbol} · ${r.hours}h\n预计结算 ${estimate(r)}${r.samplingError > 0 ? `\n采样区间 ${percent(r.lower)}～${percent(r.upper)}（仅历史采样误差，不含未来行情变化）` : ""}\n官方当前 ${percent(r.officialRate)}\n最新溢价 ${percent(r.currentPremium)}\n预计周期均值 ${percent(r.average)}\n结算 ${new Date(r.end).toLocaleString("zh-CN", { hour12: false })}\n历史 ${r.observedMinutes}/${r.totalMinutes} 分钟，余下按最新溢价推算\n${r.method}\n${r.assumption}\n查询 ${new Date(r.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}`;
    }
    function render(card) {
      const d = linking.readCard(card);
      const row = [...card.querySelectorAll("p")].find(p => /^实时指数\s*[:：]/.test(p.textContent.trim()));
      let view = row?.querySelector(".funding-radar-projection");
      const source = row && [...row.children].find(el => el.tagName === "SPAN" && !el.classList.contains("funding-radar-projection"));
      const values = source?.textContent.split("|").map(v => v.trim());
      if (!d || !row || !source || values?.length !== 2) {
        card.querySelectorAll(".funding-radar-projection, .funding-radar-projection-detail").forEach(el => el.remove());
        card.querySelectorAll(".funding-radar-index-source").forEach(el => el.classList.remove("funding-radar-index-source"));
        return;
      }
      if (!source.classList.contains("funding-radar-index-source")) source.classList.add("funding-radar-index-source");
      if (!view) {
        view = document.createElement("span"); view.className = "funding-radar-projection";
        for (let i = 0; i < 2; i++) {
          if (i) view.append(document.createTextNode(" | "));
          const leg = document.createElement("span"); leg.className = "funding-radar-projection-leg";
          const value = document.createElement("span"); value.className = "funding-radar-projection-index";
          const button = document.createElement("button"); button.type = "button"; button.textContent = "算";
          button.className = "funding-radar-projection-button";
          const result = document.createElement("span"); result.className = "funding-radar-projection-result";
          button.addEventListener("click", e => {
            e.stopPropagation(); e.preventDefault();
            const current = linking.readCard(card); if (!current || current.mode[i] !== "F") return;
            const k = key(current, i);
            polling.toggle(k, current.symbol);
            if (!polling.active(k, current.symbol)) results.delete(k);
            renderAll(); tick();
          });
          leg.append(value, result, button); view.append(leg);
        }
        source.insertAdjacentElement("afterend", view);
      }
      const identity = `${d.symbol}:${d.mode}:${d.exchanges.join(":")}`;
      if (view.dataset.identity !== identity) { delete view.dataset.openLeg; view.dataset.identity = identity; }
      [...view.querySelectorAll(".funding-radar-projection-leg")].forEach((leg, i) => {
        text(leg.querySelector(".funding-radar-projection-index"), values[i]);
        const button = leg.querySelector("button");
        const output = leg.querySelector(".funding-radar-projection-result");
        const r = results.get(key(d, i)), busy = pending.has(key(d, i));
        const running = polling.active(key(d, i), d.symbol);
        button.hidden = d.mode[i] !== "F"; button.disabled = false;
        button.setAttribute("aria-label", `${running ? "停" : "算"} ${d.exchanges[i]} ${d.symbol} ${i === 0 ? "左" : "右"}合约结算费率`);
        button.setAttribute("aria-pressed", String(running));
        button.title = (running ? `点击停止，每 ${settings.interval} 秒计算一次` : "点击开始自动计算") + (busy ? " · 查询中" : "") + "\n" + describe(r, d, i);
        button.setAttribute("aria-description", button.title);
        button.setAttribute("aria-busy", String(busy));
        text(button, running ? "停" : "算");
        output.hidden = d.mode[i] !== "F" || !running || !fresh(r);
        text(output, running && fresh(r) ? compactRate(r.predicted) : "");
        output.title = describe(r, d, i);
      });
      card.querySelector(".funding-radar-projection-detail")?.remove();
    }
    function renderAll() { if (!stopped) cards().forEach(render); }
    async function query(d, i) {
      const k = key(d, i); if (pending.has(k) || stopped || d.mode[i] !== "F") return;
      const revision = polling.revision(k);
      polling.requested(k);
      const task = Promise.resolve().then(() => send({ type: "funding-projection", exchange: d.exchanges[i], symbol: d.symbol }));
      pending.set(k, task); renderAll();
      try { const result = await task; if (!stopped && revision === polling.revision(k)) results.set(k, result); }
      catch (_) { if (!stopped && revision === polling.revision(k)) results.set(k, { ok: false, error: "查询失败，下次自动重试" }); }
      finally { pending.delete(k); if (!stopped) renderAll(); }
    }
    function tick() {
      if (stopped || document.hidden) return;
      const tasks = new Map();
      cards().forEach(card => {
        const d = linking.readCard(card); if (!d) return;
        for (let i = 0; i < 2; i++) if (d.mode[i] === "F") tasks.set(key(d, i), [d, i]);
      });
      for (const [k, [d, i]] of [...tasks].sort(([a], [b]) => polling.dueAt(a) - polling.dueAt(b))) {
        if (pending.size >= 2) break;
        if (!pending.has(k) && polling.ready(k, d.symbol)) void query(d, i);
      }
    }
    return { render, configure(value) { settings = limits.fundingSettings(value); polling.configure(settings); renderAll(); tick(); },
      visibilityChanged() { renderAll(); tick(); },
      start(value) { stopped = false; settings = limits.fundingSettings(value); polling.configure(settings); renderAll(); tick(); clearInterval(timer); timer = setInterval(tick, 1000); clearInterval(expiryTimer); expiryTimer = setInterval(renderAll, 5000); },
      stop() { stopped = true; clearInterval(timer); clearInterval(expiryTimer); results.clear(); polling.clear();
        document.querySelectorAll(".funding-radar-projection, .funding-radar-projection-detail").forEach(el => el.remove());
        document.querySelectorAll(".funding-radar-index-source").forEach(el => el.classList.remove("funding-radar-index-source")); }
    };
  }
  root.FundingRadarProjectionInline = { create, createPolling, compactRate };
  if (typeof module !== "undefined") module.exports = root.FundingRadarProjectionInline;
})(globalThis);
