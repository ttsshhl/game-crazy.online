-- Только блок v4: исправление функций профиля и аватары.
-- Выполняется поверх уже созданной схемы, данные не затрагивает.

-- ═════════════════════════════════════════════════════════════
-- v4 · исправление функций, аватары и имя игрока
-- Причина правки: имена выходных колонок совпадали с именами
-- колонок таблиц, из-за чего Postgres отвечал
-- «column reference is ambiguous» и профиль оставался пустым.
-- ═════════════════════════════════════════════════════════════

create or replace function my_streak()
returns table (current_days integer, best_days integer, last_play_date date)
language sql stable security definer set search_path = public as $$
  select s.current_days, s.best_days, s.last_play_date
  from player_streak s
  where s.user_id = auth.uid();
$$;

create or replace function leaderboard_me(p_game text, p_board text)
returns table (rank bigint, score bigint, extra jsonb)
language sql stable security definer set search_path = public as $$
  with ranked as (
    select s.user_id as uid, s.score as sc, s.extra as ex,
           row_number() over (order by s.score desc, s.updated_at asc) as rn
    from scores s
    where s.game_id = p_game and s.board = coalesce(p_board, 'default')
  )
  select r.rn, r.sc, r.ex from ranked r where r.uid = auth.uid();
$$;

create or replace function leaderboard_top(p_game text, p_board text, p_limit int default 20)
returns table (rank bigint, score bigint, extra jsonb, player_name text, player_photo text)
language sql stable security definer set search_path = public as $$
  select row_number() over (order by s.score desc, s.updated_at asc),
         s.score, s.extra, p.name, p.photo
  from scores s
  left join profiles p on p.id = s.user_id
  where s.game_id = p_game and s.board = coalesce(p_board, 'default')
  order by s.score desc, s.updated_at asc
  limit least(p_limit, 100);
$$;

create or replace function my_library()
returns table (
  game_id text,
  has_save boolean,
  last_played timestamptz,
  seconds integer,
  sessions integer,
  best_score bigint,
  rank bigint,
  total_players bigint
)
language sql stable security definer set search_path = public as $$
  with ids as (
    select a.game_id as gid from play_activity a where a.user_id = auth.uid()
    union
    select sv.game_id from game_saves sv where sv.user_id = auth.uid()
    union
    select sc.game_id from scores sc where sc.user_id = auth.uid()
  ),
  ranked as (
    select s.game_id as gid, s.user_id as uid, s.score as sc,
           row_number() over (partition by s.game_id order by s.score desc, s.updated_at asc) as rn,
           count(*) over (partition by s.game_id) as total
    from scores s
    where s.board = 'default'
  )
  select
    i.gid,
    coalesce(sv.payload is not null and sv.payload <> '{}'::jsonb, false),
    greatest(a.last_played_at, sv.updated_at),
    coalesce(a.seconds, 0),
    coalesce(a.sessions, 0),
    r.sc,
    r.rn,
    r.total
  from ids i
  left join play_activity a on a.game_id = i.gid and a.user_id = auth.uid()
  left join game_saves   sv on sv.game_id = i.gid and sv.user_id = auth.uid()
  left join ranked        r on r.gid = i.gid and r.uid = auth.uid()
  order by greatest(a.last_played_at, sv.updated_at) desc nulls last;
$$;

-- ── аватары и имя ────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('avatars', 'avatars', true, 2097152)
on conflict (id) do nothing;

drop policy if exists "avatars read" on storage.objects;
create policy "avatars read" on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists "avatars own upload" on storage.objects;
create policy "avatars own upload" on storage.objects for insert
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars own update" on storage.objects;
create policy "avatars own update" on storage.objects for update
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars own delete" on storage.objects;
create policy "avatars own delete" on storage.objects for delete
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- профиль игрок создаёт и правит сам
drop policy if exists "profiles insert own" on profiles;
create policy "profiles insert own" on profiles for insert
  with check (auth.uid() = id);

-- профиль есть у каждого, включая анонимных
create or replace function my_profile()
returns table (name text, photo text)
language sql stable security definer set search_path = public as $$
  select p.name, p.photo from profiles p where p.id = auth.uid();
$$;
