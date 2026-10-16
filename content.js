(function () {
  "use strict";
  if (globalThis.__fundingRadarLinksStarted) return;
  globalThis.__fundingRadarLinksStarted = true;

  const linking = globalThis.FundingRadarLinking;
  const pending = new Set();
  const indexPending = new Set();
  const limits = globalThis.FundingRadarLimits;
  const results = new Map();
  const manualLimits = new Map();
  const limitFlights = new Map();
  const released = limits.createReleaseTracker();
  const notifier = globalThis.FundingRadarAlerts.createNotifier();
  let releaseAlert = true;
  let releaseCoins = [];
  const expiries = new Map();
  let autoSettings = limits.settings();
  let autoTimer;
  let stopped = false;

  function renderAll() { document.querySelectorAll(".ant-card").forEach(queue); }
  function limitEnabled(symbol) {
    const key = symbol.toUpperCase();
    return manualLimits.has(key) ? manualLimits.get(key)
      : autoSettings.enabled && (autoSettings.mode === "all" || autoSettings.coins.includes(key));
  }
  function stopSymbol(key) {
    limitFlights.delete(key); // Invalidate late responses, including a stop/start race.
    results.delete(key);
    clearTimeout(expiries.get(key)); expiries.delete(key);
    released.reset(key);
  }
  function toggleLimit(symbol) {
    const key = symbol.toUpperCase();
    const enabled = !limitEnabled(key);
    manualLimits.set(key, enabled);
    if (enabled) querySymbol(key);
    else { stopSymbol(key); notifier.clear(); }
    renderAll();
    if (!autoTimer) scheduleAuto();
  }
  async function querySymbol(symbol) {
    const key = symbol.toUpperCase();
    if (limitFlights.has(key) || stopped || !limitEnabled(key)) return;
    const token = {};
    limitFlights.set(key, token);
    clearTimeout(expiries.get(key));
    results.set(key, { state: "loading", reason: "正在查询 HL 公共持仓上限" });
    renderAll();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "hl-limit-query", symbol });
      if (!["open", "restricted", "unknown"].includes(result?.state) || !Number.isFinite(result.checkedAt)) throw new Error("查询未返回有效结果");
    } catch (_) {
      result = { state: "unknown", reason: "查询失败，请刷新页面后重试", checkedAt: Date.now() };
    }
    if (stopped || limitFlights.get(key) !== token || !limitEnabled(key)) return;
    limitFlights.delete(key);
    results.set(key, result);
    // A response arriving after the tab hides must not consume a release notification.
    if (!document.hidden || result.state !== "open") {
      const shouldAlert = released(key, result);
      if (shouldAlert && releaseAlert && releaseCoins.includes(key)) {
        const cards = [...document.querySelectorAll(".ant-card")].filter(card =>
          linking.readLimitCard(card)?.symbol.toUpperCase() === key);
        notifier.notify(symbol, cards);
      }
    }
    expiries.set(key, setTimeout(renderAll, Math.max(0, result.checkedAt + limits.FRESH_MS - Date.now()) + 50));
    renderAll();
  }
  function scheduleAuto(immediate = false) {
    clearTimeout(autoTimer); autoTimer = undefined;
    if (stopped || document.hidden || (!autoSettings.enabled && ![...manualLimits.values()].some(Boolean))) return;
    if (autoSettings.mode !== "all" && !autoSettings.coins.length && ![...manualLimits.values()].some(Boolean)) return;
    autoTimer = setTimeout(() => {
      autoTimer = undefined;
      const symbols = new Set();
      document.querySelectorAll(".ant-card").forEach(card => {
        const details = linking.readLimitCard(card);
        if (details && limitEnabled(details.symbol)) symbols.add(details.symbol);
      });
      for (const symbol of symbols) querySymbol(symbol);
      scheduleAuto();
    }, immediate ? 0 : autoSettings.interval * 1000);
  }
  function visibilityChanged() { if (document.hidden) notifier.clear(); risk.visibilityChanged(); projection?.visibilityChanged(); renderAll(); scheduleAuto(true); }

  function updateLimit(card, details) {
    // Remove the previous title button and detached badges; retain one control per HL contract tag.
    card.querySelectorAll(".funding-radar-limit-status").forEach(el => el.remove());
    card.querySelectorAll(".funding-radar-limit-button").forEach(el => {
      if (!details?.hlTags.includes(el.previousElementSibling)) el.remove();
    });
    if (!details) return;
    const key = details.symbol.toUpperCase();
    const active = limitEnabled(key);
    const result = active ? results.get(key) : null;
    const fresh = result && Number.isFinite(result.checkedAt) && Date.now() - result.checkedAt < limits.FRESH_MS;
    const state = fresh && ["open", "restricted"].includes(result.state) ? result.state : "idle";
    const label = { open: "可", restricted: "限", idle: "查" }[state];
    for (const tag of details.hlTags) {
      let button = tag.nextElementSibling;
      if (!button?.classList.contains("funding-radar-limit-button")) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "funding-radar-link funding-radar-limit-button";
        button.addEventListener("click", event => {
          event.preventDefault(); event.stopPropagation();
          const current = linking.readLimitCard(card);
          if (current?.hlTags.includes(button.previousElementSibling)) toggleLimit(current.symbol);
        });
        tag.insertAdjacentElement("afterend", button);
      }
      if (button.textContent !== label) button.textContent = label;
      button.dataset.state = state;
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-busy", String(active && limitFlights.has(key)));
      button.setAttribute("aria-label", `${active ? "停止" : "开启"} ${details.symbol} HL 自动限仓查询${state !== "idle" ? "，当前" + label : ""}`);
      const time = fresh ? new Date(result.checkedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "";
      const status = !active ? "点击立即查询并开启自动刷新" : limitFlights.has(key) ? "正在查询，点击停止"
        : fresh && state !== "idle" ? `${result.reason} · 查询 ${time}；点击停止`
        : `${result?.reason || "结果已过期"}；自动查询已开启，点击停止`;
      button.title = `${details.symbol}：${status}（间隔 ${autoSettings.interval} 秒）`;
    }
  }

  let radarOrigin = linking.DEFAULT_RADAR_ORIGIN;
  let observer;
  let frame;
  let storageListener;

  const risk = globalThis.FundingRadarInlineRisk.create({ linking });
  const projection = globalThis.FundingRadarProjectionInline?.create({ linking, limits });
  function updateBorrow(card) { risk.render(card); }

  function updateCard(card) {
    projection?.render(card);
    const details = linking.readCard(card);
    const limitDetails = linking.readLimitCard(card);
    const borrowDetails = linking.readBorrowCard(card);
    const oldLink = card.querySelector("a.funding-radar-link");
    if (!details && !limitDetails && !borrowDetails) {
      oldLink?.remove();
      updateLimit(card, null);
      updateBorrow(card, null);
      card.querySelector(".funding-radar-header")?.classList.remove("funding-radar-header");
      return;
    }

    let link = null;
    if (details) {
      const href = linking.makeRadarUrl(details, radarOrigin);
      link = oldLink || document.createElement("a");
      if (!oldLink) {
        link.className = "funding-radar-link";
        link.textContent = "探";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      link.title = `在资金费雷达查看 ${details.symbol}（${details.mode} · ${details.exchanges.join(" / ")}）`;
      link.setAttribute("aria-label", `探：${link.title}`);
      if (link.href !== href) link.href = href;
      if (link.previousElementSibling !== details.nameElement || link.parentElement !== details.nameElement.parentElement) {
        details.nameElement.insertAdjacentElement("afterend", link);
      }
    } else oldLink?.remove();
    updateLimit(card, limitDetails);
    updateBorrow(card, borrowDetails, link || borrowDetails?.nameElement);
    const nameElement = (details || limitDetails || borrowDetails).nameElement;
    if (!nameElement.title) nameElement.title = nameElement.textContent.trim();
    if (!nameElement.parentElement.classList.contains("funding-radar-header")) {
      nameElement.parentElement.classList.add("funding-radar-header");
    }
  }

  function flush() {
    frame = undefined;
    let count = 0;
    const identitiesChanged = pending.size > 0;
    for (const card of pending) {
      pending.delete(card); indexPending.delete(card);
      if (card.isConnected) updateCard(card);
      if (++count >= 12) break;
    }
    for (const card of indexPending) {
      if (count >= 24) break;
      indexPending.delete(card);
      if (card.isConnected) projection?.updateIndex(card);
      count++;
    }
    if (identitiesChanged && !pending.size && (manualLimits.size || limitFlights.size || results.size)) {
      const present = new Set([...document.querySelectorAll(".ant-card")].map(card => linking.readLimitCard(card)?.symbol.toUpperCase()).filter(Boolean));
      for (const key of new Set([...manualLimits.keys(), ...limitFlights.keys(), ...results.keys()])) {
        if (!present.has(key)) { stopSymbol(key); manualLimits.delete(key); }
      }
    }
    if (pending.size || indexPending.size) frame = requestAnimationFrame(flush);
  }

  function queue(card) {
    pending.add(card);
    if (frame === undefined) frame = requestAnimationFrame(flush);
  }

  function queueFrom(node) {
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node) return;
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    // Price/position text changes do not change the destination. Observe only card identity changes.
    if (node.closest(".funding-radar-link, .funding-radar-limit-status, .funding-radar-alert-notice, .funding-radar-risk, .funding-radar-risk-detail, .funding-radar-projection, .funding-radar-projection-detail")) return;
    const row = node.closest("p");
    if (row && !/^(交易所|仓位数量|实时指数)\s*[:：]/.test(row.textContent.trim()) && !row.classList.contains("mmr-row")) return;
    if (projection && row && /^实时指数\s*[:：]/.test(row.textContent.trim())) {
      const card = row.closest(".ant-card");
      if (card && !pending.has(card)) {
        indexPending.add(card);
        if (frame === undefined) frame = requestAnimationFrame(flush);
      }
      return;
    }
    if (node.matches(".ant-card")) queue(node);
    else {
      const card = node.closest(".ant-card");
      if (card) queue(card);
      else node.querySelectorAll(".ant-card").forEach(queue);
    }
  }

  function stop() {
    stopped = true;
    risk.stop();
    projection?.stop();
    notifier.clear();
    clearTimeout(autoTimer);
    expiries.forEach(timer => clearTimeout(timer));
    results.clear();
    manualLimits.clear(); limitFlights.clear();
    document.removeEventListener("visibilitychange", visibilityChanged);
    observer?.disconnect();
    if (storageListener) chrome.storage.onChanged.removeListener(storageListener);
    if (frame !== undefined) cancelAnimationFrame(frame);
    pending.clear();
    indexPending.clear();
    document.querySelectorAll(".funding-radar-link, .funding-radar-limit-status").forEach(link => link.remove());
    document.querySelectorAll(".funding-radar-header").forEach(header => header.classList.remove("funding-radar-header"));
    globalThis.__fundingRadarLinksStarted = false;
  }

  chrome.storage.local.get(["siteOrigin", "radarOrigin", "hlAutoQuery", "hlReleaseAlert", "hlReleaseCoins", "fundingAutoQuery"]).then(({ siteOrigin, radarOrigin: savedRadarOrigin, hlAutoQuery, hlReleaseAlert, hlReleaseCoins, fundingAutoQuery }) => {
    if (location.origin !== siteOrigin) {
      stop();
      return;
    }
    releaseAlert = hlReleaseAlert !== false;
    releaseCoins = limits.parseCoins(hlReleaseCoins);
    autoSettings = limits.settings(hlAutoQuery);
    document.addEventListener("visibilitychange", visibilityChanged);
    scheduleAuto(true);
    risk.start();
    projection?.start(fundingAutoQuery);
    radarOrigin = savedRadarOrigin || linking.DEFAULT_RADAR_ORIGIN;
    document.querySelectorAll(".ant-card").forEach(queue);
    observer = new MutationObserver(records => {
      for (const record of records) {
        queueFrom(record.target);
        for (const node of record.addedNodes) queueFrom(node);
        for (const node of record.removedNodes || []) {
          if (node.nodeType === Node.ELEMENT_NODE && (node.matches(".ant-card") || node.querySelector(".ant-card"))) queueFrom(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    storageListener = (changes, area) => {
      if (area !== "local") return;
      if (changes.siteOrigin && changes.siteOrigin.newValue !== location.origin) {
        stop();
        return;
      }
      if (changes.hlReleaseCoins) { releaseCoins = limits.parseCoins(changes.hlReleaseCoins.newValue); notifier.clear(); }
      if (changes.hlReleaseAlert) { releaseAlert = changes.hlReleaseAlert.newValue !== false; if (!releaseAlert) notifier.clear(); }
      if (changes.fundingAutoQuery) projection?.configure(changes.fundingAutoQuery.newValue);
      if (changes.hlAutoQuery) {
        autoSettings = limits.settings(changes.hlAutoQuery.newValue);
        for (const key of new Set([...results.keys(), ...limitFlights.keys()])) if (!limitEnabled(key)) stopSymbol(key);
        renderAll(); scheduleAuto(true);
      }
      if (changes.radarOrigin) {
        radarOrigin = changes.radarOrigin.newValue || linking.DEFAULT_RADAR_ORIGIN;
        document.querySelectorAll(".ant-card").forEach(updateCard);
      }
    };
    chrome.storage.onChanged.addListener(storageListener);
  }).catch(error => {
    console.error("Funding Radar Links failed to start", error);
    stop();
  });
})();
