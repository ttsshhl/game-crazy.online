/*!
 * PLAYDROP SDK v1.0 — подключается ВНУТРИ игры.
 * Даёт: рекламу, облачные сейвы, статы, лидерборды, авторизацию.
 * Совместим с Yandex Games SDK: определяет window.YaGames,
 * поэтому игры, написанные под ysdk, работают без правок.
 *
 * <script src="https://playdrop.ru/sdk/playdrop-sdk.js"></script>
 */
(function (global) {
  'use strict';

  var VERSION = '1.0';
  var TIMEOUT = 20000;
  var inFrame = global.parent && global.parent !== global;

  var calls = {};
  var seq = 0;
  var hostReady = false;
  var queue = [];

  // ── транспорт ──────────────────────────────────────────────
  function send(method, payload) {
    return new Promise(function (resolve, reject) {
      if (!inFrame) return reject(new Error('offline'));
      var id = ++seq;
      calls[id] = { resolve: resolve, reject: reject };
      var msg = { __pd: 1, id: id, method: method, payload: payload || {} };
      if (hostReady) global.parent.postMessage(msg, '*');
      else queue.push(msg);
      setTimeout(function () {
        if (calls[id]) { calls[id].reject(new Error('timeout: ' + method)); delete calls[id]; }
      }, TIMEOUT);
    });
  }

  global.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__pd !== 2) return;
    if (d.method === 'host.ready') {
      hostReady = true;
      queue.splice(0).forEach(function (m) { global.parent.postMessage(m, '*'); });
      return;
    }
    if (d.method === 'host.event') { emit(d.payload.name, d.payload.data); return; }
    var c = calls[d.id];
    if (!c) return;
    delete calls[d.id];
    d.error ? c.reject(new Error(d.error)) : c.resolve(d.result);
  });

  // ── события (пауза/возобновление при рекламе) ──────────────
  var handlers = {};
  function on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); }
  function emit(name, data) { (handlers[name] || []).forEach(function (f) { try { f(data); } catch (_) {} }); }

  // ── локальный фолбэк (игра открыта напрямую, не в портале) ─
  var LS = {
    key: function (k) { return 'pd:' + (global.PLAYDROP_GAME_ID || 'game') + ':' + k; },
    get: function (k, def) {
      try { var v = localStorage.getItem(LS.key(k)); return v ? JSON.parse(v) : def; } catch (_) { return def; }
    },
    set: function (k, v) { try { localStorage.setItem(LS.key(k), JSON.stringify(v)); } catch (_) {} }
  };

  function withFallback(method, payload, fallbackFn) {
    return send(method, payload).catch(function () { return fallbackFn(); });
  }

  // ── реклама ────────────────────────────────────────────────
  var adv = {
    showFullscreenAdv: function (opts) {
      var cb = (opts && opts.callbacks) || {};
      send('adv.fullscreen').then(function (r) {
        if (cb.onOpen && r.wasShown) cb.onOpen();
        if (cb.onClose) cb.onClose(!!r.wasShown);
      }).catch(function (err) {
        if (cb.onError) cb.onError(err);
        else if (cb.onClose) cb.onClose(false);
      });
    },
    showRewardedVideo: function (opts) {
      var cb = (opts && opts.callbacks) || {};
      if (cb.onOpen) cb.onOpen();
      send('adv.rewarded').then(function (r) {
        if (r.rewarded && cb.onRewarded) cb.onRewarded();
        if (cb.onClose) cb.onClose();
      }).catch(function (err) {
        if (cb.onError) cb.onError(err);
        if (cb.onClose) cb.onClose();
      });
    },
    showBannerAdv: function () { return send('adv.banner', { show: true }).catch(noop); },
    hideBannerAdv: function () { return send('adv.banner', { show: false }).catch(noop); },
    getBannerAdvStatus: function () {
      return send('adv.bannerStatus').catch(function () { return { stickyAdvIsShowing: false }; });
    }
  };
  function noop() {}

  // ── игрок ──────────────────────────────────────────────────
  function Player(info) {
    this._info = info || { id: 'guest', name: 'Гость', photo: '', mode: 'lite' };
    this._data = null;
    this._stats = null;
  }
  Player.prototype = {
    getUniqueID: function () { return this._info.id; },
    getName: function () { return this._info.name; },
    getPhoto: function () { return this._info.photo || ''; },
    getMode: function () { return this._info.mode; }, // 'lite' = аноним, '' = авторизован
    getIDsPerGame: function () { return Promise.resolve([]); },
    signature: function () { return this._info.signature || ''; },

    getData: function (keys) {
      var self = this;
      return withFallback('player.getData', {}, function () { return LS.get('data', {}); })
        .then(function (all) {
          self._data = all || {};
          if (!keys) return self._data;
          var out = {};
          keys.forEach(function (k) { if (k in self._data) out[k] = self._data[k]; });
          return out;
        });
    },
    setData: function (data, flush) {
      var merged = Object.assign({}, this._data || {}, data);
      this._data = merged;
      LS.set('data', merged);
      return send('player.setData', { data: merged, flush: !!flush }).catch(noop).then(function () {});
    },
    getStats: function (keys) {
      var self = this;
      return withFallback('player.getStats', {}, function () { return LS.get('stats', {}); })
        .then(function (all) {
          self._stats = all || {};
          if (!keys) return self._stats;
          var out = {};
          keys.forEach(function (k) { if (k in self._stats) out[k] = self._stats[k]; });
          return out;
        });
    },
    setStats: function (stats) {
      var merged = Object.assign({}, this._stats || {}, stats);
      this._stats = merged;
      LS.set('stats', merged);
      return send('player.setStats', { stats: merged }).catch(noop).then(function () {});
    },
    incrementStats: function (increments) {
      var self = this;
      var base = self._stats || LS.get('stats', {});
      var next = Object.assign({}, base);
      Object.keys(increments).forEach(function (k) { next[k] = (next[k] || 0) + increments[k]; });
      self._stats = next;
      LS.set('stats', next);
      return send('player.setStats', { stats: next }).catch(noop).then(function () { return next; });
    }
  };

  // ── лидерборды ─────────────────────────────────────────────
  var leaderboards = {
    setLeaderboardScore: function (name, score, extraData) {
      LS.set('lb:' + name, Math.max(LS.get('lb:' + name, 0), score));
      return send('lb.setScore', { board: name, score: score, extra: extraData || null }).catch(noop);
    },
    getLeaderboardEntries: function (name, opts) {
      opts = opts || {};
      return withFallback('lb.getEntries', {
        board: name,
        quantityTop: opts.quantityTop || 20,
        includeUser: !!opts.includeUser
      }, function () { return { entries: [], leaderboard: { name: name } }; });
    },
    getLeaderboardPlayerEntry: function (name) {
      return send('lb.getPlayerEntry', { board: name });
    },
    getLeaderboardDescription: function (name) {
      return Promise.resolve({ name: name, default: true });
    }
  };

  // ── покупки (внутриигровые) ────────────────────────────────
  function Payments() {}
  Payments.prototype = {
    purchase: function (opts) { return send('pay.purchase', opts || {}); },
    getPurchases: function () { return send('pay.list').catch(function () { return []; }); },
    getCatalog: function () { return send('pay.catalog').catch(function () { return []; }); },
    consumePurchase: function (token) { return send('pay.consume', { token: token }).catch(noop); }
  };

  // ── безопасное хранилище (ysdk.getStorage) ────────────────
  var safeStorage = {
    getItem: function (k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    setItem: function (k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    removeItem: function (k) { try { localStorage.removeItem(k); } catch (_) {} },
    clear: function () { try { localStorage.clear(); } catch (_) {} },
    key: function (i) { try { return localStorage.key(i); } catch (_) { return null; } },
    get length() { try { return localStorage.length; } catch (_) { return 0; } }
  };

  // ── тип устройства (ysdk.deviceInfo) ──────────────────────
  var ua = navigator.userAgent;
  var isTablet = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua);
  var isMobile = !isTablet && /Mobi|Android|iPhone|iPod|Opera Mini|IEMobile/i.test(ua);
  var isTV = /SmartTV|GoogleTV|AppleTV|HbbTV|NetCast|Web0S|Tizen/i.test(ua);

  var deviceInfo = {
    type: isTV ? 'tv' : isTablet ? 'tablet' : isMobile ? 'mobile' : 'desktop',
    isMobile: function () { return isMobile; },
    isTablet: function () { return isTablet; },
    isDesktop: function () { return !isMobile && !isTablet && !isTV; },
    isTV: function () { return isTV; }
  };

  // ── ядро SDK ───────────────────────────────────────────────
  var sdk = {
    version: VERSION,
    platform: 'playdrop',
    isAvailableMethod: function (m) { return Promise.resolve(true); },

    deviceInfo: deviceInfo,
    getStorage: function () { return Promise.resolve(safeStorage); },
    getFlags: function () { return Promise.resolve({}); },
    getServerTime: function () { return Promise.resolve(Date.now()); },

    EVENTS: { EXIT: 'EXIT', HISTORY_BACK: 'HISTORY_BACK', GAME_API_PAUSE: 'GAME_API_PAUSE', GAME_API_RESUME: 'GAME_API_RESUME' },
    dispatchEvent: function () { return Promise.resolve(); },
    onEvent: function (name, fn) { on(name, fn); return function () {}; },

    environment: {
      app: { id: global.PLAYDROP_GAME_ID || 'game' },
      browser: { lang: (navigator.language || 'ru').slice(0, 2) },
      i18n: { lang: (navigator.language || 'ru').slice(0, 2), tld: 'ru' },
      payload: new URLSearchParams(location.search).get('payload') || null
    },

    adv: adv,
    getPayments: function () { return Promise.resolve(new Payments()); },

    getPlayer: function (opts) {
      return send('player.get', opts || {})
        .then(function (info) { return new Player(info); })
        .catch(function () { return new Player(null); });
    },

    auth: {
      openAuthDialog: function () { return send('auth.open'); }
    },

    getLeaderboards: function () { return Promise.resolve(leaderboards); },

    feedback: {
      canReview: function () { return send('feedback.can').catch(function () { return { value: false, reason: 'NO_AUTH' }; }); },
      requestReview: function () { return send('feedback.request').catch(function () { return { feedbackSent: false }; }); }
    },

    clipboard: {
      writeText: function (t) { return navigator.clipboard.writeText(t); }
    },

    screen: {
      fullscreen: {
        get status() { return document.fullscreenElement ? 'on' : 'off'; },
        request: function () { return send('screen.fullscreen', { on: true }).catch(noop); },
        exit: function () { return send('screen.fullscreen', { on: false }).catch(noop); }
      }
    },

    shortcut: {
      canShowPrompt: function () { return Promise.resolve({ canShow: false }); },
      showPrompt: function () { return Promise.resolve({ outcome: 'dismissed' }); }
    },

    features: {
      LoadingAPI: {
        ready: function () { send('game.ready').catch(noop); }
      },
      GameplayAPI: {
        start: function () { send('game.start').catch(noop); },
        stop: function () { send('game.stop').catch(noop); }
      }
    },

    // сверх Yandex SDK
    on: on,
    exit: function () { return send('game.exit').catch(noop); },
    share: function (opts) { return send('game.share', opts || {}).catch(noop); }
  };

  // авто-пауза: портал сообщает, когда открыл рекламу или свернул вкладку
  on('pause', function () { emit('game:pause'); });

  global.PlayDrop = sdk;

  // ── shim: игры под Yandex SDK работают как есть ────────────
  if (!global.YaGames) {
    global.YaGames = {
      init: function () { return Promise.resolve(sdk); },
      deprecated: false
    };
  }

  // сигнал хосту, что SDK загрузился
  if (inFrame) global.parent.postMessage({ __pd: 1, id: 0, method: 'sdk.hello', payload: { version: VERSION } }, '*');

  global.dispatchEvent(new Event('playdrop:ready'));
})(window);
