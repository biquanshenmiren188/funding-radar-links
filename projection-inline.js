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
      failed(k) { due.set(k, now() + Math.max(config.interval, 30) * 1000); },
      configure(next) { config = next; due.clear(); },
      clear() { overrides.clear(); due.clear(); revisions.clear(); }
    };
  }
  function create({ linking, limits, send = m => chrome.runtime.sendMessage(m), now = Date.now }) {
    const results = new Map(), pending = new Map();
    const views = new Map(), markets = new Map();
    const polling = createPolling(now);
    let settings = limits.fundingSettings(), timer, expiryTimer, stopped = false;
    let sequence = 0;
    const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
    function cancel(k) {
      const entry = pending.get(k);
      if (!entry) return;
      pending.delete(k);
      void Promise.resolve().then(() => send({ type: "funding-projection-cancel", requestId: entry.id })).catch(() => {});
    }
    function progressMessage(message) {
      if (message?.type !== "funding-projection-progress" || stopped) return;
      for (const [k, entry] of pending) if (entry.id === message.requestId) {
        entry.progress = message.progress;
        const result = message.progress?.result;
        if (result?.ok && result.kind === "current-only" &&
            result.exchange + ":" + result.symbol === k && polling.active(k, result.symbol)) results.set(k, result);
        renderMarket(k); break;
      }
    }
    const messages = root.chrome?.runtime?.onMessage;
    function cards() { return [...document.querySelectorAll(".ant-card")]; }
    function key(d, i) { return d.exchanges[i] + ":" + d.symbol.toUpperCase(); }
    function fresh(r) { return r?.ok && now() - r.checkedAt < 120000 && now() < r.end &&
      (r.kind !== "current-only" || (Number.isFinite(r.validUntil) && now() < r.validUntil)); }
    function text(node, value) { if (node.textContent !== value) node.textContent = value; }
    function attr(node, name, value) { if (node.getAttribute(name) !== value) node.setAttribute(name, value); }
    function property(node, name, value) { if (node[name] !== value) node[name] = value; }
    function forget(card) {
      const old = views.get(card);
      if (!old) return;
      for (const k of old.keys) {
        const group = markets.get(k);
        group?.delete(card);
        if (!group?.size) { markets.delete(k); results.delete(k); cancel(k); }
      }
      views.delete(card);
    }
    function remember(card, d) {
      const identity = `${d.symbol}:${d.mode}:${d.exchanges.join(":")}`;
      let state = views.get(card);
      if (state?.identity === identity) { state.d = d; return state; }
      forget(card);
      state = { d, identity, keys: [...new Set(d.exchanges.map((_, i) => d.mode[i] === "F" ? key(d, i) : null).filter(Boolean))] };
      views.set(card, state);
      for (const k of state.keys) {
        if (!markets.has(k)) markets.set(k, new Set());
        markets.get(k).add(card);
      }
      return state;
    }
    function describe(r, d, i) {
      if (!r?.ok) return r?.error || "点击计算下一次结算费率";
      if (!fresh(r)) return "估算已过期，点击重新计算";
      if (r.kind === "official") return `${d.exchanges[i].toUpperCase()} ${d.symbol} · ${r.hours}h\n官方预估 ${percent(r.predicted)}\n结算 ${new Date(r.end).toLocaleString("zh-CN", { hour12: false })}\n${r.method}\n${r.assumption}`;
      if (r.kind === "current-only") return `${d.exchanges[i].toUpperCase()} ${d.symbol} · ${r.hours}h\n当前指数估算 ${percent(r.predicted)}\n历史数据等待超过 30 秒，仅按当前溢价指数估算\n当前溢价指数 ${percent(r.currentPremium)}\n指数时间 ${new Date(r.premiumAt).toLocaleTimeString("zh-CN", { hour12: false })}\n结算 ${new Date(r.end).toLocaleString("zh-CN", { hour12: false })}\n假设整期溢价均为当前水平，未计入真实历史累计。历史恢复后自动切回正常预测。`;
      return `${d.exchanges[i].toUpperCase()} ${d.symbol} · ${r.hours}h\n情景估算 ${estimate(r)}${r.samplingError > 0 ? `\n历史采样保守范围 ${percent(r.lower)}～${percent(r.upper)}（并非已测得误差，不含未来行情变化）` : ""}\n官方当前 ${percent(r.officialRate)}\n完整分钟末次溢价 ${percent(r.currentPremium)}\n预计周期均值 ${percent(r.average)}\n结算 ${new Date(r.end).toLocaleString("zh-CN", { hour12: false })}\n历史 ${r.observedMinutes}/${r.totalMinutes} 分钟${Number.isFinite(r.dataAsOf) ? `\n数据截止 ${new Date(r.dataAsOf).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}${Number.isFinite(r.futureWeightRatio) ? `\n剩余外推权重 ${(r.futureWeightRatio * 100).toFixed(1)}%` : ""}\n${r.method}\n${r.assumption}\n查询 ${new Date(r.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}`;
    }
    function render(card) {
      const d = linking.readCard(card);
      if (!d) forget(card);
      const state = d && remember(card, d);
      const row = [...card.querySelectorAll("p")].find(p => /^实时指数\s*[:：]/.test(p.textContent.trim()));
      let view = row?.querySelector(".funding-radar-projection");
      const source = row && [...row.children].find(el => el.tagName === "SPAN" && !el.classList.contains("funding-radar-projection"));
      const values = source?.textContent.split("|").map(v => v.trim());
      if (!d || !row || !source || values?.length !== 2) {
        if (state) { state.view = null; state.legs = null; }
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
            if (!polling.active(k, current.symbol)) { results.delete(k); cancel(k); }
            renderMarket(k);
            // Manual starts enter the worker immediately, so its total deadline
            // includes the exchange request queue instead of an unbounded UI wait.
            if (current.exchanges[i] !== "hyperliquid" && polling.active(k, current.symbol)) void query(current, i);
            tick();
          });
          leg.append(value, result, button); view.append(leg);
        }
        source.insertAdjacentElement("afterend", view);
      }
      const identity = state.identity;
      if (view.dataset.identity !== identity) { delete view.dataset.openLeg; view.dataset.identity = identity; }
      if (state.view !== view) {
        state.view = view;
        state.legs = [...view.querySelectorAll(".funding-radar-projection-leg")].map(leg => ({
          value: leg.querySelector(".funding-radar-projection-index"), button: leg.querySelector("button"),
          output: leg.querySelector(".funding-radar-projection-result")
        }));
      }
      state.source = source;
      paint(state, values);
      card.querySelector(".funding-radar-projection-detail")?.remove();
    }
    function paint(state, values) {
      if (!state.legs) return;
      const d = state.d;
      state.legs.forEach((leg, i) => {
        if (values) text(leg.value, values[i]);
        const { button, output } = leg;
        const r = results.get(key(d, i)), entry = pending.get(key(d, i)), busy = !!entry;
        const progress = entry?.progress;
        const running = polling.active(key(d, i), d.symbol);
        const isFresh = fresh(r);
        const signature = `${running}:${busy}:${isFresh}:${settings.interval}`;
        // Price ticks do not change funding results or their expensive date-formatted tooltips.
        if (leg.signature === signature && leg.result === r && leg.progress === progress) return;
        leg.signature = signature; leg.result = r; leg.progress = progress;
        property(button, "hidden", d.mode[i] !== "F"); property(button, "disabled", false);
        attr(button, "aria-label", `${running ? "停" : "算"} ${d.exchanges[i]} ${d.symbol} ${i === 0 ? "左" : "右"}合约结算费率`);
        attr(button, "aria-pressed", String(running));
        const lag = r?.historyLagMinutes > 0 ? `\n完整历史延迟 ${r.historyLagMinutes} 分钟；延迟部分按末次完整溢价外推` : "";
        const timing = r?.diagnostics ? `\n本轮用时 ${(r.diagnostics.elapsedMs / 1000).toFixed(1)} 秒；接口 ${r.diagnostics.requests.length} 次；排队 ${(r.diagnostics.requests.reduce((n, v) => n + v.queueMs, 0) / 1000).toFixed(1)} 秒` : "";
        const description = describe(r, d, i) + lag + timing;
        const stage = { queued: "排队中", request: "请求接口", history: "补历史中", "history-wait": "等待历史恢复", repair: "补查缺口", retry: "重试中", received: "计算中", cache: "读取缓存", "current-only": "当前指数估算，继续补历史" }[progress?.stage] || "查询中";
        property(button, "title", (running ? `点击停止，每 ${settings.interval} 秒计算一次` : "点击开始自动计算") + (busy ? ` · ${stage}${progress?.endpoint ? "\n" + progress.endpoint : ""}` : "") + "\n" + description);
        attr(button, "aria-description", button.title);
        attr(button, "aria-busy", String(busy));
        text(button, running ? "停" : "算");
        property(output, "hidden", d.mode[i] !== "F" || !running || !isFresh);
        text(output, running && isFresh ? compactRate(r.predicted) : "");
        attr(output, "data-estimate-kind", running && isFresh && r.kind === "current-only" ? "current-only" : "normal");
        property(output, "title", description);
        attr(output, "aria-label", description);
      });
    }
    function updateIndex(card) {
      const state = views.get(card);
      if (!state?.source?.isConnected || !state.view?.isConnected) { render(card); return; }
      const values = state.source.textContent.split("|").map(v => v.trim());
      if (values.length !== 2) { render(card); return; }
      paint(state, values);
    }
    function renderMarket(k) {
      if (stopped || document.hidden) return;
      for (const card of markets.get(k) || []) {
        if (card.isConnected === false) forget(card);
        else paint(views.get(card));
      }
    }
    function renderAll() {
      if (stopped || document.hidden) return;
      for (const [card, state] of views) {
        if (card.isConnected === false) forget(card);
        else paint(state);
      }
    }
    async function query(d, i) {
      const k = key(d, i); if (pending.has(k) || stopped || d.mode[i] !== "F") return;
      const revision = polling.revision(k);
      polling.requested(k);
      const entry = { id: session + "-" + ++sequence };
      const task = Promise.resolve().then(() => pending.get(k) === entry ? send({ type: "funding-projection", requestId: entry.id, exchange: d.exchanges[i], symbol: d.symbol }) : null);
      pending.set(k, entry); renderMarket(k);
      try { const result = await task; if (!stopped && pending.get(k) === entry && revision === polling.revision(k)) { results.set(k, result); if (!result?.ok) polling.failed(k); } }
      catch (_) { if (!stopped && pending.get(k) === entry && revision === polling.revision(k)) { results.set(k, { ok: false, error: "查询失败，下次自动重试" }); polling.failed(k); } }
      finally { if (pending.get(k) === entry) pending.delete(k); if (!stopped) { renderMarket(k); tick(); } }
    }
    function tick() {
      if (stopped || document.hidden) return;
      const tasks = new Map();
      for (const [card, state] of views) {
        if (card.isConnected === false) { forget(card); continue; }
        const d = state.d;
        for (let i = 0; i < 2; i++) if (d.mode[i] === "F") tasks.set(key(d, i), [d, i]);
      }
      for (const [k, [d, i]] of [...tasks].sort(([a], [b]) => polling.dueAt(a) - polling.dueAt(b))) {
        if (pending.size >= 4) break;
        // A slow exchange must not occupy every slot; requests to the same
        // exchange already share a serial, rate-limited lane in the worker.
        if ([...pending.keys()].some(p => p.startsWith(d.exchanges[i] + ":"))) continue;
        if (!pending.has(k) && polling.ready(k, d.symbol)) void query(d, i);
      }
    }
    return { render, updateIndex, configure(value) { settings = limits.fundingSettings(value); polling.configure(settings);
      for (const k of pending.keys()) if (!polling.active(k, k.slice(k.indexOf(":") + 1))) cancel(k);
      renderAll(); tick(); },
      visibilityChanged() { renderAll(); tick(); },
      start(value) { stopped = false; messages?.removeListener(progressMessage); messages?.addListener(progressMessage); settings = limits.fundingSettings(value); polling.configure(settings); cards().forEach(render); tick(); clearInterval(timer); timer = setInterval(tick, 1000); clearInterval(expiryTimer); expiryTimer = setInterval(renderAll, 5000); },
      stop() { stopped = true; clearInterval(timer); clearInterval(expiryTimer); results.clear(); polling.clear();
        messages?.removeListener(progressMessage); for (const k of pending.keys()) cancel(k);
        views.clear(); markets.clear();
        document.querySelectorAll(".funding-radar-projection, .funding-radar-projection-detail").forEach(el => el.remove());
        document.querySelectorAll(".funding-radar-index-source").forEach(el => el.classList.remove("funding-radar-index-source")); }
    };
  }
  root.FundingRadarProjectionInline = { create, createPolling, compactRate };
  if (typeof module !== "undefined") module.exports = root.FundingRadarProjectionInline;
})(globalThis);
