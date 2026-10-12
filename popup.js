const siteInput = document.querySelector("#site-url");
const radarInput = document.querySelector("#radar-url");
const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const button = form.querySelector("button");

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
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["linking.js", "limits.js", "content.js"] });
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

chrome.storage.local.get(["siteOrigin", "radarOrigin", "hlAutoQuery"]).then(({ siteOrigin, radarOrigin, hlAutoQuery }) => {
  siteInput.value = siteOrigin || "";
  radarInput.value = radarOrigin || "https://47.79.37.237";
  const auto = FundingRadarLimits.settings(hlAutoQuery);
  document.querySelector("#hl-auto").checked = auto.enabled;
  document.querySelector("#hl-interval").value = String(auto.interval);
  document.querySelector("#hl-coins").value = auto.coins.join(", ");
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
      interval: Number(document.querySelector("#hl-interval").value), coins: rawCoins };
    if (hlAutoQuery.enabled && !FundingRadarLimits.settings(hlAutoQuery).coins.length) throw new Error("请填写自动查询的币种，例如 W, BTC");
    await chrome.storage.local.set({ siteOrigin: origin, radarOrigin, hlAutoQuery });
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
