/*!
 * PLAYDROP HOST — работает на странице портала, обслуживает игру в iframe.
 * Принимает postMessage от playdrop-sdk.js, ходит в Supabase, крутит рекламу.
 */
import { CONFIG } from './config.js';
import { db, ensureSession, isNamed, canSignIn, signIn, signOut } from './db.js';
import { ads } from './ads.js';
import { loadGames, loc } from './catalog.js';

const frame = document.getElementById('gameFrame');
const params = new URLSearchParams(location.search);
const gameId = params.get('id');

let game = null;
let session = null;
let ticking = true;   // игрок за экраном и реклама не крутится
let pending = 0;      // накоплено секунд, ещё не отправленных на сервер
let localSeconds = 0;
let guestId = localStorage.getItem('pd:guest') ||
  (localStorage.setItem('pd:guest', 'g_' + Math.random().toString(36).slice(2, 12)), localStorage.getItem('pd:guest'));

// ─── загрузка карточки игры ──────────────────────────────────
const catalog = await loadGames();
game = catalog.find(g => g.id === gameId) || catalog[0];

let loaderDone = false;
function hideLoader() {
  if (loaderDone) return;
  loaderDone = true;
  document.getElementById('loader').classList.add('is-hidden');
}

// игра сообщила о готовности сама — лучший случай
// не сообщила: снимаем через 2 сек после загрузки документа в рамке
frame.addEventListener('load', () => setTimeout(hideLoader, 2000));
// совсем ничего не произошло — снимаем принудительно и показываем подсказку
setTimeout(() => {
  if (loaderDone) return;
  hideLoader();
  console.warn('[playdrop] Игра не подала признаков жизни за 15 секунд. ' +
    'Открой адрес игры напрямую в новой вкладке: ' + game.url);
}, 15000);

console.info('[playdrop] Адрес игры:', game.url);
document.title = `${loc(game).title} — ${CONFIG.brand}`;
document.getElementById('gameTitle').textContent = loc(game).title;
document.getElementById('gameDev').textContent = game.developer;
mountGame(game.url);

/**
 * Игру с чужого домена (Storage) браузер часто отказывается показывать
 * в рамке — «blocked:origin». Поэтому HTML скачиваем сами и открываем
 * из blob: он принадлежит нашей странице, и запрет не действует.
 * Тег <base> оставляет относительные пути игры указывающими на Storage,
 * чтобы её картинки, звуки и скрипты продолжали грузиться.
 */
async function mountGame(url) {
  const sameOrigin = !/^https?:\/\//i.test(url) || url.startsWith(location.origin);
  if (sameOrigin) { frame.src = url; return; }

  try {
    const res = await fetch(url, { mode: 'cors', cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let html = await res.text();

    const base = url.replace(/[^/]*$/, '');
    if (!/<base\s/i.test(html)) {
      html = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, (m) => `${m}\n<base href="${base}">`)
        : `<base href="${base}">` + html;
    }

    frame.src = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  } catch (e) {
    console.warn('[playdrop] Не удалось загрузить игру напрямую:', e.message, '— пробую обычным способом');
    frame.src = url;
  }
}

session = await ensureSession();
renderAccount();
startTracking();

// ─── роутер сообщений от игры ────────────────────────────────
const handlers = {
  'sdk.hello': async () => {
    reply(null, { method: 'host.ready' });
    setTimeout(hideLoader, 1500);
    return { ok: true };
  },

  'game.ready': async () => {
    hideLoader();
    return { ok: true };
  },

  'game.start': async () => ({ ok: true }),
  'game.stop': async () => ({ ok: true }),

  'player.get': async () => {
    if (!session) return { id: guestId, name: 'Гость', photo: '', mode: 'lite' };
    const u = session.user;
    let prof = null;
    try { const { data } = await db.rpc('my_profile'); prof = data && data[0]; } catch (_) {}
    if (!isNamed(session)) {
      return { id: u.id, name: prof?.name || 'Гость', photo: prof?.photo || '', mode: 'lite' };
    }
    if (prof?.name) return { id: u.id, name: prof.name, photo: prof.photo || '', mode: '' };
    return {
      id: u.id,
      name: u.user_metadata?.name || u.user_metadata?.full_name || 'Игрок',
      photo: u.user_metadata?.avatar_url || '',
      mode: ''
    };
  },

  'player.getData': async () => {
    if (!session) return JSON.parse(localStorage.getItem(lsKey('data')) || '{}');
    const { data } = await db.from('game_saves')
      .select('payload').eq('game_id', game.id).eq('user_id', session.user.id).maybeSingle();
    return data?.payload || {};
  },

  'player.setData': async ({ data }) => {
    localStorage.setItem(lsKey('data'), JSON.stringify(data));
    if (!session) return { ok: true };
    await db.from('game_saves').upsert({
      user_id: session.user.id, game_id: game.id, payload: data, updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,game_id' });
    return { ok: true };
  },

  'player.getStats': async () => {
    if (!session) return JSON.parse(localStorage.getItem(lsKey('stats')) || '{}');
    const { data } = await db.from('game_stats')
      .select('payload').eq('game_id', game.id).eq('user_id', session.user.id).maybeSingle();
    return data?.payload || {};
  },

  'player.setStats': async ({ stats }) => {
    localStorage.setItem(lsKey('stats'), JSON.stringify(stats));
    if (!session) return { ok: true };
    await db.from('game_stats').upsert({
      user_id: session.user.id, game_id: game.id, payload: stats, updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,game_id' });
    return { ok: true };
  },

  'lb.setScore': async ({ board, score, extra }) => {
    if (!session) return { ok: false, reason: 'NO_AUTH' };
    await db.rpc('submit_score', {
      p_game: game.id, p_board: board, p_score: Math.round(score), p_extra: extra
    });
    return { ok: true };
  },

  'lb.getEntries': async ({ board, quantityTop }) => {
    const { data } = await db.rpc('leaderboard_top', {
      p_game: game.id, p_board: board, p_limit: Math.min(quantityTop || 20, 100)
    });
    return {
      leaderboard: { name: board },
      ranges: [{ start: 0, size: (data || []).length }],
      userRank: 0,
      entries: (data || []).map(r => ({
        score: r.score,
        rank: r.rank,
        extraData: r.extra,
        player: { publicName: r.player_name || 'Игрок', getAvatarSrc: () => r.player_photo || '', scopePermissions: {} }
      }))
    };
  },

  'lb.getPlayerEntry': async ({ board }) => {
    if (!session) throw new Error('FetchError: NO_AUTH');
    const { data } = await db.rpc('leaderboard_me', { p_game: game.id, p_board: board });
    if (!data || !data.length) throw new Error('FetchError: NO_SCORE');
    return { score: data[0].score, rank: data[0].rank, extraData: data[0].extra };
  },

  'adv.fullscreen': async () => {
    pauseGame();
    const wasShown = await ads.interstitial();
    resumeGame();
    return { wasShown };
  },

  'adv.rewarded': async () => {
    pauseGame();
    const rewarded = await ads.rewarded();
    resumeGame();
    return { rewarded };
  },

  'adv.banner': async ({ show }) => { ads.banner(show); return { ok: true }; },
  'adv.bannerStatus': async () => ({ stickyAdvIsShowing: ads.bannerVisible }),

  'auth.open': async () => {
    await signIn(location.href);
    return { ok: true };
  },

  'feedback.can': async () => ({ value: isNamed(session), reason: isNamed(session) ? '' : 'NO_AUTH' }),
  'feedback.request': async () => {
    document.getElementById('reviewBox').classList.remove('is-hidden');
    return { feedbackSent: true };
  },

  'screen.fullscreen': async ({ on }) => {
    on ? document.documentElement.requestFullscreen?.() : document.exitFullscreen?.();
    return { ok: true };
  },

  'game.exit': async () => { location.href = './index.html'; return { ok: true }; },

  'game.share': async ({ text }) => {
    const url = `${location.origin}${location.pathname}?id=${game.id}`;
    if (navigator.share) await navigator.share({ title: game.title, text: text || game.title, url });
    else await navigator.clipboard.writeText(url);
    return { ok: true };
  },

  'pay.catalog': async () => game.products || [],
  'pay.list': async () => {
    if (!session) return [];
    const { data } = await db.from('purchases')
      .select('product_id, token').eq('user_id', session.user.id).eq('game_id', game.id).eq('consumed', false);
    return (data || []).map(p => ({ productID: p.product_id, purchaseToken: p.token }));
  },
  'pay.purchase': async ({ id }) => {
    // сюда подключается ЮKassa/Robokassa: создаём платёж и ждём вебхук
    throw new Error('PAYMENTS_NOT_CONFIGURED');
  },
  'pay.consume': async ({ token }) => {
    if (session) await db.from('purchases').update({ consumed: true }).eq('token', token);
    return { ok: true };
  }
};

window.addEventListener('message', async (e) => {
  const m = e.data;
  if (!m || m.__pd !== 1) return;
  if (e.source !== frame.contentWindow) return;
  const fn = handlers[m.method];
  if (!fn) return reply(m.id, { error: 'unknown method: ' + m.method });
  try {
    reply(m.id, { result: await fn(m.payload || {}) });
  } catch (err) {
    reply(m.id, { error: String(err.message || err) });
  }
});

function reply(id, body) {
  frame.contentWindow?.postMessage(Object.assign({ __pd: 2, id }, body), '*');
}

function emitToGame(name, data) {
  frame.contentWindow?.postMessage({ __pd: 2, method: 'host.event', payload: { name, data } }, '*');
}

function pauseGame() { ticking = false; emitToGame('pause'); }
function resumeGame() { ticking = true; emitToGame('resume'); frame.focus(); }
function lsKey(k) { return `pd:${game.id}:${k}`; }

// ─── аккаунт ─────────────────────────────────────────────────
function renderAccount() {
  const boxEl = document.getElementById('account');
  if (isNamed(session)) {
    const u = session.user;
    boxEl.innerHTML = `<a class="acc" href="./profile.html">
        <img class="ava" src="${u.user_metadata?.avatar_url || ''}" alt="">
        <span>${u.user_metadata?.name || 'Профиль'}</span></a>
      <button class="btn btn--ghost" id="logout">Выйти</button>`;
    document.getElementById('logout').onclick = async () => { await signOut(); location.reload(); };
  } else {
    boxEl.innerHTML = `<a class="acc" href="./profile.html">Профиль</a>` +
      (canSignIn ? `<button class="btn" id="login">Войти</button>` : '');
    if (canSignIn) document.getElementById('login').onclick = () => signIn(location.href);
  }
}

// ─── полноэкранный режим ─────────────────────────────────────
const stage = document.getElementById('stage');
const fsBtn = document.getElementById('fsBtn');

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function covered() { return stage.classList.contains('stage--cover'); }

function updateFsBtn() {
  fsBtn.textContent = (fsElement() || covered()) ? 'Свернуть' : 'На весь экран';
}

/** Запасной режим: растягиваем плеер по окну средствами CSS. */
function toggleCover(on) {
  stage.classList.toggle('stage--cover', on);
  document.body.classList.toggle('no-scroll', on);
  updateFsBtn();
  frame.focus();
}

async function toggleFullscreen() {
  if (covered()) return toggleCover(false);

  if (fsElement()) {
    try { await (document.exitFullscreen?.() || document.webkitExitFullscreen?.()); } catch (_) {}
    return;
  }

  const request = stage.requestFullscreen || stage.webkitRequestFullscreen || stage.msRequestFullscreen;
  if (!request) return toggleCover(true);

  try {
    await request.call(stage, { navigationUI: 'hide' });
    frame.focus();
  } catch (e) {
    // браузер отказал (политика, расширение, режим окна) — разворачиваем сами
    console.warn('[playdrop] Полноэкранный режим недоступен:', e.message);
    toggleCover(true);
  }
}

fsBtn.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', updateFsBtn);
document.addEventListener('webkitfullscreenchange', updateFsBtn);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && covered()) toggleCover(false); });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { pauseGame(); flush(); } else { resumeGame(); }
});
