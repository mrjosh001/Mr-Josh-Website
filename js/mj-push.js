/**
 * MJ HUB Web Push — register SW, request permission, save subscription.
 * Requires VAPID public key from /api/admin { resource:'push', action:'vapid_public' }
 */
(function (global) {
  'use strict';

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function getAccessToken() {
    try {
      // Dashboard uses `let supabaseClient` — expose via window when available
      var client = global.supabaseClient || global.__mjSupabase || null;
      if (!client && global.supabase && global.SUPABASE_URL && global.SUPABASE_ANON_KEY) {
        try {
          client = global.supabase.createClient(global.SUPABASE_URL, global.SUPABASE_ANON_KEY, {
            auth: { persistSession: true, storage: global.sessionStorage, autoRefreshToken: true }
          });
        } catch (_) {}
      }
      if (client && client.auth) {
        const { data: { session } } = await client.auth.getSession();
        if (session && session.access_token) return session.access_token;
      }
    } catch (_) {}
    return null;
  }

  async function apiPush(action, body) {
    const token = await getAccessToken();
    if (!token) throw new Error('Sign in required');
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token
      },
      body: JSON.stringify(Object.assign({ resource: 'push', action: action }, body || {}))
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      throw new Error(json.message || ('Push API error ' + res.status));
    }
    return json;
  }

  async function ensureServiceWorker() {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers not supported on this device');
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    return reg;
  }

  async function isSupported() {
    return !!(
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  async function getPermission() {
    if (!('Notification' in window)) return 'denied';
    return Notification.permission;
  }

  async function enable() {
    if (!(await isSupported())) throw new Error('Push not supported. On iPhone: Add to Home Screen first, then open the app.');
    const reg = await ensureServiceWorker();
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notification permission blocked. Enable it in phone Settings.');

    const { publicKey } = await apiPush('vapid_public', {});
    if (!publicKey) throw new Error('Push is not configured on the server yet (missing VAPID keys).');

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }
    const json = sub.toJSON();
    await apiPush('subscribe', {
      endpoint: json.endpoint,
      keys: json.keys || {},
      user_agent: navigator.userAgent || ''
    });
    try { localStorage.setItem('mjhub_push_enabled', '1'); } catch (_) {}
    return { ok: true, endpoint: json.endpoint };
  }

  async function disable() {
    if (!('serviceWorker' in navigator)) return { ok: true };
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        try {
          await apiPush('unsubscribe', { endpoint: sub.endpoint });
        } catch (_) {}
        try { await sub.unsubscribe(); } catch (_) {}
      }
    }
    try { localStorage.removeItem('mjhub_push_enabled'); } catch (_) {}
    return { ok: true };
  }

  async function status() {
    const supported = await isSupported();
    const permission = await getPermission();
    let subscribed = false;
    try {
      if (supported) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          subscribed = !!sub;
        }
      }
    } catch (_) {}
    return { supported, permission, subscribed };
  }

  global.MJHubPush = { enable, disable, status, isSupported, ensureServiceWorker };
})(typeof window !== 'undefined' ? window : globalThis);
