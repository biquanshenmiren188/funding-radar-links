(function (root) {
  "use strict";
  const percent = n => Number.isFinite(n) ? `${n > 0 ? "+" : ""}${(n * 100).toFixed(4)}%` : "—";
  const estimate = r => r.kind === "official" ? `官 ${percent(r.predicted)}` : r.rangeOnly ? `${percent(r.lower)}～${percent(r.upper)}` : `≈${percent(r.predicted)}`;
  function compactRate(value) {
    if (!Number.isFinite(value)) return "算";
    const rounded = Number((value * 100).toFixed(3));
    return `${rounded < 0 ? "-" : "+"}${Math.abs(rounded).toFixed(3)}`;
  }
  function create({ linking, limits, send = m => chrome.runtime.sendMessage(m), now = Date.now }) {
    const results = new Map(), pending = new Map();
    let settings = limits.settings(), timer, expiryTimer, stopped = false, generation = 0;
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
          button.addEventListener("click", e => {
            e.stopPropagation(); e.preventDefault();
            const current = linking.readCard(card); if (!current || current.mode[i] !== "F") return;
            query(current, i); render(card);
          });
          leg.append(value, button); view.append(leg);
        }
        source.insertAdjacentElement("afterend", view);
      }
      const identity = `${d.symbol}:${d.mode}:${d.exchanges.join(":")}`;
      if (view.dataset.identity !== identity) { delete view.dataset.openLeg; view.dataset.identity = identity; }
      [...view.querySelectorAll(".funding-radar-projection-leg")].forEach((leg, i) => {
        text(leg.querySelector(".funding-radar-projection-index"), values[i]);
        const button = leg.querySelector("button");
        leg.querySelector(".funding-radar-projection-result")?.remove();
        const r = results.get(key(d, i)), busy = pending.has(key(d, i));
        button.hidden = d.mode[i] !== "F"; button.disabled = busy;
        button.setAttribute("aria-label", `算 ${d.exchanges[i]} ${d.symbol} ${i === 0 ? "左" : "右"}合约结算费率`);
        button.title = describe(r, d, i);
        button.setAttribute("aria-description", button.title);
        button.setAttribute("aria-busy", String(busy));
        text(button, busy ? "…" : fresh(r) ? compactRate(r.predicted) : "算");
      });
      card.querySelector(".funding-radar-projection-detail")?.remove();
    }
    function renderAll() { if (!stopped) cards().forEach(render); }
    async function query(d, i) {
      const k = key(d, i); if (pending.has(k) || stopped || d.mode[i] !== "F") return;
      const task = Promise.resolve().then(() => send({ type: "funding-projection", exchange: d.exchanges[i], symbol: d.symbol }));
      pending.set(k, task); renderAll();
      try { results.set(k, await task); }
      catch (_) { results.set(k, { ok: false, error: "查询失败，请刷新看板后重试" }); }
      finally { pending.delete(k); if (!stopped) renderAll(); }
    }
    function schedule(immediate = false) {
      clearTimeout(timer);
      const token = ++generation;
      if (stopped || !settings.enabled || document.hidden || (settings.mode !== "all" && !settings.coins.length)) return;
      timer = setTimeout(async () => {
        const tasks = new Map();
        cards().forEach(card => {
          const d = linking.readCard(card); if (!d || (settings.mode !== "all" && !settings.coins.includes(d.symbol.toUpperCase()))) return;
          for (let i = 0; i < 2; i++) if (d.mode[i] === "F") tasks.set(key(d, i), [d, i]);
        });
        // Bound concurrent card work; the worker additionally serializes requests per venue.
        const queue = [...tasks.values()];
        await Promise.all([0, 1].map(async () => {
          while (queue.length && token === generation && !stopped && settings.enabled && !document.hidden) {
            const [d, i] = queue.shift();
            if (settings.mode === "all" || settings.coins.includes(d.symbol.toUpperCase())) await query(d, i);
          }
        }));
        if (token === generation) schedule();
      }, immediate ? 0 : settings.interval * 1000);
    }
    return { render, configure(value) { settings = limits.settings(value); schedule(true); },
      visibilityChanged() { renderAll(); schedule(true); },
      start(value) { stopped = false; settings = limits.settings(value); renderAll(); schedule(true); expiryTimer = setInterval(renderAll, 5000); },
      stop() { stopped = true; clearTimeout(timer); clearInterval(expiryTimer); results.clear();
        document.querySelectorAll(".funding-radar-projection, .funding-radar-projection-detail").forEach(el => el.remove());
        document.querySelectorAll(".funding-radar-index-source").forEach(el => el.classList.remove("funding-radar-index-source")); }
    };
  }
  root.FundingRadarProjectionInline = { create };
  if (typeof module !== "undefined") module.exports = root.FundingRadarProjectionInline;
})(globalThis);
