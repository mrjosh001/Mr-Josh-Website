import crypto from 'crypto';
import { getServiceSupabase, applyApiCors, handleOptions } from '../../lib/secure.js';
import { decryptWebhookSecret, signWebhookPayload } from '../../lib/reseller-webhooks.js';

const supabase = getServiceSupabase();

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export default async function handler(req, res) {
  applyApiCors(req, res, { methods: 'POST, OPTIONS' });
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

  const expected = String(process.env.RESELLER_WEBHOOK_DISPATCH_SECRET || '');
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || !safeEqual(expected, supplied)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { data: rows, error } = await supabase.rpc('reseller_claim_webhook_outbox', { p_batch_size: 25 });
  if (error) return res.status(503).json({ success: false, message: 'Webhook queue is unavailable' });

  let delivered = 0;
  let retried = 0;
  let dead = 0;
  for (const row of rows || []) {
    try {
      const { data: endpoint, error: endpointError } = await supabase.from('reseller_webhook_endpoints')
        .select('url,secret_ciphertext,status')
        .eq('id', row.endpoint_id).eq('reseller_id', row.reseller_id).maybeSingle();
      if (endpointError || !endpoint || endpoint.status !== 'active') throw new Error('Webhook endpoint unavailable');
      const target = new URL(endpoint.url);
      if (target.protocol !== 'https:' || ['localhost','127.0.0.1','::1'].includes(target.hostname)) throw new Error('Webhook URL must use public HTTPS');
      const secret = decryptWebhookSecret(endpoint.secret_ciphertext);
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({ id: row.id, type: row.event_type, created_at: row.created_at, data: row.payload });
      const signature = signWebhookPayload(secret, timestamp, rawBody);
      const response = await fetch(target.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MJ-Event': row.event_type,
          'X-MJ-Delivery': row.id,
          'X-MJ-Timestamp': String(timestamp),
          'X-MJ-Signature': signature
        },
        body: rawBody,
        signal: AbortSignal.timeout(10000),
        redirect: 'manual'
      });
      if (!response.ok) throw new Error('Webhook receiver returned HTTP ' + response.status);
      await supabase.from('reseller_webhook_outbox').update({
        status: 'delivered', delivered_at: new Date().toISOString(),
        last_http_status: response.status, last_error: null
      }).eq('id', row.id);
      delivered++;
    } catch (error) {
      const attempts = Number(row.attempts || 1);
      const terminal = attempts >= 10;
      const delaySeconds = Math.min(3600, 15 * (2 ** Math.min(attempts - 1, 8)));
      await supabase.from('reseller_webhook_outbox').update({
        status: terminal ? 'dead' : 'pending',
        next_attempt_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
        last_error: String(error?.message || 'Delivery failed').slice(0, 500)
      }).eq('id', row.id);
      if (terminal) dead++; else retried++;
    }
  }
  return res.status(200).json({ success: true, claimed: (rows || []).length, delivered, retried, dead });
}
