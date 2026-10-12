(function () {
  "use strict";
  if (globalThis.__fundingRadarLinksStarted) return;
  globalThis.__fundingRadarLinksStarted = true;

  const linking = globalThis.FundingRadarLinking;
  const pending = new Set();
  let radarOrigin = linking.DEFAULT_RADAR_ORIGIN;
  let observer;
  let frame;
  let storageListener;

  function updateCard(card) {
    const details = linking.readCard(card);
    const oldLink = card.querySelector(".funding-radar-link");
    if (!details) {
      oldLink?.remove();
      card.querySelector(".funding-radar-header")?.classList.remove("funding-radar-header");
      return;
    }

    const href = linking.makeRadarUrl(details, radarOrigin);
    const link = oldLink || document.createElement("a");
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
    if (!details.nameElement.title) details.nameElement.title = details.nameElement.textContent.trim();
    if (!details.nameElement.parentElement.classList.contains("funding-radar-header")) {
      details.nameElement.parentElement.classList.add("funding-radar-header");
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
    observer?.disconnect();
    if (storageListener) chrome.storage.onChanged.removeListener(storageListener);
    if (frame !== undefined) cancelAnimationFrame(frame);
    pending.clear();
    document.querySelectorAll(".funding-radar-link").forEach(link => link.remove());
    document.querySelectorAll(".funding-radar-header").forEach(header => header.classList.remove("funding-radar-header"));
    globalThis.__fundingRadarLinksStarted = false;
  }

  chrome.storage.local.get(["siteOrigin", "radarOrigin"]).then(({ siteOrigin, radarOrigin: savedRadarOrigin }) => {
    if (location.origin !== siteOrigin) {
      stop();
      return;
    }
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
