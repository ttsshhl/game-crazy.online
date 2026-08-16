/**
 * yandex-userinfo — прослойка между Supabase и Яндекс ID.
 *
 * Нужна по двум причинам:
 *  1. Яндекс ждёт заголовок «Authorization: OAuth <token>», а Supabase шлёт «Bearer <token>».
 *  2. Яндекс отдаёт id / default_email / display_name, а Supabase ждёт sub / email / name.
 *
 * Деплой (проверка JWT отключается — сюда приходит токен Яндекса, а не Supabase):
 *   supabase functions deploy yandex-userinfo --no-verify-jwt
 *
 * Полученный URL вставляется в поле UserInfo URL кастомного провайдера.
 */
Deno.serve(async (req) => {
  const header = req.headers.get('authorization') || '';
  const token = header.replace(/^(Bearer|OAuth)\s+/i, '').trim();
  if (!token) {
    return Response.json({ error: 'no_token' }, { status: 401 });
  }

  const res = await fetch('https://login.yandex.ru/info?format=json', {
    headers: { Authorization: `OAuth ${token}` }
  });

  if (!res.ok) {
    return Response.json({ error: 'yandex_rejected', status: res.status }, { status: 401 });
  }

  const y = await res.json();

  return Response.json({
    sub: String(y.id),
    email: y.default_email || null,
    email_verified: !!y.default_email,
    name: y.display_name || y.real_name || y.login,
    preferred_username: y.login,
    picture: y.is_avatar_empty || !y.default_avatar_id
      ? null
      : `https://avatars.yandex.net/get-yapic/${y.default_avatar_id}/islands-200`
  });
});
