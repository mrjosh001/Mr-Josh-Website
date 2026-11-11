import crypto from 'crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getServiceSupabase, applyApiCors, handleOptions } from '../../lib/secure.js';
import { decryptWebhookSecret, signWebhookPayload } from '../../lib/reseller-webhooks.js';

const supabase = getServiceSupabase();

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}


function isPublicIPv4(ip) {
  const parts=ip.split('.').map(Number);
  if(parts.length!==4 || parts.some(n=>!Number.isInteger(n)||n<0||n>255)) return false;
  const [a,b]=parts;
  return !(a===0 || a===10 || a===127 || a>=224 ||
    (a===100 && b>=64 && b<=127) || (a===169 && b===254) ||
    (a===172 && b>=16 && b<=31) || (a===192 && b===168) ||
    (a===192 && b===0) || (a===198 && (b===18 || b===19 || b===51)) ||
    (a===203 && b===0));
}
function isPublicIPv6(ip) {
  const value=ip.toLowerCase().split('%')[0];
  if(value.startsWith('::ffff:')) {
    const mapped=value.slice(7);
    if(mapped.includes('.')) return isPublicIPv4(mapped);
    return false;
  }
  const first=parseInt(value.split(':')[0] || '0',16);
  // Restrict webhook destinations to global-unicast space. Exclude documentation space.
  return Number.isFinite(first) && first>=0x2000 && first<=0x3fff &&
    !value.startsWith('2001:db8:') && !value.startsWith('2001:0db8:');
}
async function assertPublicHttpsTarget(target) {
  if(target.protocol!=='https:' || target.username || target.password ||
     (target.port && target.port!=='443') || !target.hostname) {
    throw new Error('Webhook URL must be HTTPS on the standard port without embedded credentials');
  }
  const hostname=target.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(hostname==='localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Webhook URL must resolve to a public host');
  }
  const literalType=isIP(hostname);
  if(literalType) {
    const publicAddress=literalType===4?isPublicIPv4(hostname):isPublicIPv6(hostname);
    if(!publicAddress) throw new Error('Webhook URL must resolve to a public host');
    return;
  }
  const addresses=await lookup(hostname,{all:true,verbatim:true});
  if(!addresses.length || addresses.some(item => {
    const type=isIP(item.address);
    return type===4?!isPublicIPv4(item.address):type===6?!isPublicIPv6(item.address):true;
  })) throw new Error('Webhook hostname must resolve only to public IP addresses');
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
      await assertPublicHttpsTarget(target);
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
