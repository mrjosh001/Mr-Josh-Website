-- Preserve the financial refund audit row while anonymizing its user link
-- when a customer deletes their MJ HUB profile.
alter table public.booster_refund_credits
  alter column user_id drop not null;

alter table public.booster_refund_credits
  drop constraint if exists booster_refund_credits_user_id_fkey;

alter table public.booster_refund_credits
  add constraint booster_refund_credits_user_id_fkey
  foreign key (user_id) references public.profiles(id)
  on delete set null;
