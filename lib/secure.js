/**
 * MJ Hub — request hardening helpers for Vercel serverless API routes.
 * Server-only. Do not import from browser code.
 */

import { createClient } from '@supabase/supabase-js';
import { getSecret, getSecretCandidates } from './secrets.js';

const SERVICE_ROLE_PATTERNS = [
  /service_role/i,
  /SERVICE_ROLE/,
  /supabase_service/i,
];

const DANGEROUS_BODY_KEYS = [
  'service_role_key',
  'serviceRoleKey',
  'supabase_service_role',
  'SUPABASE_SERVICE_ROLE_KEY',
  'grizzly_api_key',
  'GRIZZLYSMS_API_KEY',
  'owlet_api_key',
  'OWLET_API_KEY',
  'pocketfi_secret',
  'POCKETFI_SECRET_KEY',
  'fadded_api_key',
  'FADDED_API_KEY',
  'logsdomain_api_key',
  'LOGSDOMAIN_API_KEY',
  'sujan_api_key',
  'SUJAN_API_KEY',
  'cron_secret',
  'CRON_SECRET',
];

/**
 * Reject requests that try to smuggle server secrets from the client.
 * Call near the top of sensitive handlers.
 */
export function rejectClientSuppliedSecrets(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const query = req.query && typeof req.query === 'object' ? req.query : {};
  const bags = [body, query];

  for (const bag of bags) {
    for (const key of Object.keys(bag)) {
      if (DANGEROUS_BODY_KEYS.includes(key) || SERVICE_ROLE_PATTERNS.some((re) => re.test(key))) {
        res.status(400).json({
          success: false,
          message: 'Invalid request: server secrets must not be sent from the client.',
        });
        return false;
      }
      const val = bag[key];
      if (typeof val === 'string' && val.length > 20) {
        // Block obvious JWT service_role payloads pasted into forms
        if (val.includes('service_role') || /eyJhbGciOi.*service_role/i.test(val)) {
          res.status(400).json({
            success: false,
            message: 'Invalid request payload.',
          });
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * CORS for browser → /api calls. Secrets still never leave the server.
 */
export function applyApiCors(req, res, { methods = 'GET, POST, OPTIONS' } = {}) {
  const origin = req.headers.origin || '';
  const allowed = (process.env.CORS_ALLOWED_ORIGINS || process.env.APP_URL || process.env.SITE_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowed.length === 0) {
    // Default: reflect only same-site style when unset (tighten in production via env)
    if (origin && /\.mjhub\.|mjhub\.store|localhost|127\.0\.0\.1/i.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  } else if (allowed.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

export function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    applyApiCors(req, res);
    res.status(204).end();
    return true;
  }
  return false;
}

/** Service-role Supabase client (server only). */
export function getServiceSupabase() {
  const url = getSecret('SUPABASE_URL', { required: true });
  const key = getSecret('SUPABASE_SERVICE_ROLE_KEY', { required: true });
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Validate Authorization: Bearer <user access token> and return user.
 * Does not accept service_role tokens from the client.
 */
export async function requireUser(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const m = String(header).match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return { error: { status: 401, message: 'Missing Authorization bearer token' } };
  }
  const token = m[1].trim();
  if (!token || token.includes('service_role')) {
    return { error: { status: 401, message: 'Invalid token' } };
  }

  const supabase = getServiceSupabase();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return { error: { status: 401, message: 'Invalid or expired session' } };
  }
  return { user: data.user, token, supabase };
}

/**
 * Require signed-in user whose profiles.is_admin is true.
 */
export async function requireAdmin(req) {
  const result = await requireUser(req);
  if (result.error) return result;

  const { data: profile, error } = await result.supabase
    .from('profiles')
    .select('id, email, full_name, is_admin')
    .eq('id', result.user.id)
    .maybeSingle();

  if (error) {
    return { error: { status: 500, message: 'Could not verify admin' } };
  }
  const admin =
    profile &&
    (profile.is_admin === true ||
      profile.is_admin === 'true' ||
      profile.is_admin === 1 ||
      profile.is_admin === '1');
  if (!admin) {
    return { error: { status: 403, message: 'Admin privileges required' } };
  }
  return { ...result, profile };
}

/**
 * Cron / internal jobs: Authorization: Bearer <CRON_SECRET>
 * Supports CRON_SECRET_PREVIOUS during rotation.
 */
export function requireCron(req) {
  const header = req.headers.authorization || '';
  const m = String(header).match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : '';
  const candidates = getSecretCandidates('CRON_SECRET');
  if (!candidates.length) {
    return { error: { status: 503, message: 'CRON_SECRET not configured' } };
  }
  if (!token || !candidates.includes(token)) {
    return { error: { status: 401, message: 'Unauthorized cron request' } };
  }
  return { ok: true };
}

/**
 * Prefer user JWT; allow cron secret for scheduled sync routes.
 */
export async function requireAdminOrCron(req) {
  const cron = requireCron(req);
  if (cron.ok) return { cron: true };
  return requireAdmin(req);
}

export default {
  rejectClientSuppliedSecrets,
  applyApiCors,
  handleOptions,
  getServiceSupabase,
  requireUser,
  requireAdmin,
  requireCron,
  requireAdminOrCron,
};
