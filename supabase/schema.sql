-- Same table the raid site uses; this app stores its data in its own row (STATE_ROW_ID, default 'money-main').
-- Only run if the table doesn't exist yet.
create table if not exists public.app_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
alter table public.app_state enable row level security;
