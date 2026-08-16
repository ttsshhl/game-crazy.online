/*!
 * Рекламный адаптер. Один интерфейс — разные сети.
 * provider: 'stub' (заглушка для отладки) | 'yandex' (РСЯ) | 'adsense'
 */
import { CONFIG } from './config.js';

const overlay = document.getElementById('adOverlay');
const adTimer = document.getElementById('adTimer');
const adSlot = document.getElementById('adSlot');
const adLabel = document.getElementById('adLabel');
const adSkip = document.getElementById('adSkip');
const bannerEl = document.getElementById('adBanner');

let lastInterstitial = 0;

function showOverlay(label) {
  adLabel.textContent = label;
  overlay.classList.remove('is-hidden');
  document.getElementById('gameFrame').style.pointerEvents = 'none';
}
function hideOverlay() {
  overlay.classList.add('is-hidden');
  adSkip.classList.add('is-hidden');
  adSlot.innerHTML = '';
  document.getElementById('gameFrame').style.pointerEvents = '';
}

function countdown(seconds, onTick) {
  return new Promise(resolve => {
    let left = seconds;
    onTick(left);
    const t = setInterval(() => {
      left -= 1;
      onTick(left);
      if (left <= 0) { clearInterval(t); resolve(); }
    }, 1000);
  });
}

// ── провайдеры ───────────────────────────────────────────────
const providers = {
  stub: {
    async play(seconds, label) {
      showOverlay(label);
      adSlot.innerHTML = `<div class="ad-stub">Здесь будет рекламный блок</div>`;
      await countdown(seconds, n => { adTimer.textContent = n > 0 ? `${n}` : 'Готово'; });
      hideOverlay();
      return true;
    }
  },

  // Яндекс.Директ / РСЯ: блок создаётся на своём домене после модерации сайта
  yandex: {
    async play(seconds, label) {
      showOverlay(label);
      const id = 'yad-' + Date.now();
      adSlot.innerHTML = `<div id="${id}"></div>`;
      try {
        window.yaContextCb = window.yaContextCb || [];
        window.yaContextCb.push(() => {
          window.Ya.Context.AdvManager.render({
            blockId: CONFIG.ads.yandexBlockId,
            renderTo: id,
            type: 'fullscreen'
          });
        });
      } catch (_) {}
      await countdown(seconds, n => { adTimer.textContent = n > 0 ? `${n}` : 'Готово'; });
      hideOverlay();
      return true;
    }
  },

  adsense: {
    async play(seconds, label) {
      showOverlay(label);
      adSlot.innerHTML = `<ins class="adsbygoogle" style="display:block;width:336px;height:280px"
        data-ad-client="${CONFIG.ads.adsenseClient || ''}" data-ad-slot="${CONFIG.ads.adsenseSlot || ''}"></ins>`;
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (_) {}
      await countdown(seconds, n => { adTimer.textContent = n > 0 ? `${n}` : 'Готово'; });
      hideOverlay();
      return true;
    }
  }
};

const provider = providers[CONFIG.ads.provider] || providers.stub;

export const ads = {
  bannerVisible: false,

  async interstitial() {
    const now = Date.now() / 1000;
    if (now - lastInterstitial < CONFIG.ads.interstitialCooldown) return false;
    lastInterstitial = now;
    return provider.play(CONFIG.ads.interstitialSeconds, 'Реклама');
  },

  async rewarded() {
    let cancelled = false;
    adSkip.classList.remove('is-hidden');
    adSkip.onclick = () => { cancelled = true; hideOverlay(); };
    await provider.play(CONFIG.ads.rewardedSeconds, 'Реклама за награду');
    return !cancelled;
  },

  banner(show) {
    this.bannerVisible = !!show;
    bannerEl.classList.toggle('is-hidden', !show);
  }
};
