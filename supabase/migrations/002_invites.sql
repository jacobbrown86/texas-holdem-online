-- ============================================================
-- Invites: a host invites a known player (by username) to a lobby game.
-- Writes happen only through the invite-player Edge Function (service role).
-- ============================================================
create table invites (
  id          bigint generated always as identity primary key,
  game_id     uuid not null references games(id) on delete cascade,
  inviter     uuid not null references profiles(id),
  invitee     uuid not null references profiles(id),
  status      text not null default 'pending'
              check (status in ('pending','accepted','declined')),
  created_at  timestamptz not null default now(),
  unique (game_id, invitee)
);

create index invites_invitee_idx on invites (invitee, status);

alter table invites enable row level security;

-- You can read invites you sent or received. No client writes (function only).
create policy "read my invites" on invites for select
  using (invitee = auth.uid() or inviter = auth.uid());

alter publication supabase_realtime add table invites;
