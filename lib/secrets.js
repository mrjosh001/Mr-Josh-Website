/**
 * MJ Hub — server-side secret management (Vercel / Node only)
 *
 * RULES
 * 1. Never import this file from browser HTML/JS.
 * 2. Never log return values of getSecret / getSecretCandidates.
 * 3. Supplier keys live only in Vercel Environment Variables.
 * 4. Rotation: set NEW value on PRIMARY, keep OLD on *_PREVIOUS for a short window.
 *
 * Usage:
 *   import { getSecret, getSecretCandidates, requireSecrets, secretsStatus } from '../lib/secrets.js';
 *   const key = getSecret('GRIZZLYSMS_API_KEY');
 *   // During rotation, try candidates in order:
 *   for (const k of getSecretCandidates('GRIZZLYSMS_API_KEY')) { ... }
 */

const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

/** @type {Record<string, { required?: boolean, description?: string }>} */
export const SECRET_CATALOG = {
  SUPABASE_URL: { required: true, description: 'Supabase project URL' },
  SUPABASE_SERVICE_ROLE_KEY: {
    required: true,
    description: 'Supabase service role — NEVER expose to the browser',
  },
  SUPABASE_ANON_KEY: {
    required: false,
    description: 'Optional server copy of anon key (browser may use publishable/anon separately)',
  },

  GRIZZLYSMS_API_KEY: { required: false, description: 'GrizzlySMS supplier API key' },
  LOGSDOMAIN_API_KEY: { required: false, description: 'LogsDomain supplier API key' },
  FADDED_API_KEY: { required: false, description: 'Fadded / logs product supplier key' },
  SUJAN_API_KEY: { required: false, description: 'Sujan supplier API key' },
  OWLET_API_KEY: { required: false, description: 'Owlet SMM panel API key' },
  OWLET_API_URL: { required: false, description: 'Owlet panel base URL' },

  POCKETFI_SECRET_KEY: { required: false, description: 'PocketFi secret (server only)' },
  POCKETFI_PUBLIC_KEY: { required: false, description: 'PocketFi public key' },
  POCKETFI_BUSINESS_ID: { required: false, description: 'PocketFi business id' },
  POCKETFI_WEBHOOK_SECRET: { required: false, description: 'PocketFi webhook HMAC secret' },
  POCKETFI_API_BASE: { required: false, description: 'PocketFi API base URL override' },

  CRON_SECRET: {
    required: false,
    description: 'Bearer token for Vercel cron / internal job routes',
  },
  APP_URL: { required: false, description: 'Canonical app URL e.g. https://app.mjhub.store' },
  SITE_URL: { required: false, description: 'Public site URL for redirects' },
};

function clean(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Read a single env secret.
 * @param {string} name
 * @param {{ required?: boolean }} [opts]
 * @returns {string}
 */
export function getSecret(name, opts = {}) {
  const meta = SECRET_CATALOG[name] || {};
  const required = opts.required != null ? opts.required : !!meta.required;
  const value = clean(process.env[name]);
  if (!value && required) {
    const err = new Error(`Missing required secret: ${name}`);
    err.code = 'MISSING_SECRET';
    throw err;
  }
  return value;
}

/**
 * Primary + previous values for zero-downtime rotation.
 * Set FOO=newKey and FOO_PREVIOUS=oldKey in Vercel, deploy, then remove PREVIOUS later.
 * @param {string} name
 * @returns {string[]} non-empty unique candidates, primary first
 */
export function getSecretCandidates(name) {
  const primary = clean(process.env[name]);
  const previous = clean(process.env[`${name}_PREVIOUS`]);
  const out = [];
  if (primary) out.push(primary);
  if (previous && previous !== primary) out.push(previous);
  return out;
}

/**
 * First configured candidate or throws if required.
 * @param {string} name
 * @param {{ required?: boolean }} [opts]
 */
export function getRotatableSecret(name, opts = {}) {
  const candidates = getSecretCandidates(name);
  if (candidates.length) return candidates[0];
  const meta = SECRET_CATALOG[name] || {};
  const required = opts.required != null ? opts.required : !!meta.required;
  if (required) {
    const err = new Error(`Missing required secret: ${name}`);
    err.code = 'MISSING_SECRET';
    throw err;
  }
  return '';
}

/**
 * Assert a list of secrets exist (empty string fails).
 * @param {string[]} names
 */
export function requireSecrets(names) {
  const missing = [];
  for (const name of names) {
    if (!clean(process.env[name])) missing.push(name);
  }
  if (missing.length) {
    const err = new Error(`Missing secrets: ${missing.join(', ')}`);
    err.code = 'MISSING_SECRETS';
    err.missing = missing;
    throw err;
  }
}

/**
 * Safe status for ops dashboards — booleans only, never values.
 * @returns {Record<string, { configured: boolean, hasPrevious: boolean, required: boolean }>}
 */
export function secretsStatus() {
  const status = {};
  for (const [name, meta] of Object.entries(SECRET_CATALOG)) {
    status[name] = {
      configured: !!clean(process.env[name]),
      hasPrevious: !!clean(process.env[`${name}_PREVIOUS`]),
      required: !!meta.required,
    };
  }
  return status;
}

/**
 * Mask a secret for rare debug logs (still avoid logging when possible).
 * @param {string} value
 */
export function maskSecret(value) {
  const s = clean(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 3)}…${s.slice(-3)} (len=${s.length})`;
}

export function assertServerOnly() {
  if (typeof window !== 'undefined') {
    throw new Error('lib/secrets.js must never run in the browser');
  }
}

assertServerOnly();

export default {
  SECRET_CATALOG,
  getSecret,
  getSecretCandidates,
  getRotatableSecret,
  requireSecrets,
  secretsStatus,
  maskSecret,
  isProd,
};
