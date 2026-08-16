import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG } from './config.js';

export const db = createClient(CONFIG.supabase.url, CONFIG.supabase.anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

/**
 * Возвращает сессию. Если её нет и включён анонимный режим —
 * молча создаёт анонимного пользователя: у игрока появляется
 * настоящий user_id, RLS работает, прогресс пишется на сервер.
 */
export async function ensureSession() {
  const { data } = await db.auth.getSession();
  if (data.session) return data.session;
  if (!CONFIG.auth.anonymous) return null;
  const { data: anon, error } = await db.auth.signInAnonymously();
  if (error) { console.warn('Анонимный вход недоступен:', error.message); return null; }
  return anon.session;
}

/** Анонимный пользователь — это ещё «гость»: прогресс живёт на одном устройстве. */
export function isNamed(session) {
  return !!session && session.user.is_anonymous !== true;
}

/** Показывать ли кнопки входа. */
export const canSignIn = !!CONFIG.auth.provider;

/**
 * Именованный вход. Анонимную сессию не сбрасывает, а привязывает
 * к ней личность — весь накопленный прогресс остаётся.
 */
export async function signIn(redirectTo) {
  if (!CONFIG.auth.provider) return;
  const options = { redirectTo: redirectTo || location.href };
  const { data } = await db.auth.getSession();

  if (data.session && data.session.user.is_anonymous) {
    return db.auth.linkIdentity({ provider: CONFIG.auth.provider, options });
  }
  return db.auth.signInWithOAuth({ provider: CONFIG.auth.provider, options });
}

export async function signOut() { return db.auth.signOut(); }
