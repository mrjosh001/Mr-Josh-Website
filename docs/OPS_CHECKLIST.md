# MJ Hub ops checklist

## You do in dashboards
1. Supabase backups enabled
2. Vercel env vars complete (SUPABASE, RESEND, OWLET, GRIZZLY, POCKETFI, CRON_SECRET, APP_URL)
3. Optional: Sentry DSN for error tracking
4. Optional: Upstash for global rate limits under heavy attack

## Added in repo
- lib/rateLimit.js
- lib/errors.js
- lib/secure.js cache helpers
- .github/workflows/ci.yml
- vercel.json security headers
