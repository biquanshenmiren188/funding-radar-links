(function () {
  "use strict";
  if (globalThis.__fundingRadarLinksStarted) return;
  globalThis.__fundingRadarLinksStarted = true;

  const linking = globalThis.FundingRadarLinking;
  const pending = new Set();
  const limits = globalThis.FundingRadarLimits;
  const results = new Map();
  const released = limits.createReleaseTracker();
  const notifier = globalThis.FundingRadarAlerts.createNotifier();
  let releaseAlert = true;
  let releaseCoins = [];
  const expiries = new Map();
  let autoSettings = limits.settings();
  let autoTimer;
  let stopped = false;

  function renderAll() { document.querySelectorAll(".ant-card").forEach(queue); }
  async function querySymbol(symbol) {
    const key = symbol.toUpperCase();
    if (results.get(key)?.state === "loading" || stopped) return;
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
    if (stopped) return;
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
    clearTimeout(autoTimer);
    if (stopped || !autoSettings.enabled || (autoSettings.mode !== "all" && !autoSettings.coins.length) || document.hidden) return;
    autoTimer = setTimeout(() => {
      const symbols = new Set();
      document.querySelectorAll(".ant-card").forEach(card => {
        const details = linking.readLimitCard(card);
        if (details && (autoSettings.mode === "all" || autoSettings.coins.includes(details.symbol.toUpperCase()))) symbols.add(details.symbol);
      });
      for (const symbol of symbols) querySymbol(symbol);
      scheduleAuto();
    }, immediate ? 0 : autoSettings.interval * 1000);
  }
  function visibilityChanged() { if (document.hidden) notifier.clear(); renderAll(); scheduleAuto(true); }

  function updateLimit(card, details, anchor) {
    let button = card.querySelector(".funding-radar-limit-button");
    if (!details) {
      button?.remove();
      card.querySelectorAll(".funding-radar-limit-status").forEach(el => el.remove());
      return;
    }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "funding-radar-link funding-radar-limit-button";
      button.textContent = "查";
      button.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        const current = linking.readLimitCard(card);
        if (current) querySymbol(current.symbol);
      });
    }
    button.title = `查询 ${details.symbol} 的 HL 公共开仓限制`;
    button.setAttribute("aria-label", `查询 ${details.symbol} Hyperliquid 限额`);
    if (button.previousElementSibling !== anchor) anchor.insertAdjacentElement("afterend", button);
    const result = results.get(details.symbol.toUpperCase());
    button.disabled = result?.state === "loading";
    if (result?.state === "unknown") button.title = `${details.symbol} 暂无有效查询结果，点击重试`;
    card.querySelectorAll(".funding-radar-limit-status").forEach(el => {
      if (!details.hlTags.includes(el.previousElementSibling)) el.remove();
    });
    for (const tag of details.hlTags) {
      let badge = tag.nextElementSibling;
      if (!badge?.classList.contains("funding-radar-limit-status")) badge = null;
      if (!result || result.state === "unknown") { badge?.remove(); continue; }
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "funding-radar-limit-status";
        badge.setAttribute("role", "status");
        badge.setAttribute("aria-live", "polite");
        tag.insertAdjacentElement("afterend", badge);
      }
      const stale = result.checkedAt && Date.now() - result.checkedAt >= limits.FRESH_MS;
      const state = stale ? "stale" : result.state;
      const label = { open: "可", restricted: "限", loading: "查询中", stale: "待查" }[state];
      if (badge.textContent !== label) badge.textContent = label;
      badge.dataset.state = state;
      const time = result.checkedAt ? new Date(result.checkedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "";
      badge.title = stale ? `${time} 的结果已过期，请重新查询` : `${result.reason}${time ? " · 查询 " + time : ""}`;
      badge.setAttribute("aria-label", `${details.symbol} ${label}：${badge.title}`);
    }
  }

  let radarOrigin = linking.DEFAULT_RADAR_ORIGIN;
  let observer;
  let frame;
  let storageListener;

  function updateBorrow(card, details, anchor) {
    let button = card.querySelector(".funding-radar-borrow-button");
    if (!details) { button?.remove(); return; }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "funding-radar-link funding-radar-borrow-button";
      button.textContent = "爆仓估算";
      button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        const current = linking.readBorrowCard(card);
        if (!current) return;
        try {
          const response = await chrome.runtime.sendMessage({ type: "open-borrow-calculator", exchange: current.exchange, symbol: current.symbol });
          if (!response?.ok) throw new Error("未能打开");
        } catch (_) { button.textContent = "刷新后重试"; }
      });
    }
    button.title = `估算借 ${details.exchange.toUpperCase()} ${details.symbol} 的统一账户上涨风险线`;
    button.setAttribute("aria-label", button.title);
    if (button.previousElementSibling !== anchor) anchor.insertAdjacentElement("afterend", button);
  }

  function updateCard(card) {
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
        link.textContent = "雷达↗";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      link.title = `在资金费雷达查看 ${details.symbol}（${details.mode} · ${details.exchanges.join(" / ")}）`;
      if (link.href !== href) link.href = href;
      if (link.previousElementSibling !== details.nameElement || link.parentElement !== details.nameElement.parentElement) {
        details.nameElement.insertAdjacentElement("afterend", link);
      }
    } else oldLink?.remove();
    updateLimit(card, limitDetails, link || limitDetails?.nameElement);
    updateBorrow(card, borrowDetails, card.querySelector(".funding-radar-limit-button") || link || borrowDetails?.nameElement);
    const nameElement = (details || limitDetails || borrowDetails).nameElement;
    if (!nameElement.title) nameElement.title = nameElement.textContent.trim();
    if (!nameElement.parentElement.classList.contains("funding-radar-header")) {
      nameElement.parentElement.classList.add("funding-radar-header");
    }
  }

  function flush() {
    frame = undefined;
    for (const card of pending) {
      if (card.isConnected) updateCard(card);
    }
    pending.clear();
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
    if (node.closest(".funding-radar-link, .funding-radar-limit-status, .funding-radar-alert-notice")) return;
    const row = node.closest("p");
    if (row && !/^交易所\s*[:：]/.test(row.textContent.trim())) return;
    if (node.matches(".ant-card")) queue(node);
    else {
      const card = node.closest(".ant-card");
      if (card) queue(card);
      else node.querySelectorAll(".ant-card").forEach(queue);
    }
  }

  function stop() {
    stopped = true;
    notifier.clear();
    clearTimeout(autoTimer);
    expiries.forEach(timer => clearTimeout(timer));
    results.clear();
    document.removeEventListener("visibilitychange", visibilityChanged);
    observer?.disconnect();
    if (storageListener) chrome.storage.onChanged.removeListener(storageListener);
    if (frame !== undefined) cancelAnimationFrame(frame);
    pending.clear();
    document.querySelectorAll(".funding-radar-link, .funding-radar-limit-status").forEach(link => link.remove());
    document.querySelectorAll(".funding-radar-header").forEach(header => header.classList.remove("funding-radar-header"));
    globalThis.__fundingRadarLinksStarted = false;
  }

  chrome.storage.local.get(["siteOrigin", "radarOrigin", "hlAutoQuery", "hlReleaseAlert", "hlReleaseCoins"]).then(({ siteOrigin, radarOrigin: savedRadarOrigin, hlAutoQuery, hlReleaseAlert, hlReleaseCoins }) => {
    if (location.origin !== siteOrigin) {
      stop();
      return;
    }
    releaseAlert = hlReleaseAlert !== false;
    releaseCoins = limits.parseCoins(hlReleaseCoins);
    autoSettings = limits.settings(hlAutoQuery);
    document.addEventListener("visibilitychange", visibilityChanged);
    scheduleAuto(true);
    radarOrigin = savedRadarOrigin || linking.DEFAULT_RADAR_ORIGIN;
    document.querySelectorAll(".ant-card").forEach(queue);
    observer = new MutationObserver(records => {
      for (const record of records) {
        queueFrom(record.target);
        for (const node of record.addedNodes) queueFrom(node);
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
      if (changes.hlAutoQuery) { autoSettings = limits.settings(changes.hlAutoQuery.newValue); scheduleAuto(true); }
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
