/**
 * Transactional email delivery: Resend primary, Mailtrap backup.
 *
 * Mailtrap is used when Resend explicitly rejects a send because of quota,
 * rate limiting, or provider availability (HTTP 5xx). We do not retry on
 * network timeouts because the primary provider may have accepted the email
 * before the connection failed, which could create duplicate messages.
 *
 * Env:
 *   RESEND_API_KEY, RESEND_FROM_EMAIL (primary)
 *   MAILTRAP_API_TOKEN (or MAILTRAP_API_KEY), MAILTRAP_FROM_EMAIL (backup)
 */
function isResendFailoverError(status, body) {
  if (status === 429 || status === 402 || status === 403 || status >= 500) return true;
  const message = JSON.stringify(body || {}).toLowerCase();
  return /rate.?limit|quota|too many|monthly|daily limit|free tier|usage limit|exceeded|insufficient|temporarily unavailable|server error/i.test(message);
}

function parseSender(raw, fallback) {
  const value = String(raw || '').trim();
  const match = value.match(/^(.+?)\\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim().replace(/^["']|["']$/g, '') || 'MJ HUB', email: match[2].trim() };
  if (value.includes('@')) return { name: 'MJ HUB', email: value };
  return { name: 'MJ HUB', email: fallback || 'noreply@mjhub.store' };
}

function normalizeMailtrapAttachments(attachments) {
  if (!Array.isArray(attachments)) return undefined;
  return attachments.map((item) => {
    const out = {};
    if (item.filename) out.filename = item.filename;
    if (item.content) out.content = item.content;
    if (item.type || item.content_type) out.type = item.type || item.content_type;
    if (item.disposition) out.disposition = item.disposition;
    if (item.content_id) out.content_id = item.content_id;
    return out;
  }).filter((item) => item.filename && item.content);
}

export async function sendEmailWithFallback(payload, { context = 'email' } = {}) {
  const resendKey = String(process.env.RESEND_API_KEY || '').trim();
  const mailtrapKey = String(process.env.MAILTRAP_API_TOKEN || process.env.MAILTRAP_API_KEY || '').trim();
  const resendFrom = payload.from || process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM || '';
  const mailtrapFrom = parseSender(
    process.env.MAILTRAP_FROM_EMAIL || resendFrom,
    'noreply@mjhub.store'
  );

  if (!payload.to || (Array.isArray(payload.to) && payload.to.length === 0)) {
    throw new Error('Email recipient is required');
  }

  if (resendKey) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + resendKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok) return { ...result, provider: 'resend' };

      const canFailover = mailtrapKey && isResendFailoverError(response.status, result);
      if (!canFailover) {
        throw new Error(result.message || result.error || 'Resend rejected the email (' + response.status + ')');
      }
      console.warn('[' + context + '] Resend unavailable/quota reached; trying Mailtrap', response.status);
    } catch (error) {
      // A network exception has an ambiguous delivery outcome. Do not retry
      // automatically because Resend may already have accepted the message.
      if (error && error.message && !/Resend rejected|quota|rate.?limit|unavailable/i.test(error.message)) {
        throw error;
      }
      if (!mailtrapKey) throw error;
      console.warn('[' + context + '] Resend request failed; Mailtrap fallback:', error?.message || error);
    }
  }

  if (!mailtrapKey) {
    throw new Error(resendKey ? 'Resend failed and Mailtrap backup is not configured' : 'Neither Resend nor Mailtrap is configured');
  }

  const recipients = (Array.isArray(payload.to) ? payload.to : [payload.to]).map((entry) =>
    typeof entry === 'string' ? { email: entry } : { email: entry.email, name: entry.name }
  );
  const mailtrapPayload = {
    from: mailtrapFrom,
    to: recipients,
    subject: payload.subject,
    ...(payload.html != null ? { html: payload.html } : {}),
    ...(payload.text != null ? { text: payload.text } : {})
  };
  if (payload.reply_to) {
    const reply = typeof payload.reply_to === 'string' ? payload.reply_to : payload.reply_to.email;
    if (reply) mailtrapPayload.reply_to = { email: reply };
  }
  const attachments = normalizeMailtrapAttachments(payload.attachments);
  if (attachments?.length) mailtrapPayload.attachments = attachments;

  const response = await fetch('https://send.api.mailtrap.io/api/send', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + mailtrapKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(mailtrapPayload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success === false) {
    const detail = Array.isArray(result.errors) ? result.errors.join('; ') : (result.message || JSON.stringify(result));
    throw new Error('Mailtrap rejected the email (' + response.status + '): ' + detail);
  }
  return { ...result, provider: 'mailtrap' };
}
