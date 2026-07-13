-- ============================================================
-- Realtime + RLS need REPLICA IDENTITY FULL to deliver UPDATE/DELETE events
-- (so the row can be RLS-checked per subscriber). Without this, only INSERTs
-- propagate — which is why mid-hand turn/pot/stack UPDATEs wouldn't reach clients.
-- The client also polls every 3s as a safety net, but this makes it instant.
-- ============================================================
alter table games        replica identity full;
alter table game_players replica identity full;
alter table actions      replica identity full;
alter table invites      replica identity full;
