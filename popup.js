const siteInput = document.querySelector("#site-url");
const radarInput = document.querySelector("#radar-url");
const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const button = form.querySelector("button");
const scopeInput = document.querySelector("#hl-scope");
function updateScope() { document.querySelector("#hl-coins-group").hidden = scopeInput.value === "all"; }
scopeInput.addEventListener("change", updateScope);
const fundingScope = document.querySelector("#funding-scope");
function updateFundingScope() { document.querySelector("#funding-coins-group").hidden = fundingScope.value === "all"; }
fundingScope.addEventListener("change", updateFundingScope);

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function parseOrigin(value) {
  const url = new URL(value.trim());
  if (!(["http:", "https:"].includes(url.protocol) && url.hostname)) {
    throw new Error("请输入 http 或 https 开头的站点地址。");
  }
  return url.origin;
}

async function applyToOpenTabs(origin, radarOrigin) {
  const url = new URL(origin);
  const tabs = await chrome.tabs.query({ url: `${url.protocol}//${url.hostname}/*` });
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    try {
      if (new URL(tab.url).origin !== origin) continue;
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["linking.js", "limits.js", "alerts.js", "risk-inline.js", "projection-inline.js", "content.js"] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: configuredOrigin => {
          document.querySelectorAll("a.funding-radar-link").forEach(link => {
            const path = "/radar/";
            const base = new URL(path, configuredOrigin);
            const current = new URL(link.href);
            base.search = current.search;
            link.href = base.href;
          });
        },
        args: [radarOrigin]
      });
    } catch (error) {
      console.warn("Could not update open dashboard tab", error);
    }
  }
}

chrome.storage.local.get(["siteOrigin", "radarOrigin", "hlAutoQuery", "hlReleaseAlert", "hlReleaseCoins", "fundingAutoQuery"]).then(({ siteOrigin, radarOrigin, hlAutoQuery, hlReleaseAlert, hlReleaseCoins, fundingAutoQuery }) => {
  siteInput.value = siteOrigin || "";
  radarInput.value = radarOrigin || "https://47.79.37.237";
  document.querySelector("#hl-release-alert").checked = hlReleaseAlert !== false;
  document.querySelector("#hl-release-coins").value = FundingRadarLimits.parseCoins(hlReleaseCoins).join(", ");
  const auto = FundingRadarLimits.settings(hlAutoQuery);
  scopeInput.value = auto.mode; updateScope();
  document.querySelector("#hl-auto").checked = auto.enabled;
  document.querySelector("#hl-interval").value = String(auto.interval);
  document.querySelector("#hl-coins").value = auto.coins.join(", ");
  const funding = FundingRadarLimits.settings(fundingAutoQuery);
  fundingScope.value = funding.mode; updateFundingScope();
  document.querySelector("#funding-auto").checked = funding.enabled;
  document.querySelector("#funding-interval").value = String(funding.interval);
  document.querySelector("#funding-coins").value = funding.coins.join(", ");
  if (siteOrigin) setStatus("已配置。修改地址后点击保存即可更新链接。");
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  button.disabled = true;
  setStatus("");
  try {
    const origin = parseOrigin(siteInput.value);
    const radarOrigin = parseOrigin(radarInput.value);
    const url = new URL(origin);
    const match = `${url.protocol}//${url.hostname}/*`;
    const granted = await chrome.permissions.request({ origins: [match] });
    if (!granted) {
      setStatus("需要允许访问这个看板站点，才能添加链接。", true);
      return;
    }
    const { siteOrigin: previousOrigin } = await chrome.storage.local.get("siteOrigin");
    const rawCoins = document.querySelector("#hl-coins").value;
    const hlAutoQuery = { enabled: document.querySelector("#hl-auto").checked,
      interval: Number(document.querySelector("#hl-interval").value), mode: scopeInput.value, coins: rawCoins };
    if (hlAutoQuery.enabled && hlAutoQuery.mode !== "all" && !FundingRadarLimits.settings(hlAutoQuery).coins.length) throw new Error("请填写自动查询的币种，例如 W, BTC");
    const fundingAutoQuery = { enabled: document.querySelector("#funding-auto").checked,
      interval: Number(document.querySelector("#funding-interval").value), mode: fundingScope.value, coins: document.querySelector("#funding-coins").value };
    if (fundingAutoQuery.enabled && fundingAutoQuery.mode !== "all" && !FundingRadarLimits.settings(fundingAutoQuery).coins.length) throw new Error("请填写自动计算的币种，例如 BLUR, BTC");
    await chrome.storage.local.set({ fundingAutoQuery, siteOrigin: origin, radarOrigin, hlAutoQuery, hlReleaseAlert: document.querySelector("#hl-release-alert").checked, hlReleaseCoins: document.querySelector("#hl-release-coins").value });
    const result = await chrome.runtime.sendMessage({ type: "sync-script" });
    if (!result?.ok) throw new Error(result?.error || "注册页面脚本失败");
    if (previousOrigin && previousOrigin !== origin) {
      const oldUrl = new URL(previousOrigin);
      await chrome.permissions.remove({ origins: [`${oldUrl.protocol}//${oldUrl.hostname}/*`] });
    }
    await applyToOpenTabs(origin, radarOrigin);
    siteInput.value = origin;
    radarInput.value = radarOrigin;
    setStatus("已启用。打开或刷新套利看板即可看到链接。");
  } catch (error) {
    setStatus(error instanceof TypeError ? "请输入完整站点地址，例如 https://dashboard.example.com" : String(error.message || error), true);
  } finally {
    button.disabled = false;
  }
});
