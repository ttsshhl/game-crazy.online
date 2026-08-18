/**
 * translate — перевод названия, описания и жанра игры на английский.
 * Вызывается только из панели загрузки и только администратором.
 *
 * Деплой:
 *   supabase functions deploy translate
 *
 * Ключ (любой один, порядок приоритета такой же):
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *   supabase secrets set YANDEX_TRANSLATE_KEY=... YANDEX_FOLDER_ID=...
 * Без ключей используется бесплатный MyMemory — качество хуже, лимиты жёстче.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // ── только администратор ───────────────────────────────────
  const auth = req.headers.get('Authorization') || '';
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } }
  );

  const { data: isAdmin } = await supabase.rpc('is_admin');
  if (!isAdmin) return json({ error: 'forbidden' }, 403);

  const { texts } = await req.json();
  if (!Array.isArray(texts)) return json({ error: 'texts must be an array' }, 400);

  const filled = texts.map((t) => (typeof t === 'string' ? t.trim() : ''));
  if (!filled.some(Boolean)) return json({ translations: filled });

  try {
    const translations = await translate(filled);
    return json({ translations });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 502);
  }
});

async function translate(texts: string[]): Promise<string[]> {
  const anthropic = Deno.env.get('ANTHROPIC_API_KEY');
  if (anthropic) return viaClaude(texts, anthropic);

  const yandexKey = Deno.env.get('YANDEX_TRANSLATE_KEY');
  const folder = Deno.env.get('YANDEX_FOLDER_ID');
  if (yandexKey && folder) return viaYandex(texts, yandexKey, folder);

  return viaMyMemory(texts);
}

/** Лучший вариант для игр: понимает контекст и не переводит названия буквально. */
async function viaClaude(texts: string[], key: string): Promise<string[]> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: Deno.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: 'Ты переводишь тексты для витрины браузерных игр с русского на английский. ' +
        'Названия игр адаптируй, а не переводи дословно: важно, чтобы звучало как название игры для англоязычного игрока. ' +
        'Описания переводи живо и коротко. Отвечай ТОЛЬКО массивом JSON строк в том же порядке, без markdown и пояснений. ' +
        'Пустую строку на входе возвращай пустой строкой.',
      messages: [{ role: 'user', content: JSON.stringify(texts) }]
    })
  });

  if (!res.ok) throw new Error('anthropic ' + res.status);
  const data = await res.json();
  const raw = (data.content || []).map((c: any) => c.text || '').join('').replace(/```json|```/g, '').trim();
  const out = JSON.parse(raw);
  if (!Array.isArray(out)) throw new Error('bad response');
  return texts.map((_, i) => out[i] || '');
}

async function viaYandex(texts: string[], key: string, folderId: string): Promise<string[]> {
  const res = await fetch('https://translate.api.cloud.yandex.net/translate/v2/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${key}` },
    body: JSON.stringify({ folderId, sourceLanguageCode: 'ru', targetLanguageCode: 'en', texts })
  });
  if (!res.ok) throw new Error('yandex ' + res.status);
  const data = await res.json();
  return (data.translations || []).map((t: any) => t.text || '');
}

/** Бесплатно и без ключа, но качество машинное. */
async function viaMyMemory(texts: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const text of texts) {
    if (!text) { out.push(''); continue; }
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=ru|en`;
    const res = await fetch(url);
    const data = await res.json();
    out.push(data?.responseData?.translatedText || '');
  }
  return out;
}
