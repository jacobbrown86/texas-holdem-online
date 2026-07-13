-- ============================================================
-- Table chat. Unlike game tables, players may INSERT their own messages
-- directly (RLS-guarded) — chat isn't game state, so no Edge Function needed.
-- ============================================================
create table messages (
  id          bigint generated always as identity primary key,
  game_id     uuid not null references games(id) on delete cascade,
  sender      uuid not null references profiles(id),
  body        text not null check (char_length(body) between 1 and 500),
  created_at  timestamptz not null default now()
);

create index messages_game_idx on messages (game_id, id);

alter table messages enable row level security;

-- Read/send only within games you're seated in; you can only send as yourself.
create policy "read messages in my games" on messages for select
  using (is_in_game(game_id));
create policy "send messages to my games" on messages for insert
  with check (sender = auth.uid() and is_in_game(game_id));

alter publication supabase_realtime add table messages;
