-- ============================================================
-- Web Push subscriptions. Each device stores its own push endpoint; the client
-- manages its own rows, Edge Functions (service role) read them to send pushes.
-- ============================================================
create table push_subscriptions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

create index push_subs_user_idx on push_subscriptions (user_id);

alter table push_subscriptions enable row level security;

create policy "manage own subs" on push_subscriptions for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
