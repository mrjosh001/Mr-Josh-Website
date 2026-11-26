/**
 * MJ Hub credential formatter
 * Base: strong August version (aggressive, rarely left raw)
 * Advanced: Sujan tabs, colon chains, UID/Facebook/Page links, Number/Location, 2FA
 * + Activation Code support
 */

function clean(s) {
  return String(s ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
}
function stripQuotes(s) {
  return clean(s).replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
}

function isLikely2FA(s) {
  const t = String(s || '').trim();
  if (!t || t.length < 12) return false;
  if (/@/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  const compact = t.replace(/\s+/g, '');
  if (/^[A-Z2-7]{12,64}$/.test(compact)) return true;
  if (/^[A-Z0-9]{16,64}$/.test(compact) && compact === compact.toUpperCase()) return true;
  const letters = compact.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 12) {
    const up = (letters.match(/[A-Z]/g) || []).length;
    if (up / letters.length >= 0.85 && compact.length >= 16) return true;
  }
  return false;
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(s));
}
function isUrl(s) {
  return /^(?:https?|ftp):\/\/\S+$/i.test(clean(s));
}

function mapToken(p) {
  const u = String(p || '').toUpperCase().replace(/\s+/g, ' ').replace(/[:\-–]+$/g, '').trim();
  if (/^(USER NAME|USERNAME|USER|LOGIN|UID|USER ID|USERID|ID|ACCOUNT|SCREEN NAME)$/.test(u)) return 'username';
  if (/^(PASS WORD|PASSWORD|PASS|PWD|LOGIN PASSWORD)$/.test(u)) return 'password';
  if (/^(EMAIL PASS(WORD)?|MAIL PASS(WORD)?|INBOX PASSWORD)$/.test(u)) return 'email_password';
  if (/^(E-?\s*MAIL|MAIL|EMAIL|EMAIL ADDRESS)$/.test(u)) return 'email';
  if (/^(ACTIVATION\s*CODE|ACTIVATE\s*CODE|ACTIVATION)$/.test(u)) return 'activation_code';
  if (/^(2 FA|2FA|TOKEN|COOKIE|AUTH TOKEN|SECRET|OTP SECRET|TOTP)$/.test(u)) return 'token';
  if (/^(PHONE|MOBILE|NUMBER|PHONE NUMBER|TEL)$/.test(u)) return 'phone';
  if (/^(LOCATION|LOC|AREA|REGION|CITY|STATE)$/.test(u)) return 'location';
  if (/^(2FA URL|2 FA URL|2FA LINK|AUTHENTICATOR URL|AUTHENTICATOR LINK)$/.test(u)) return 'twofa_url';
  if (/^(PROFILE URL|PROFILE LINK|ACCOUNT URL|ACCOUNT LINK|FACEBOOK LINK|FB LINK|PAGE LINK|PAGE URL)$/.test(u)) return 'profile_url';
  if (/^(LINK|URL|LOGIN URL|LOGIN LINK|WEBSITE|SITE|ACCESS LINK)$/.test(u)) return 'link';
  return null;
}

function fieldsToText(f) {
  const lines = [];
  if (f.username) {
    if (/^\d{10,}$/.test(String(f.username))) lines.push('UID: ' + f.username);
    else lines.push('Username: ' + f.username);
  }
  if (f.email) lines.push('Email: ' + f.email);
  if (f.password) lines.push('Password: ' + f.password);
  if (f.email_password) lines.push('Email Password: ' + f.email_password);
  if (f.activation_code) lines.push('Activation Code: ' + f.activation_code);
  if (f.phone) lines.push('Number: ' + f.phone);
  if (f.location) lines.push('Location: ' + f.location);
  if (f.twofa_url) lines.push('2FA URL: ' + f.twofa_url);
  if (f.token) lines.push('2FA / Token: ' + f.token);
  if (f.profile_url) {
    if (/facebook\.com/i.test(f.profile_url)) lines.push('Facebook Link: ' + f.profile_url);
    else lines.push('Profile URL: ' + f.profile_url);
  }
  if (f.link) lines.push('Login URL: ' + f.link);
  if (f.extra) lines.push('Extra: ' + f.extra);
  return lines.join('\n');
}

function parseTabDelimited(text) {
  if (!text.includes('\t')) return null;
  let parts = text.split('\t').map((p) => clean(p));
  if (parts[0]) parts[0] = parts[0].replace(/^\d+\.\s+/, '');
  parts = parts.filter((p, i, arr) => p || i < arr.length - 1);
  if (parts.length < 2) return null;
  const fields = {};
  const extras = [];
  let i = 0;
  while (i < parts.length) {
    const key = mapToken(parts[i]);
    if (key && i + 1 < parts.length) {
      const val = parts[i + 1];
      if (val && !/^[:\-–]*$/.test(val) && !mapToken(val)) {
        if (!fields[key]) fields[key] = val;
        i += 2;
        continue;
      }
    }
    const value = parts[i];
    if (!value) { i++; continue; }
    if (isEmail(value) && !fields.email) fields.email = value;
    else if (isLikely2FA(value) && !fields.token) fields.token = value;
    else extras.push(value);
    i += 1;
  }
  if (extras.length) fields.extra = extras.join(' | ');
  if (fields.username || fields.password || fields.email || fields.token || fields.phone || fields.activation_code) return fields;
  return null;
}

export function formatOneAccount(raw, formatHint) {
  const text = clean(raw);
  if (!text) return '';
  const tabFields = parseTabDelimited(text);
  if (tabFields && (tabFields.username || tabFields.password || tabFields.email || tabFields.token || tabFields.phone || tabFields.activation_code)) {
    return fieldsToText(tabFields);
  }
  return text;
}

export function formatCredentials(details, description) {
  if (details == null) return '';
  if (typeof details === 'object') {
    try { details = JSON.stringify(details); } catch (_) { details = String(details); }
  }
  let text = clean(details);
  if (!text) return '';
  const result = formatOneAccount(text, null);
  return result || text;
}

export default formatCredentials;
