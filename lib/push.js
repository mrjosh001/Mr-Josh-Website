/**
 * MJ HUB Web Push delivery helper.
 * Call only after an important event has been confirmed by its provider/database.
 * Never include OTP values or sensitive payment details in lock-screen text.
 */
export async function sendPushToUser(supabase, userId, notification = {}) {
  try {
    const title = String(notification.title || 'MJ HUB update').trim().slice(0, 80);
    const body = String(notification.body || 'There is an important update in your MJ HUB account.').trim().slice(0, 200);
    const url = String(notification.url || '/dashboard.html').slice(0, 300);
    // Keep the in-app notification bell in sync with the phone push.
    try {
      const { error: noticeError } = await supabase.from('notifications').insert({
        user_id: userId, title, body, type: String(notification.type || 'activity').slice(0, 40), read: false
      });
      if (noticeError) console.warn('[web-push] in-app notification insert failed', noticeError.message);
    } catch (e) {
      console.warn('[web-push] in-app notification insert exception', e?.message || e);
    }
    const publicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
    const privateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
    const subject = String(process.env.VAPID_SUBJECT || 'mailto:support@mjhub.store').trim();
    if (!publicKey || !privateKey) {
      console.warn('[web-push] skipped: VAPID keys are not configured');
      return { sent: 0, failed: 0, skipped: true, reason: 'vapid_not_configured' };
    }
    const { data: subscriptions, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', userId)
      .limit(50);
    if (error) {
      console.warn('[web-push] subscription lookup failed', error.message);
      return { sent: 0, failed: 0, skipped: true, reason: 'subscription_lookup_failed' };
    }
    if (!subscriptions || !subscriptions.length) {
      return { sent: 0, failed: 0, skipped: true, reason: 'no_subscription' };
    }
    const imported = await import('web-push');
    const webpush = imported.default || imported;
    webpush.setVapidDetails(subject, publicKey, privateKey);
    const payload = JSON.stringify({ title, body, url, icon: '/img/IMG_3027.png' });
    let sent = 0;
    let failed = 0;
    const stale = [];
    await Promise.all(subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 60 * 60 * 12 }
        );
        sent++;
      } catch (e) {
        failed++;
        const status = Number(e?.statusCode || e?.status || 0);
        if (status === 404 || status === 410) stale.push(sub.id);
        console.warn('[web-push] delivery failed', { status, message: e?.message || String(e) });
      }
    }));
    if (stale.length) {
      try { await supabase.from('push_subscriptions').delete().in('id', stale); } catch (_) {}
    }
    return { sent, failed, total: subscriptions.length };
  } catch (e) {
    console.warn('[web-push] delivery exception', e?.message || e);
    return { sent: 0, failed: 1, skipped: true, reason: 'delivery_exception' };
  }
}
