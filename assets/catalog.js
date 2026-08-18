/*!
 * PLAYDROP · источник каталога.
 * Сначала пробует таблицу games в Supabase, при неудаче — статический games.json.
 * Так площадка продолжает работать, даже если база недоступна.
 */
import { db } from './db.js';

export const lang = (navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en';

function fromRow(r) {
  return {
    id: r.id,
    title: r.title,
    title_en: r.title_en,
    description: r.description,
    description_en: r.description_en,
    genre: r.genre,
    genre_en: r.genre_en,
    tag: r.tag || '',
    cover: r.cover_url || '',
    url: r.game_url,
    featured: !!r.featured,
    developer: r.developer || 'ttsshhl'
  };
}

let cache = null;

export async function loadGames(force) {
  if (cache && !force) return cache;

  try {
    const { data, error } = await db
      .from('games').select('*')
      .eq('published', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (!error && data && data.length) return (cache = data.map(fromRow));
  } catch (_) { /* база недоступна — идём в файл */ }

  try {
    const list = await fetch('./games.json').then(r => r.json());
    return (cache = list);
  } catch (_) {
    return (cache = []);
  }
}

/** Имя и фото игрока из таблицы profiles — то же, что видно в таблицах рекордов. */
export async function loadMyProfile(session) {
  const meta = session?.user?.user_metadata || {};
  const fallback = { name: meta.name || meta.full_name || null, photo: meta.avatar_url || null };
  if (!session) return fallback;
  try {
    const { data } = await db.rpc('my_profile');
    const row = data && data[0];
    return { name: row?.name || fallback.name, photo: row?.photo || fallback.photo };
  } catch (_) { return fallback; }
}

/** Кружок с фото или с первой буквой имени, если фото нет. */
export function avatarHtml(profile, name) {
  const letter = (profile?.name || name || 'И').trim()[0].toUpperCase();
  return profile?.photo
    ? `<img class="ava" src="${profile.photo}" alt="">`
    : `<span class="ava ava--letter">${letter}</span>`;
}

/** Название и описание на языке посетителя, с откатом на русский. */
export function loc(game) {
  if (lang === 'en') {
    return {
      title: game.title_en || game.title,
      description: game.description_en || game.description || '',
      genre: game.genre_en || game.genre || ''
    };
  }
  return { title: game.title, description: game.description || '', genre: game.genre || '' };
}

/** Несколько строк интерфейса — остальное на русском. */
const UI = {
  ru: { continue: 'Продолжить', all: 'Все игры', play: 'Играть', search: 'Найти игру',
        playingNow: 'Играют сейчас', notPlayed: 'Ещё не играли', profile: 'Профиль',
        signIn: 'Войти', signOut: 'Выйти', games: 'игр в каталоге', free: 'ничего не нужно устанавливать' },
  en: { continue: 'Continue', all: 'All games', play: 'Play', search: 'Find a game',
        playingNow: 'Playing now', notPlayed: 'Not played yet', profile: 'Profile',
        signIn: 'Sign in', signOut: 'Sign out', games: 'games in the catalog', free: 'nothing to install' }
};

export const t = UI[lang];
