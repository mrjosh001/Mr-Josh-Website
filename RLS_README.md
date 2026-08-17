# Apply RLS lockdown

1. Open Supabase Dashboard → SQL Editor
2. Paste entire `rls_lockdown.sql` → Run
3. Deploy updated `dashboard.html` (currency convert uses secure RPC)
4. Test as normal user + admin

## What this does
- Enables RLS on all MJ Hub tables
- Users only see their own money/orders/support
- Blocks client changes to balance / is_admin / is_banned
- Admins (is_admin) can still use admin panel with publishable key
- Service role APIs unchanged (bypass RLS)
- `mj_convert_balance` RPC for safe NGN↔USD convert
