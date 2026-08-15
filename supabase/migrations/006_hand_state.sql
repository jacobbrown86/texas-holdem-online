-- ============================================================
-- Private per-hand deck state. Holds the 5 community cards pre-dealt at the
-- start of a hand, revealed onto games.board progressively (flop/turn/river).
--
-- CRITICAL: this table has RLS enabled and NO policies, so clients can NEVER
-- read it — the unrevealed board must stay secret. Only Edge Functions (service
-- role, which bypasses RLS) read it. It is deliberately NOT in the realtime
-- publication.
-- ============================================================
create table hand_state (
  game_id   uuid not null references games(id) on delete cascade,
  hand_no   integer not null,
  board     smallint[] not null,   -- the 5 community cards for this hand (0..51)
  primary key (game_id, hand_no)
);

alter table hand_state enable row level security;
-- No policies on purpose: no client may select/insert/update/delete.
