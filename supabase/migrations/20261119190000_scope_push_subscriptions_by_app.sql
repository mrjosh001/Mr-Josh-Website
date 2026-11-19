alter table public.push_subscriptions
  add column if not exists app_id text not null default 'main';

create index if not exists push_subscriptions_user_app_idx
  on public.push_subscriptions (user_id, app_id);
