/*!
 * PLAYDROP · библиотека игрока.
 * Собирает прогресс по всем играм: с сервера для авторизованных,
 * из localStorage для гостей — чтобы «Продолжить» работало сразу.
 */
import { db } from './db.js';

// ─── локальный слой (гость) ──────────────────────────────────
export function localEntry(gameId) {
  const num = k => Number(localStorage.getItem(`pd:${gameId}:${k}`) || 0);
  const has = k => localStorage.getItem(`pd:${gameId}:${k}`);
  const save = has('data');
  const played = num('lastPlayed');
  if (!played && !save) return null;
  return {
    game_id: gameId,
    has_save: !!(save && save !== '{}'),
    last_played: played ? new Date(played).toISOString() : null,
    seconds: num('seconds'),
    sessions: num('sessions'),
    best_score: null,
    rank: null,
    total_players: null,
    local: true
  };
}

export function localLibrary(games) {
  return games.map(g => localEntry(g.id)).filter(Boolean);
}

// ─── серверный слой ──────────────────────────────────────────
export let lastError = null;

export async function loadLibrary(session, games) {
  if (!session) {
    lastError = 'нет сессии — прогресс читается только из этого браузера';
    console.warn('[playdrop]', lastError);
    return localLibrary(games);
  }

  const { data, error } = await db.rpc('my_library');
  if (error) {
    lastError = error.message;
    console.warn('[playdrop] my_library вернула ошибку:', error.message);
    return localLibrary(games);
  }
  if (!data) return localLibrary(games);
  console.info('[playdrop] прогресс с сервера:', data.length, 'записей; игрок', session.user.id);

  // локальные данные догоняют серверные, если игрок играл до входа
  const byId = new Map(data.map(r => [r.game_id, r]));
  for (const g of games) {
    const loc = localEntry(g.id);
    if (!loc) continue;
    const srv = byId.get(g.id);
    if (!srv) byId.set(g.id, loc);
    else {
      srv.seconds = Math.max(srv.seconds || 0, loc.seconds);
      if (!srv.last_played || new Date(loc.last_played) > new Date(srv.last_played)) {
        srv.last_played = loc.last_played;
      }
    }
  }
  return [...byId.values()];
}

export async function loadStreak(session) {
  if (!session) {
    return { current: Number(localStorage.getItem('pd:streak') || 0), best: 0, local: true };
  }
  const { data } = await db.rpc('my_streak');
  const row = data && data[0];
  return { current: row?.current_days || 0, best: row?.best_days || 0 };
}

// ─── уровень игрока ──────────────────────────────────────────
// XP: 1 за минуту в игре + 20 за каждую освоенную игру.
export function xpFrom(entries) {
  const minutes = Math.floor(entries.reduce((s, e) => s + (e.seconds || 0), 0) / 60);
  return minutes + entries.length * 20;
}

export function levelFrom(xp) {
  let level = 1, need = 25, spent = 0;
  while (xp - spent >= need) { spent += need; level += 1; need = 25 * level; }
  return { level, into: xp - spent, need, percent: Math.round(((xp - spent) / need) * 100) };
}

// ─── форматирование ──────────────────────────────────────────
export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return `${sec} сек`;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export function fmtAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return 'только что';
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
  const d = Math.floor(diff / 86400);
  if (d === 1) return 'вчера';
  if (d < 7) return `${d} дн. назад`;
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
