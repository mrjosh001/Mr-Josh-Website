-- Enforce case-insensitive username uniqueness without rewriting legacy usernames.
create unique index if not exists profiles_username_ci_unique
  on public.profiles (lower(btrim(username)))
  where username is not null and btrim(username) <> '';
