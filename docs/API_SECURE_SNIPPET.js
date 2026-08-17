/**
 * Drop this near the top of any api/*.js handler (after imports).
 * Example — api/order.js / api/owlet.js / api/grizzly-sync.js
 */

import { applyApiCors, handleOptions, rejectClientSuppliedSecrets, requireUser } from '../lib/secure.js';
import { getSecret, getSecretCandidates, requireSecrets } from '../lib/secrets.js';

export default async function handler(req, res) {
  applyApiCors(req, res);
  if (handleOptions(req, res)) return;
  if (!rejectClientSuppliedSecrets(req, res)) return;

  // User actions (orders, deposits):
  // const auth = await requireUser(req);
  // if (auth.error) return res.status(auth.error.status).json({ success: false, message: auth.error.message });

  // Supplier key with rotation support:
  // const keys = getSecretCandidates('GRIZZLYSMS_API_KEY');
  // if (!keys.length) return res.status(500).json({ success: false, message: 'Supplier not configured' });

  // Existing code can keep using process.env.FOO — it remains valid.
  // Prefer getSecret('FOO') for clearer errors when missing.
}
