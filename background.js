importScripts("limits.js");
const queryLimit = FundingRadarLimits.createClient();
const SCRIPT_ID = "funding-radar-links";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "open-borrow-calculator") return;
  (async () => {
    const { siteOrigin } = await chrome.storage.local.get("siteOrigin");
    if (!sender.tab || !siteOrigin || new URL(sender.url).origin !== siteOrigin) throw new Error("来源未授权");
    if (!["binance", "bitget"].includes(message.exchange) || typeof message.symbol !== "string" || !message.symbol.trim() || message.symbol.length > 60) throw new Error("无效的卡片参数");
    const hash = new URLSearchParams({ exchange: message.exchange, symbol: message.symbol });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`liquidation.html#${hash}`) });
    return { ok: true };
  })().then(sendResponse, () => sendResponse({ ok: false }));
  return true;
});

async function syncScript() {
  const { siteOrigin } = await chrome.storage.local.get("siteOrigin");
  const registered = await chrome.scripting.getRegisteredContentScripts();
  if (registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: registered.map(script => script.id) });
  }
  if (!siteOrigin) return;

  const url = new URL(siteOrigin);
  const match = `${url.protocol}//${url.hostname}/*`;
  if (!(await chrome.permissions.contains({ origins: [match] }))) return;

  await chrome.scripting.registerContentScripts([{
    id: SCRIPT_ID,
    matches: [match],
    js: ["linking.js", "limits.js", "alerts.js", "content.js"],
    css: ["content.css"],
    runAt: "document_idle",
    persistAcrossSessions: true
  }]);
}

chrome.runtime.onInstalled.addListener(() => { syncScript().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { syncScript().catch(console.error); });
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sync-script") return;
  syncScript().then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: String(error) }));
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "hl-limit-query") return;
  (async () => {
    const { siteOrigin } = await chrome.storage.local.get("siteOrigin");
    if (!sender.tab || !siteOrigin || new URL(sender.url).origin !== siteOrigin) {
      throw new Error("查询来源未授权");
    }
    return queryLimit(message.symbol);
  })().then(sendResponse, () => sendResponse({ state: "unknown", reason: "无法查询，请刷新看板或重新保存插件设置", checkedAt: Date.now() }));
  return true;
});
