import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function encryptionKey() {
  const raw = String(process.env.RESELLER_WEBHOOK_ENCRYPTION_KEY || '').trim();
  if (!raw) throw new Error('RESELLER_WEBHOOK_ENCRYPTION_KEY is not configured');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('RESELLER_WEBHOOK_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return key;
}

export function encryptWebhookSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptWebhookSecret(value) {
  const [version, ivText, tagText, ciphertextText] = String(value || '').split('.');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) throw new Error('Invalid webhook secret envelope');
  const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

export function signWebhookPayload(secret, timestamp, rawBody) {
  const signed = String(timestamp) + '.' + String(rawBody);
  return 'v1=' + crypto.createHmac('sha256', String(secret)).update(signed).digest('hex');
}

export function verifyWebhookSignature(secret, timestamp, rawBody, signature, toleranceSeconds = 300) {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSeconds) return false;
  const expected = signWebhookPayload(secret, ts, rawBody);
  const supplied = String(signature || '');
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
