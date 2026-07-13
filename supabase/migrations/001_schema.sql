-- ============================================================
-- Texas Hold'em Online — initial schema
-- Apply with: supabase db push  (or paste into the SQL editor)
--
-- Design rules baked in here:
--   * Clients may READ their games, never write. All mutations go through Edge
--     Functions using the service role.
--   * HOLE CARDS ARE PRIVATE — a player may only read their own row.
--   * Every game mutation is gated by a `version` column (optimistic concurrency).
-- ============================================================

-- ---------- profiles ----------
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique not null check (char_length(username) between 2 and 16),
  avatar_seed text,
  chips       bigint not null default 10000,
  created_at  timestamptz not null default now()
);

-- Auto-create a profile row on signup.
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, avatar_seed)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'player_' || left(new.id::text, 6)),
    left(md5(new.id::text), 8)
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- games (one poker table; persists across many hands) ----------
create table games (
  id            uuid primary key default gen_random_uuid(),
  invite_code   text unique not null,
  status        text not null default 'lobby'
                check (status in ('lobby','active','finished','abandoned')),
  mode          text not null default 'async' check (mode in ('live','async')),
  stake_type    text not null default 'chips' check (stake_type in ('chips','ledger','none')),
  small_blind   integer not null default 1  check (small_blind >= 1),
  big_blind     integer not null default 2  check (big_blind >= 2),
  buy_in        integer not null default 200 check (buy_in >= 1),  -- starting stack
  -- live hand state:
  hand_no             integer not null default 0,
  button_seat         integer,                      -- dealer button
  street              text default 'idle'
                      check (street in ('idle','preflop','flop','turn','river','showdown')),
  board               smallint[] not null default '{}',  -- community cards (0..51), public
  current_seat        integer,                       -- whose action
  current_bet         integer not null default 0,    -- amount to call on this street
  min_raise           integer not null default 0,    -- min legal raise increment
  last_aggressor_seat integer,                        -- who to stop the round on
  pot                 integer not null default 0,     -- collected to the middle
  deck_hash           text,                           -- optional commit-reveal fairness
  turn_deadline       timestamptz,
  version             integer not null default 0,     -- optimistic concurrency gate
  created_by          uuid not null references profiles(id),
  winner_ids          uuid[],
  created_at          timestamptz not null default now(),
  finished_at         timestamptz
);

create index games_invite_code_idx on games (invite_code);
create index games_status_idx on games (status);

-- ---------- game_players (who's at the table; persists across hands) ----------
create table game_players (
  game_id     uuid not null references games(id) on delete cascade,
  player_id   uuid not null references profiles(id),
  seat        integer not null check (seat between 0 and 9),
  stack       integer not null default 0,   -- chips in front of them
  total_bet   integer not null default 0,   -- lifetime buy-ins + rebuys (for ledger)
  status      text not null default 'seated'
              check (status in ('seated','sitting_out','left')),
  -- per-hand state (reset each hand):
  in_hand     boolean not null default false,   -- dealt into current hand
  has_folded  boolean not null default false,
  street_bet  integer not null default 0,       -- chips committed on the current street
  has_acted   boolean not null default false,   -- acted since the last raise
  is_all_in   boolean not null default false,
  joined_at   timestamptz not null default now(),
  primary key (game_id, player_id),
  unique (game_id, seat)
);

create index game_players_player_idx on game_players (player_id);

-- ---------- hole_cards (PRIVATE — a player reads only their own row) ----------
create table hole_cards (
  game_id   uuid not null references games(id) on delete cascade,
  player_id uuid not null references profiles(id),
  hand_no   integer not null,
  cards     smallint[] not null,   -- two cards, 0..51
  primary key (game_id, player_id, hand_no)
);

-- ---------- actions (audit + replay + drives the action feed) ----------
create table actions (
  id         bigint generated always as identity primary key,
  game_id    uuid not null references games(id) on delete cascade,
  hand_no    integer not null,
  player_id  uuid references profiles(id),
  seat       integer,
  street     text,
  action     text not null
             check (action in ('post_sb','post_bb','fold','check','call','bet','raise','all_in','deal','win')),
  amount     integer not null default 0,
  created_at timestamptz not null default now()
);

create index actions_game_idx on actions (game_id, id);

-- ---------- showdowns (reveal shown hole cards; public only at showdown) ----------
create table showdowns (
  id         bigint generated always as identity primary key,
  game_id    uuid not null references games(id) on delete cascade,
  hand_no    integer not null,
  player_id  uuid not null references profiles(id),
  cards      smallint[] not null,
  hand_rank  text,
  won        integer not null default 0
);

create index showdowns_game_idx on showdowns (game_id, hand_no);

-- ---------- ledger_entries ----------
create table ledger_entries (
  id          bigint generated always as identity primary key,
  game_id     uuid not null references games(id) on delete cascade,
  player_id   uuid not null references profiles(id),
  amount      integer not null,   -- negative = paid in, positive = paid out
  reason      text not null
              check (reason in ('buy_in','rebuy','pot_win','zero_penalty')),
  created_at  timestamptz not null default now()
);

create index ledger_game_idx on ledger_entries (game_id);
create index ledger_player_idx on ledger_entries (player_id);

-- ============================================================
-- Row Level Security: clients may READ their games, never write.
-- All writes go through Edge Functions using the service role.
-- ============================================================
alter table profiles enable row level security;
alter table games enable row level security;
alter table game_players enable row level security;
alter table hole_cards enable row level security;
alter table actions enable row level security;
alter table showdowns enable row level security;
alter table ledger_entries enable row level security;

-- profiles: read anyone's public profile, update only your own (never chips).
create policy "profiles are readable" on profiles for select using (true);
create policy "update own profile" on profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id and chips = (select chips from profiles where id = auth.uid()));

-- helper: is the caller seated in this game?
create or replace function is_in_game(g uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from game_players where game_id = g and player_id = auth.uid());
$$;

create policy "read own games" on games for select
  using (is_in_game(id) or status = 'lobby');  -- lobby readable so invite links resolve

create policy "read seats in own games" on game_players for select
  using (is_in_game(game_id));

-- PRIVATE: a player may only ever read their OWN hole cards.
create policy "read own hole cards" on hole_cards for select
  using (player_id = auth.uid());

create policy "read actions in own games" on actions for select
  using (is_in_game(game_id));

create policy "read showdowns in own games" on showdowns for select
  using (is_in_game(game_id));

create policy "read ledger in own games" on ledger_entries for select
  using (is_in_game(game_id));

-- No insert/update/delete policies on game tables: deliberate.

-- ============================================================
-- Realtime: broadcast changes on the tables clients watch. hole_cards is in the
-- publication too, but RLS still limits each subscriber to their own row.
-- ============================================================
alter publication supabase_realtime add table games, game_players, actions, showdowns, hole_cards;
