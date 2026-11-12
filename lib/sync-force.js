/**
 * lib/sync-force.js — stop the admin "Sync Server 3" / "Sync Server 4" buttons from restarting every pass.
 *
 * admin.html sends `force=1` on EVERY batch of its loop. On the server `force=1` means "ignore the saved
 * cursor and ignore the running-lock", so each batch restarted from the beginning of the catalog and a batch
 * that outlived the browser's abort kept running while the next one started on top of it. Net effect: the
 * cursor never advanced from the admin buttons (only the cron, which sends no force, moved it).
 *
 * For manual (admin) calls, `force=1` is now honoured ONLY when it is safe:
 *   - no run of that sync is currently active (status 'running' and touched in the last 6 min), and
 *   - no cycle is in progress (saved cursor > 0 and touched in the last 30 min).
 * Otherwise `force` is dropped, so the batch continues from the saved cursor or reports "busy".
 * `force=restart` is the explicit override (restart now, ignore the lock).
 *
 * Called from requireAdminOrCron() in lib/secure.js. Cron requests never reach this (they send no force).
 */

const JOB_KEYS = {
  vsms_sync: 'virtualsms',
  virtualsms_sync: 'virtualsms',
  server3_sync: 'virtualsms',
  hero_sync: 'herosms'
};
const LOCK_MS = 6 * 60 * 1000;
const CYCLE_MS = 30 * 60 * 1000;

export async function normalizeSyncForce(req, supabase) {
  try {
    const q = req && req.query;
    if (!q || typeof q !== 'object' || !supabase) return;
    const jobKey = JOB_KEYS[String(q.action || '').toLowerCase()];
    if (!jobKey) return;
    const f = String(q.force == null ? '' : q.force).toLowerCase();
    if (f === 'restart') { q.force = '1'; return; }
    if (f !== '1' && f !== 'true') return;

    const { data } = await supabase
      .from('sync_jobs')
      .select('status, updated_at, cursor_index')
      .eq('source', jobKey)
      .maybeSingle();
    if (!data || !data.updated_at) return;

    const age = Date.now() - new Date(data.updated_at).getTime();
    const running = data.status === 'running' && age < LOCK_MS;
    const midCycle = Number(data.cursor_index) > 0 && age < CYCLE_MS;
    if (running || midCycle) delete q.force;
  } catch (_) {
    /* never block a sync because of this helper */
  }
}
