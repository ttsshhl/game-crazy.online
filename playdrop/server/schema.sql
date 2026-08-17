-- PLAYDROP · схема Supabase. Выполнить целиком в SQL Editor.

-- ── профили ──────────────────────────────────────────────────
create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  name text,
  photo text,
  created_at timestamptz default now()
);

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, name, photo)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', 'Игрок'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();

-- ── сейвы и статистика ───────────────────────────────────────
create table if not exists game_saves (
  user_id uuid references auth.users on delete cascade,
  game_id text not null,
  payload jsonb not null default '{}',
  updated_at timestamptz default now(),
  primary key (user_id, game_id)
);

create table if not exists game_stats (
  user_id uuid references auth.users on delete cascade,
  game_id text not null,
  payload jsonb not null default '{}',
  updated_at timestamptz default now(),
  primary key (user_id, game_id)
);

-- ── лидерборды ───────────────────────────────────────────────
create table if not exists scores (
  user_id uuid references auth.users on delete cascade,
  game_id text not null,
  board text not null default 'default',
  score bigint not null default 0,
  extra jsonb,
  updated_at timestamptz default now(),
  primary key (user_id, game_id, board)
);

create index if not exists scores_board_idx on scores (game_id, board, score desc);

-- ── покупки ──────────────────────────────────────────────────
create table if not exists purchases (
  token uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  game_id text not null,
  product_id text not null,
  amount numeric,
  consumed boolean default false,
  created_at timestamptz default now()
);

-- ── RLS ──────────────────────────────────────────────────────
alter table profiles   enable row level security;
alter table game_saves enable row level security;
alter table game_stats enable row level security;
alter table scores     enable row level security;
alter table purchases  enable row level security;

drop policy if exists "profiles read" on profiles;
create policy "profiles read"   on profiles   for select using (true);
drop policy if exists "profiles write" on profiles;
create policy "profiles write"  on profiles   for update using (auth.uid() = id);

drop policy if exists "saves own" on game_saves;
create policy "saves own"  on game_saves for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "stats own" on game_stats;
create policy "stats own"  on game_stats for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "scores read" on scores;
create policy "scores read" on scores     for select using (true);
drop policy if exists "scores own" on scores;
create policy "scores own"  on scores     for all    using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "purchases own" on purchases;
create policy "purchases own" on purchases for select using (auth.uid() = user_id);

-- ── RPC: запись рекорда (только если он выше прежнего) ───────
create or replace function submit_score(p_game text, p_board text, p_score bigint, p_extra jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'NO_AUTH'; end if;
  insert into scores (user_id, game_id, board, score, extra, updated_at)
  values (auth.uid(), p_game, coalesce(p_board, 'default'), p_score, p_extra, now())
  on conflict (user_id, game_id, board) do update
    set score = greatest(scores.score, excluded.score),
        extra = excluded.extra,
        updated_at = now();
end $$;

-- ── RPC: топ таблицы ─────────────────────────────────────────
create or replace function leaderboard_top(p_game text, p_board text, p_limit int default 20)
returns table (rank bigint, score bigint, extra jsonb, player_name text, player_photo text)
language sql stable security definer set search_path = public as $$
  select row_number() over (order by s.score desc, s.updated_at asc) as rank,
         s.score, s.extra, p.name, p.photo
  from scores s
  left join profiles p on p.id = s.user_id
  where s.game_id = p_game and s.board = coalesce(p_board, 'default')
  order by s.score desc, s.updated_at asc
  limit least(p_limit, 100);
$$;

-- ── RPC: позиция текущего игрока ─────────────────────────────
create or replace function leaderboard_me(p_game text, p_board text)
returns table (rank bigint, score bigint, extra jsonb)
language sql stable security definer set search_path = public as $$
  with ranked as (
    select user_id, score, extra,
           row_number() over (order by score desc, updated_at asc) as rank
    from scores
    where game_id = p_game and board = coalesce(p_board, 'default')
  )
  select rank, score, extra from ranked where user_id = auth.uid();
$$;

-- ═════════════════════════════════════════════════════════════
-- v2 · активность, серии дней, библиотека игрока
-- Блок идемпотентный: файл можно выполнить повторно целиком.
-- ═════════════════════════════════════════════════════════════

create table if not exists play_activity (
  user_id uuid references auth.users on delete cascade,
  game_id text not null,
  seconds integer not null default 0,
  sessions integer not null default 0,
  first_played_at timestamptz default now(),
  last_played_at timestamptz default now(),
  primary key (user_id, game_id)
);

create table if not exists player_streak (
  user_id uuid primary key references auth.users on delete cascade,
  current_days integer not null default 0,
  best_days integer not null default 0,
  last_play_date date
);

alter table play_activity enable row level security;
alter table player_streak enable row level security;

drop policy if exists "activity own" on play_activity;
create policy "activity own" on play_activity for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "streak own" on player_streak;
create policy "streak own" on player_streak for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── RPC: засчитать время игры и обновить серию дней ──────────
create or replace function track_play(p_game text, p_seconds integer, p_new_session boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_last date;
  v_cur integer;
begin
  if auth.uid() is null then return; end if;

  insert into play_activity (user_id, game_id, seconds, sessions, last_played_at)
  values (auth.uid(), p_game, greatest(p_seconds, 0), case when p_new_session then 1 else 0 end, now())
  on conflict (user_id, game_id) do update
    set seconds = play_activity.seconds + greatest(p_seconds, 0),
        sessions = play_activity.sessions + case when p_new_session then 1 else 0 end,
        last_played_at = now();

  select last_play_date, current_days into v_last, v_cur
  from player_streak where user_id = auth.uid();

  if v_last is null then
    insert into player_streak (user_id, current_days, best_days, last_play_date)
    values (auth.uid(), 1, 1, current_date)
    on conflict (user_id) do update
      set current_days = 1, best_days = greatest(player_streak.best_days, 1), last_play_date = current_date;
  elsif v_last = current_date then
    return;
  elsif v_last = current_date - 1 then
    update player_streak
      set current_days = v_cur + 1,
          best_days = greatest(best_days, v_cur + 1),
          last_play_date = current_date
      where user_id = auth.uid();
  else
    update player_streak
      set current_days = 1, last_play_date = current_date
      where user_id = auth.uid();
  end if;
end $$;

-- ── RPC: серия дней текущего игрока ──────────────────────────
create or replace function my_streak()
returns table (current_days integer, best_days integer, last_play_date date)
language sql stable security definer set search_path = public as $$
  select current_days, best_days, last_play_date
  from player_streak where user_id = auth.uid();
$$;

-- ── RPC: библиотека игрока — прогресс по всем играм ──────────
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
    select game_id from play_activity where user_id = auth.uid()
    union
    select game_id from game_saves where user_id = auth.uid()
    union
    select game_id from scores where user_id = auth.uid()
  ),
  ranked as (
    select game_id, user_id, score,
           row_number() over (partition by game_id order by score desc, updated_at asc) as rnk,
           count(*) over (partition by game_id) as total
    from scores where board = 'default'
  )
  select
    i.game_id,
    coalesce(sv.payload is not null and sv.payload <> '{}'::jsonb, false) as has_save,
    greatest(a.last_played_at, sv.updated_at) as last_played,
    coalesce(a.seconds, 0) as seconds,
    coalesce(a.sessions, 0) as sessions,
    r.score as best_score,
    r.rnk as rank,
    r.total as total_players
  from ids i
  left join play_activity a on a.game_id = i.game_id and a.user_id = auth.uid()
  left join game_saves   sv on sv.game_id = i.game_id and sv.user_id = auth.uid()
  left join ranked        r on r.game_id = i.game_id and r.user_id = auth.uid()
  order by last_played desc nulls last;
$$;

-- ═════════════════════════════════════════════════════════════
-- v3 · каталог в базе, загрузка игр через профиль, админ-права
-- ═════════════════════════════════════════════════════════════

-- ── кто может загружать игры ─────────────────────────────────
create table if not exists admins (
  user_id uuid primary key references auth.users on delete cascade,
  added_at timestamptz default now()
);

alter table admins enable row level security;

drop policy if exists "admins self read" on admins;
create policy "admins self read" on admins for select using (auth.uid() = user_id);

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

-- ── каталог ──────────────────────────────────────────────────
create table if not exists games (
  id text primary key,
  title text not null,
  title_en text,
  description text,
  description_en text,
  genre text,
  genre_en text,
  tag text,
  cover_url text,
  game_url text not null,
  featured boolean default false,
  published boolean default true,
  sort_order integer default 0,
  owner_id uuid references auth.users on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table games enable row level security;

drop policy if exists "games read" on games;
create policy "games read" on games for select
  using (published = true or is_admin());

drop policy if exists "games admin write" on games;
create policy "games admin write" on games for all
  using (is_admin()) with check (is_admin());

-- ── хранилище файлов ─────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('games', 'games', true, 52428800)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit)
values ('covers', 'covers', true, 5242880)
on conflict (id) do nothing;

drop policy if exists "files public read" on storage.objects;
create policy "files public read" on storage.objects for select
  using (bucket_id in ('games', 'covers'));

drop policy if exists "files admin upload" on storage.objects;
create policy "files admin upload" on storage.objects for insert
  with check (bucket_id in ('games', 'covers') and is_admin());

drop policy if exists "files admin update" on storage.objects;
create policy "files admin update" on storage.objects for update
  using (bucket_id in ('games', 'covers') and is_admin());

drop policy if exists "files admin delete" on storage.objects;
create policy "files admin delete" on storage.objects for delete
  using (bucket_id in ('games', 'covers') and is_admin());

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
