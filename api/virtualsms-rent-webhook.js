import { createClient } from '@supabase/supabase-js';
import { handleVirtualSmsRental } from '../lib/virtualsms-rental.js';

// Keep the exact supplier-signed bytes. JSON body parsing would invalidate HMAC verification.
export const config = { api: { bodyParser: false } };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function json(res, status, body) {
  return res.status(status).json(body);
}

async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody, 'utf8');
  if (req.rawBody instanceof Uint8Array) return Buffer.from(req.rawBody);

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { success: false, message: 'Method not allowed.' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(res, 500, { success: false, message: 'Webhook storage is unavailable.' });
  }

  try {
    const url = new URL(req.url, 'https://app.mjhub.store');
    return await handleVirtualSmsRental({
      req, res, url, action: 'vsrent_webhook', method: 'POST',
      supabase, json, readRawBody
    });
  } catch (error) {
    console.error('[virtualsms rental webhook]', error?.message || error);
    return json(res, 500, { success: false, message: 'Webhook processing failed.' });
  }
}
