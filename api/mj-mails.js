import { createClient } from '@supabase/supabase-js';
import { handleMjMails } from '../lib/mj-mails.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function json(res, status, payload) {
  return res.status(status).json(payload);
}

async function requireAuth(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token.includes('service_role')) {
    return { ok: false, status: 401, message: 'Please sign in to continue' };
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.id) {
    return { ok: false, status: 401, message: 'Please sign in to continue' };
  }
  return { ok: true, userId: data.user.id };
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/api/mj-mails', 'https://' + (req.headers.host || 'localhost'));
  if (!['GET', 'POST'].includes(String(req.method || 'GET').toUpperCase())) {
    return json(res, 405, { success: false, message: 'Method not allowed' });
  }
  try {
    return await handleMjMails({ req, res, url, supabase, requireAuth, json });
  } catch (error) {
    console.error('[mj-mails route]', error?.message || error);
    return json(res, 500, { success: false, message: 'MJ Mails is temporarily unavailable. Please try again.' });
  }
}
