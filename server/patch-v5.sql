-- v5 · публичная статистика игр для витрины.
-- Выполняется поверх существующей схемы, данные не затрагивает.

create or replace function games_popularity()
returns table (game_id text, launches bigint, players bigint, seconds bigint)
language sql stable security definer set search_path = public as $$
  select a.game_id,
         coalesce(sum(a.sessions), 0)::bigint,
         count(*)::bigint,
         coalesce(sum(a.seconds), 0)::bigint
  from play_activity a
  group by a.game_id;
$$;

grant execute on function games_popularity() to anon, authenticated;
