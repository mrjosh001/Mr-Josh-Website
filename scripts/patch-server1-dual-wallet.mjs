// Wallet checkout protections are maintained directly in api/grizzly-sync.js
// and api/sms-bus.js. This build hook is intentionally idempotent: older
// versions attempted to regex-rewrite those files on every deployment and
// failed once the source had already been upgraded. Keep the hook as a no-op
// so Vercel builds the committed source exactly as reviewed.
console.log('SMS wallet fixes are already present in source; no build-time patch required.');
