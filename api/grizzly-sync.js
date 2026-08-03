import { createClient } from '@supabase/supabase-js';

/**
 * GET /api/grizzly-sync
 * Admin-only. Pulls the country + price/stock catalog from GrizzlySMS
 * (sms-activate-compatible protocol) and upserts into number_services with
 * source='grizzlysms'.
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS:
 * GrizzlySMS has ~150-200 countries, each with its own service list. The
 * original version of this file looped over every country and did the DB
 * upsert for every service sequentially, inside one request. That's
 * thousands of sequential steps in a single invocation — it always blew
 * past Vercel's function execution limit, got killed mid-flight, and the
 * browser reported that as a generic "Load failed". You'd also see it as
 * repeated 500s in the Vercel function logs.
 *
 * Fix: this now does ONE CHUNK OF WORK per call, time-boxed to stay safely
 * under any Vercel plan's limit, and saves its cursor position in the
 * "sync_jobs" table between calls. Calling it again resumes from where it
 * left off — it does not restart from country 0. That also means a sync
 * survives the admin dashboard being refreshed or closed: progress lives in
 * the database, not in the browser tab. admin.html calls this in a loop
 * (?action=start once, then repeated plain calls) while the tab is open,
 * and on page load it checks for an already-"running" job and resumes
 * polling it automatically instead of losing progress.
 *
 * Requires this table (run once in the Supabase SQL editor):
 *
 *   create table if not exists sync_jobs (
 *     source text primary key,
 *     status text not null default 'idle',
 *     cursor_index int not null default 0,
 *     total_countries int,
 *     new_count int not null default 0,
 *     updated_count int not null default 0,
 *     services_seen int not null default 0,
 *     errors jsonb default '[]'::jsonb,
 *     started_at timestamptz,
 *     updated_at timestamptz default now()
 *   );
 *
 * DAILY CRON:
 * Vercel invokes crons with an `Authorization: Bearer <CRON_SECRET>` header.
 * Requests carrying that header skip the admin-session check below and are
 * treated as a trusted, unattended run. On a cron hit, if no sync is already
 * "running" this function auto-starts a fresh one and immediately begins
 * processing — it doesn't just return the "call ?action=start" message like
 * a stray unauthenticated request would. It also uses a much bigger time
 * budget than the browser-driven chunk size (see CRON_TIME_BUDGET_MS below),
 * since Vercel Hobby functions now get 300s instead of ~10s, which is enough
 * to get through most or all countries in one invocation. If it ever doesn't
 * finish in one run, the cursor is saved as usual and next day's cron just
 * picks up where it left off.
 *
 * Setup: add an environment variable named CRON_SECRET (any random 16+ char
 * string) in your Vercel project settings — Vercel does not create this for
 * you automatically, but once it exists Vercel sends it on every cron call.
 *
 * Env: GRIZZLYSMS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
 */

const BASE = 'https://api.grizzlysms.com/stubs/handler_api.php';
const JOB_SOURCE = 'grizzlysms';
// Manual/browser-driven chunk size — small on purpose so the admin dashboard
// stays responsive while polling in a loop (see admin.html pollGrizzlySync).
const MANUAL_TIME_BUDGET_MS = 8000;
// Cron-driven chunk size — cron has no UI waiting on it, so let one
// invocation do as much as it safely can within Hobby's 300s ceiling.
// Leaves ~20s of headroom for the in-flight request + final DB write.
const CRON_TIME_BUDGET_MS = 280000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function requireAdmin(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { ok: false, status: 401, message: 'Missing admin session' };

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return { ok: false, status: 401, message: 'Invalid session' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .maybeSingle();

  const isAdmin = profile && (profile.is_admin === true || profile.is_admin === 'true' || profile.is_admin === 1);
  if (!isAdmin) return { ok: false, status: 403, message: 'Admin privileges required' };
  return { ok: true };
}

function applyMarkup(supplierPriceUsd, usdToNgn) {
  const percent = 50 + Math.random() * 50;
  const ngn = Number(supplierPriceUsd) * usdToNgn;
  const finalPrice = Math.ceil(ngn * (1 + percent / 100));
  return Math.ceil(finalPrice / 50) * 50;
}

async function callGrizzly(apiKey, params) {
  const qs = new URLSearchParams({ api_key: apiKey, ...params });
  const res = await fetch(`${BASE}?${qs.toString()}`, { method: 'GET' });
  const text = await res.text();
  return { status: res.status, text };
}

async function getJob() {
  const { data, error } = await supabase.from('sync_jobs').select('*').eq('source', JOB_SOURCE).maybeSingle();
  if (error) {
    throw new Error(`sync_jobs table error: ${error.message}. If this says the relation/table doesn't exist, run the "create table sync_jobs" SQL from the top of this file in your Supabase SQL editor first.`);
  }
  return data;
}

async function upsertJob(fields) {
  const { error } = await supabase.from('sync_jobs').upsert({ source: JOB_SOURCE, updated_at: new Date().toISOString(), ...fields });
  if (error) {
    throw new Error(`sync_jobs write failed: ${error.message}. If this says the relation/table doesn't exist, run the "create table sync_jobs" SQL from the top of this file in your Supabase SQL editor first.`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, message: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
  }
  if (!process.env.GRIZZLYSMS_API_KEY) {
    return res.status(500).json({ success: false, message: 'Missing GRIZZLYSMS_API_KEY' });
  }

  const authHeader = req.headers.authorization || '';
  const isCronRequest = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isCronRequest) {
    const admin = await requireAdmin(req);
    if (!admin.ok) return res.status(admin.status).json({ success: false, message: admin.message });
  }

  const apiKey = process.env.GRIZZLYSMS_API_KEY;
  const usdToNgn = Number(process.env.USD_TO_NGN_RATE) || 1420;
  const action = req.query?.action || null; // 'start' | 'status' | (default: continue/step)

  try {
    // --- status check only, no work done ---
    if (action === 'status') {
      const job = await getJob();
      return res.status(200).json({ success: true, job: job || { source: JOB_SOURCE, status: 'idle' } });
    }

    // --- (re)start: fetch the country list fresh, reset the cursor ---
    if (action === 'start') {
      const countriesRes = await callGrizzly(apiKey, { action: 'getCountries' });
      if (countriesRes.text === 'BAD_KEY') {
        return res.status(401).json({ success: false, message: 'GrizzlySMS rejected the API key (BAD_KEY)' });
      }
      let countries;
      try {
        countries = JSON.parse(countriesRes.text);
      } catch {
        return res.status(502).json({
          success: false,
          message: 'getCountries did not return JSON — check GRIZZLYSMS_API_KEY and raw response',
          raw: countriesRes.text.slice(0, 500)
        });
      }
      const countryList = Array.isArray(countries)
        ? countries
        : Object.entries(countries || {}).map(([id, c]) => ({ id, ...(typeof c === 'object' ? c : { name: c }) }));

      await upsertJob({
        status: 'running',
        cursor_index: 0,
        total_countries: countryList.length,
        new_count: 0,
        updated_count: 0,
        services_seen: 0,
        errors: [],
        started_at: new Date().toISOString()
      });

      return res.status(200).json({
        success: true,
        started: true,
        total_countries: countryList.length,
        message: `Sync started — ${countryList.length} countries queued. Keep calling without ?action=start to advance it, or just leave the dashboard open.`
      });
    }

    // --- default: process a time-boxed chunk of whatever job is running ---
    let job = await getJob();

    // A cron hit is unattended — nobody is going to call ?action=start for
    // it. If nothing is currently running, start a fresh job right here and
    // fall through into processing it in this same invocation.
    if (isCronRequest && (!job || job.status !== 'running')) {
      const startCountriesRes = await callGrizzly(apiKey, { action: 'getCountries' });
      if (startCountriesRes.text === 'BAD_KEY') {
        return res.status(401).json({ success: false, message: 'GrizzlySMS rejected the API key (BAD_KEY)' });
      }
      let startCountries;
      try {
        startCountries = JSON.parse(startCountriesRes.text);
      } catch {
        return res.status(502).json({
          success: false,
          message: 'getCountries did not return JSON — check GRIZZLYSMS_API_KEY and raw response',
          raw: startCountriesRes.text.slice(0, 500)
        });
      }
      const startCountryList = Array.isArray(startCountries)
        ? startCountries
        : Object.entries(startCountries || {}).map(([id, c]) => ({ id, ...(typeof c === 'object' ? c : { name: c }) }));

      await upsertJob({
        status: 'running',
        cursor_index: 0,
        total_countries: startCountryList.length,
        new_count: 0,
        updated_count: 0,
        services_seen: 0,
        errors: [],
        started_at: new Date().toISOString()
      });
      job = await getJob();
    }

    if (!job || job.status !== 'running') {
      return res.status(200).json({ success: true, done: true, idle: true, message: 'No sync is currently running. Call ?action=start to begin one.' });
    }

    // Re-fetch the country list each chunk (cheap single call) and slice by
    // the saved cursor — simpler and safer than persisting the whole list.
    const countriesRes = await callGrizzly(apiKey, { action: 'getCountries' });
    let countries;
    try {
      countries = JSON.parse(countriesRes.text);
    } catch {
      await upsertJob({ status: 'failed', errors: [...(job.errors || []), 'getCountries failed mid-sync'] });
      return res.status(502).json({ success: false, message: 'getCountries did not return JSON mid-sync' });
    }
    const countryList = Array.isArray(countries)
      ? countries
      : Object.entries(countries || {}).map(([id, c]) => ({ id, ...(typeof c === 'object' ? c : { name: c }) }));

    const TIME_BUDGET_MS = isCronRequest ? CRON_TIME_BUDGET_MS : MANUAL_TIME_BUDGET_MS;
    const startedAt = Date.now();
    let cursor = job.cursor_index || 0;
    let newCount = job.new_count || 0;
    let updatedCount = job.updated_count || 0;
    let servicesSeen = job.services_seen || 0;
    const errors = Array.isArray(job.errors) ? [...job.errors] : [];

    while (cursor < countryList.length && (Date.now() - startedAt) < TIME_BUDGET_MS) {
      const country = countryList[cursor];
      cursor += 1;
      const countryId = parseInt(country.id, 10);
      if (!Number.isFinite(countryId)) continue;
      const countryName = country.eng || country.name || country.rus || `Country ${countryId}`;

      const pricesRes = await callGrizzly(apiKey, { action: 'getPricesV3', country: String(countryId) });
      let priceData;
      try {
        priceData = JSON.parse(pricesRes.text);
      } catch {
        errors.push(`country ${countryId}: getPricesV3 did not return JSON`);
        continue;
      }

      const countryPrices = priceData?.[String(countryId)] || priceData?.[countryId] || {};

      for (const [serviceCode, info] of Object.entries(countryPrices)) {
        servicesSeen += 1;
        if (!serviceCode) continue;

        const supplierPriceUsd = Number(info?.price ?? 0);
        const availableQty = Number(info?.count ?? 0);
        const providersRaw = info?.providers && typeof info.providers === 'object' ? info.providers : null;

        const { data: existing } = await supabase
          .from('number_services')
          .select('id')
          .eq('source', 'grizzlysms')
          .eq('country_id', countryId)
          .eq('service_id', serviceCode)
          .maybeSingle();

        if (existing) {
          updatedCount += 1;
          const { error } = await supabase
            .from('number_services')
            .update({
              country_name: countryName,
              service_name: serviceCode,
              supplier_price: supplierPriceUsd,
              available_quantity: availableQty,
              providers_raw: providersRaw,
              is_available: availableQty > 0,
              updated_at: new Date().toISOString()
            })
            .eq('id', existing.id);
          if (error) errors.push(`update ${countryId}/${serviceCode}: ${error.message}`);
        } else {
          newCount += 1;
          const { error } = await supabase
            .from('number_services')
            .insert({
              source: 'grizzlysms',
              country_id: countryId,
              country_name: countryName,
              service_id: serviceCode,
              service_name: serviceCode,
              supplier_price: supplierPriceUsd,
              price: applyMarkup(supplierPriceUsd, usdToNgn),
              currency: 'NGN',
              available_quantity: availableQty,
              providers_raw: providersRaw,
              is_available: availableQty > 0,
              updated_at: new Date().toISOString()
            });
          if (error) errors.push(`insert ${countryId}/${serviceCode}: ${error.message}`);
        }
      }
    }

    const done = cursor >= countryList.length;
    await upsertJob({
      status: done ? 'completed' : 'running',
      cursor_index: cursor,
      total_countries: countryList.length,
      new_count: newCount,
      updated_count: updatedCount,
      services_seen: servicesSeen,
      errors: errors.slice(-20)
    });

    return res.status(200).json({
      success: true,
      done,
      cursor_index: cursor,
      total_countries: countryList.length,
      new_services: newCount,
      updated_services: updatedCount,
      services_seen: servicesSeen,
      errors: errors.slice(-20)
    });
  } catch (err) {
    console.error('grizzly-sync error:', err);
    await upsertJob({ status: 'failed', errors: [String(err.message || err)] }).catch(() => {});
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}
