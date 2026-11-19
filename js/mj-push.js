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
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers,
      body: JSON.stringify(Object.assign({ resource: 'push', action: action }, body || {}))
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      throw new Error(json.message || ('Push API error ' + res.status));
    }
    return json;
  }

  function registrationConfig(options) {
    var appId = options && options.appId === 'admin_support' ? 'admin_support' : 'main';
    return appId === 'admin_support'
      ? { script: '/admin-support-sw.js', scope: '/admin-support.html' }
      : { script: '/sw.js', scope: '/' };
  }

  async function getAppRegistration(options) {
    if (!('serviceWorker' in navigator)) return null;
    var config = registrationConfig(options);
    var wantedScope = new URL(config.scope, location.origin).href;
    var registrations = await navigator.serviceWorker.getRegistrations();
    return registrations.find(function (registration) {
      return registration.scope === wantedScope;
    }) || null;
  }

  async function ensureServiceWorker(options) {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers not supported on this device');
    var config = registrationConfig(options);
    const reg = await navigator.serviceWorker.register(config.script, { scope: config.scope });
    if (!reg.active) {
      await new Promise(function (resolve, reject) {
        var worker = reg.installing || reg.waiting;
        if (!worker) return resolve();
        worker.addEventListener('statechange', function () {
          if (reg.active) resolve();
          else if (worker.state === 'redundant') reject(new Error('Push service worker installation failed'));
        });
      });
    }
    if (!reg.active) throw new Error('Push service worker is not active yet. Please try again.');
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

  async function enable(options) {
    options = options || {};
    var appId = options.appId === 'admin_support' ? 'admin_support' : 'main';
    if (!(await isSupported())) throw new Error('Push not supported. On iPhone: Add to Home Screen first, then open the app.');
    const reg = await ensureServiceWorker({ appId: appId });
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
      user_agent: navigator.userAgent || '',
      app_id: appId
    });
    try { localStorage.setItem(appId === 'admin_support' ? 'mjhub_push_enabled_admin_support' : 'mjhub_push_enabled', '1'); } catch (_) {}
    return { ok: true, endpoint: json.endpoint };
  }

  async function disable(options) {
    if (!('serviceWorker' in navigator)) return { ok: true };
    const reg = await getAppRegistration(options);
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        try {
          await apiPush('unsubscribe', { endpoint: sub.endpoint });
        } catch (_) {}
        try { await sub.unsubscribe(); } catch (_) {}
      }
    }
    try { localStorage.removeItem(options && options.appId === 'admin_support' ? 'mjhub_push_enabled_admin_support' : 'mjhub_push_enabled'); } catch (_) {}
    return { ok: true };
  }

  async function status(options) {
    options = options || {};
    const supported = await isSupported();
    const permission = await getPermission();
    let subscribed = false;
    let syncError = null;
    try {
      if (supported && permission === 'granted') {
        // Browser permission survives sign-out. Restore the admin worker if a
        // browser discarded its registration, without prompting the user again.
        const reg = await ensureServiceWorker(options);
        const sub = await reg.pushManager.getSubscription();
        subscribed = !!sub;
        // Reconcile the existing browser subscription with the server whenever
        // an authenticated admin visits. A signed-out visit must not disable it.
        // Never send an anonymous subscribe request for an existing account-bound
        // subscription. The server would otherwise detach this device from its owner.
        const accessToken = await getAccessToken();
        if (sub && accessToken && options.sync !== false) {
          const json = sub.toJSON();
          try {
            await apiPush('subscribe', {
              endpoint: json.endpoint,
              keys: json.keys || {},
              user_agent: navigator.userAgent || '',
              app_id: options.appId === 'admin_support' ? 'admin_support' : 'main'
            });
          } catch (e) {
            syncError = e && e.message ? e.message : 'Could not sync push subscription';
          }
        }
      }
    } catch (e) {
      syncError = e && e.message ? e.message : 'Could not restore push registration';
    }
    return { supported, permission, subscribed, syncError };
  }


  async function testAdminSupport() {
    const token = await getAccessToken();
    if (!token) throw new Error('Sign in to the admin account before testing push notifications.');
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ resource: 'support_push', action: 'test' })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      const delivery = json.delivery || {};
      throw new Error(json.message || ('Push test failed: sent ' + (delivery.sent || 0) + ', failed ' + (delivery.failed || 0)));
    }
    return json.delivery || { sent: 1 };
  }

  global.MJHubPush = { enable, disable, status, isSupported, ensureServiceWorker, testAdminSupport };
})(typeof window !== 'undefined' ? window : globalThis);
