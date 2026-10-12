(function (root) {
  "use strict";
  function createNotifier(doc = document) {
    let notice, audio, soundTimer, batchTimer, closeTimer;
    let generation = 0;
    const pending = new Set();
    const animations = new Map();
    function stopAudio() {
      clearTimeout(soundTimer);
      if (audio) { audio.pause(); audio.removeAttribute("src"); audio.replaceChildren(); audio.load(); audio = undefined; }
    }
    function dismiss() {
      generation++;
      clearTimeout(closeTimer);
      stopAudio();
      notice?.remove(); notice = undefined;
    }
    async function play(message) {
      const token = ++generation;
      const source = doc.querySelector("audio#myAudio");
      const status = notice?.querySelector("[role=status]");
      const retry = notice?.querySelector(".funding-radar-alert-retry");
      clearTimeout(closeTimer);
      if (!source) {
        if (status) status.textContent = `${message} · 未找到页面报警声音`;
        if (retry) retry.hidden = false;
        return;
      }
      // Clone the page's actual warning sound, without pausing or seeking its own alarms.
      stopAudio();
      const clip = source.cloneNode(true);
      clip.removeAttribute("id");
      clip.loop = false;
      clip.volume = source.volume;
      clip.muted = source.muted;
      audio = clip;
      try {
        await clip.play();
        if (token !== generation) return;
        if (status) status.textContent = message;
        if (retry) retry.hidden = true;
        soundTimer = setTimeout(stopAudio, 8000);
        closeTimer = setTimeout(dismiss, 10000);
      } catch (_) {
        if (token !== generation) return;
        stopAudio();
        if (status) status.textContent = `${message} · 声音未播放，请点击播放提醒`;
        if (retry) retry.hidden = false;
      }
    }
    function show() {
      batchTimer = undefined;
      const symbols = [...pending]; pending.clear();
      if (!symbols.length || doc.hidden) return;
      dismiss();
      const message = `HL ${symbols.join("、")} 限制已解除 · 可`;
      notice = doc.createElement("div");
      notice.className = "funding-radar-alert-notice";
      const status = doc.createElement("span");
      status.setAttribute("role", "status"); status.textContent = message;
      const retry = doc.createElement("button");
      retry.type = "button"; retry.textContent = "播放提醒";
      retry.className = "funding-radar-alert-retry"; retry.hidden = true;
      retry.addEventListener("click", () => play(message));
      const close = doc.createElement("button");
      close.type = "button"; close.textContent = "关闭";
      close.addEventListener("click", dismiss);
      notice.append(status, retry, close); doc.body.append(notice);
      play(message);
    }
    function notify(symbol, cards) {
      if (doc.hidden || !cards.length) return;
      for (const card of cards) {
        clearTimeout(animations.get(card));
        card.classList.add("funding-radar-release-alert");
        animations.set(card, setTimeout(() => {
          card.classList.remove("funding-radar-release-alert"); animations.delete(card);
        }, 8000));
      }
      pending.add(symbol);
      if (batchTimer === undefined) batchTimer = setTimeout(show, 150);
    }
    function clear() {
      clearTimeout(batchTimer); batchTimer = undefined; pending.clear(); dismiss();
      for (const [card, timer] of animations) { clearTimeout(timer); card.classList.remove("funding-radar-release-alert"); }
      animations.clear();
    }
    return { notify, clear };
  }
  root.FundingRadarAlerts = { createNotifier };
  if (typeof module !== "undefined") module.exports = root.FundingRadarAlerts;
})(globalThis);
