importScripts("limits.js", "astro-reader.js", "rough-risk.js");
const queryLimit = FundingRadarLimits.createClient();
const SCRIPT_ID = "funding-radar-links";
const riskReads = new Map();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "read-frontend-risk") return;
  (async () => {
    const { siteOrigin } = await chrome.storage.local.get("siteOrigin");
    if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 ||
        !siteOrigin || new URL(sender.url).origin !== siteOrigin) throw new Error("来源未授权");
    const tabId = sender.tab.id;
    const key = `${tabId}:${siteOrigin}`;
    if (!riskReads.has(key)) {
      const pending = (async () => {
        const result = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN", func: readAstroRiskSnapshot, args: [siteOrigin] });
        const value = result[0]?.result;
        if (!value || !Array.isArray(value.pairs) || !value.accounts) throw new Error("读取失败：请刷新看板；软件升级后可能需要重新适配");
        return { ok: true, report: FundingRadarRoughRisk.analyze(value) };
      })();
      riskReads.set(key, pending);
      pending.then(() => riskReads.delete(key), () => riskReads.delete(key));
    }
    return riskReads.get(key);
  })().then(sendResponse, () => sendResponse({ ok: false, error: "读取失败或软件版本不匹配，请刷新看板后重试" }));
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
    js: ["linking.js", "limits.js", "alerts.js", "risk-inline.js", "content.js"],
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
