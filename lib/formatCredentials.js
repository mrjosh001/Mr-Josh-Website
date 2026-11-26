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

/** TOTP / authenticator secrets — uppercase base32-ish */
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
  const u = String(p || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[:\-–]+$/g, '')
    .trim();
  if (/^(USER NAME|USERNAME|USER|LOGIN|UID|USER ID|USERID|ID|ACCOUNT|SCREEN NAME)$/.test(u)) return 'username';
  if (/^(PASS WORD|PASSWORD|PASS|PWD|LOGIN PASSWORD)$/.test(u)) return 'password';
  if (/^(EMAIL PASS(WORD)?|MAIL PASS(WORD)?|INBOX PASSWORD)$/.test(u)) return 'email_password';
  // Allow "E MAIL", "E-MAIL", "EMAIL", etc.
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

export function parseFormatHint(description) {
  if (!description) return null;
  const text = clean(description);

  let focus = text;
  const fmtBlock = text.match(/(?:delivery\s*format|format|credentials?\s*format)\s*[:\-–]?\s*([^\n]+)/i);
  if (fmtBlock) focus = fmtBlock[1];

  const slash = text.match(
    /\b((?:USER(?:NAME)?|PASS(?:WORD)?|EMAIL(?:\s*PASS(?:WORD)?)?|2FA|TOKEN|COOKIE|LOGIN)(?:\s*[\/|]\s*(?:USER(?:NAME)?|PASS(?:WORD)?|EMAIL(?:\s*PASS(?:WORD)?)?|2FA|TOKEN|COOKIE|LOGIN))+)/i
  );
  if (slash && /[\/|]/.test(slash[1])) focus = slash[1];

  const tokenRe =
    /Email\s*Password|User\s*name|Username|Password|Login|Email|User|Pass|2\s*FA|2FA|Token|Cookie|Phone|Mobile|USER|PASS|PWD|MAIL|ID|UID/gi;
  const found = focus.match(tokenRe);
  if (!found || found.length < 2) return null;

  const keys = [];
  for (const p of found) {
    const k = mapToken(p);
    if (k && !keys.includes(k)) keys.push(k);
  }
  if (keys.includes('email') && keys.includes('token') && !keys.includes('password')) {
    const ei = keys.indexOf('email');
    keys.splice(ei + 1, 0, 'password');
  }
  if (keys.includes('username') && keys.includes('token') && !keys.includes('password')) {
    const ui = keys.indexOf('username');
    keys.splice(ui + 1, 0, 'password');
  }
  return keys.length >= 2 ? keys : null;
}
