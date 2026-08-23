/**
 * Normalize supplier log lines using optional product description format hints.
 * Descriptions often include: USER/PASSWORD/2FA or Username : Password : Email : Email Password
 */

function clean(s) {
  return String(s || '').replace(/\r/g, '').replace(/\u0000/g, '').trim();
}
function stripQuotes(s) {
  return clean(s).replace(/^["']|["']$/g, '');
}


/** TOTP / authenticator secrets are usually uppercase base32-ish */
function isLikely2FA(s) {
  const t = String(s || '').trim();
  if (!t || t.length < 12) return false;
  if (/@/.test(t)) return false;
  // Pure-ish uppercase alphanumeric (allow spaces stripped)
  const compact = t.replace(/\s+/g, '');
  if (/^[A-Z2-7]{12,64}$/.test(compact)) return true;
  if (/^[A-Z0-9]{16,64}$/.test(compact) && compact === compact.toUpperCase()) return true;
  // High uppercase letter ratio, few lowercase
  const letters = compact.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 12) {
    const up = (letters.match(/[A-Z]/g) || []).length;
    if (up / letters.length >= 0.85 && compact.length >= 16) return true;
  }
  return false;
}

function mapToken(p) {
  const u = String(p || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (/^(USER NAME|USERNAME|USER|LOGIN|ID|ACCOUNT)$/.test(u)) return 'username';
  if (/^(PASS WORD|PASSWORD|PASS|PWD)$/.test(u)) return 'password';
  if (/^(EMAIL PASS(WORD)?|MAIL PASS(WORD)?)$/.test(u)) return 'email_password';
  if (/^(E-?MAIL|MAIL|EMAIL)$/.test(u)) return 'email';
  if (/^(2 FA|2FA|TOKEN|COOKIE|AUTH TOKEN|SECRET)$/.test(u)) return 'token';
  if (/^(PHONE|MOBILE|NUMBER)$/.test(u)) return 'phone';
  return null;
}

/**
 * Parse format hint from product description → ordered field keys
 */
export function parseFormatHint(description) {
  if (!description) return null;
  const text = clean(description);

  let focus = text;
  const fmtBlock = text.match(/(?:delivery\s*format|format|credentials?\s*format)\s*[:\-–]?\s*([^\n]+)/i);
  if (fmtBlock) focus = fmtBlock[1];

  // USER/PASSWORD/2FA style
  const slash = text.match(
    /\b((?:USER(?:NAME)?|PASS(?:WORD)?|EMAIL(?:\s*PASS(?:WORD)?)?|2FA|TOKEN|COOKIE|LOGIN)(?:\s*[\/|]\s*(?:USER(?:NAME)?|PASS(?:WORD)?|EMAIL(?:\s*PASS(?:WORD)?)?|2FA|TOKEN|COOKIE|LOGIN))+)/i
  );
  if (slash && /[\/|]/.test(slash[1])) focus = slash[1];

  // Longer phrases first so "Email Password" is not split into Email + Password
  const tokenRe =
    /Email\s*Password|User\s*name|Username|Password|Login|Email|User|Pass|2\s*FA|2FA|Token|Cookie|Phone|Mobile|USER|PASS|PWD|MAIL|ID/gi;
  const found = focus.match(tokenRe);
  if (!found || found.length < 2) return null;

  const keys = [];
  for (const p of found) {
    const k = mapToken(p);
    if (k && !keys.includes(k)) keys.push(k);
  }
    // Account products often omit "Password" in marketing text but deliver email:pass:2fa
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

function splitDelimiters(line, expectedCount) {
  let t = clean(line);
  if (!t) return [];
  // Strip leading "1." numbering
  t = t.replace(/^\d+\.\s+/, '');

  if (t.includes('|')) return t.split('|').map(stripQuotes).filter(Boolean);
  if (t.includes(';') && t.split(';').length >= 2) return t.split(';').map(stripQuotes).filter(Boolean);

    // email:password or email:password:…:2FA (2FA often ALL CAPS / base32)
  const emailHead = t.match(/^([^\s:<>]+@[^\s:<>]+)\s*:\s*(.+)$/);
  if (emailHead) {
    const email = emailHead[1];
    const rest = emailHead[2];
    const segs = rest.split(':').map(stripQuotes).filter(Boolean);
    const n = expectedCount && expectedCount >= 2 ? expectedCount : 0;

    // Prefer last segment that looks like uppercase 2FA secret
    let twoFaIdx = -1;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (isLikely2FA(segs[i])) { twoFaIdx = i; break; }
    }

    if (twoFaIdx >= 0) {
      const token = segs[twoFaIdx];
      const before = segs.slice(0, twoFaIdx);
      const after = segs.slice(twoFaIdx + 1);
      const password = before[0] || '';
      const middle = before.slice(1).join(':');
      const leftover = [middle, after.join(':')].filter(Boolean).join(' | ');
      if (n === 2) return password ? [email, password] : [email, token];
      // parts: email, password, token, optional leftover (maps to extra via applyHint overflow)
      if (password && leftover) return [email, password, token, leftover];
      if (password) return [email, password, token];
      if (leftover) return [email, token, leftover];
      return [email, token];
    }

    if (n === 2) return [email, rest];
    if (n >= 3 && segs.length >= 2) {
      return [email, segs[0], segs.slice(1).join(':')];
    }
    if (segs.length >= 2) {
      return [email, segs[0], segs.slice(1).join(':')];
    }
    return [email, rest].map(stripQuotes);
  }

if (t.includes(':')) {
    const parts = t.split(':').map(stripQuotes).filter((p) => p.length > 0);
    if (parts.length >= 2) {
      if (expectedCount && expectedCount >= 2 && parts.length > expectedCount) {
        // Merge overflow into last field (colon-heavy secrets)
        return parts.slice(0, expectedCount - 1).concat(parts.slice(expectedCount - 1).join(':'));
      }
      return parts;
    }
  }

  if (/\s{2,}|\t/.test(t)) return t.split(/\s{2,}|\t/).map(stripQuotes).filter(Boolean);

  const words = t.split(/\s+/).map(stripQuotes).filter(Boolean);
  if (words.length >= 2) {
    // Keep all tokens so overflow can become Extra (do not drop supplier data)
    if (words.length >= 2 && words.length <= 12) return words;
  }
  return [t];
}

function extractLabeled(text) {
  const out = {};
  const patterns = [
    ['username', /(?:^|\n)\s*(?:user\s*name|username|user\s*id|\blogin\b|\bid\b)\s*[:=\-]\s*(.+)/i],
    ['password', /(?:^|\n)\s*(?:pass\s*word|password|\bpass\b|\bpwd\b)\s*[:=\-]\s*(.+)/i],
    ['email_password', /(?:^|\n)\s*(?:email\s*pass(?:word)?|mail\s*pass(?:word)?)\s*[:=\-]\s*(.+)/i],
    ['email', /(?:^|\n)\s*(?:e-?mail\s*address|e-?mail|\bmail\b)\s*[:=\-]\s*(.+)/i],
    ['token', /(?:^|\n)\s*(?:2\s*fa\s*\/\s*token|auth\s*token|\btoken\b|\bcookie\b|2\s*fa|\b2fa\b|otp\s*secret)\s*[:=\-]\s*(.+)/i],
    ['phone', /(?:^|\n)\s*(?:\bphone\b|\bmobile\b)\s*[:=\-]\s*(.+)/i]
  ];
  const lines = clean(text).split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [key, re] of patterns) {
      const m = line.match(re);
      if (m && m[1] && !out[key]) {
        let val = m[1].trim();
        // Value on next line if label-only (Email:\nuser@x.com)
        if (!val || /^[:\-–]*$/.test(val)) {
          if (lines[i + 1] && !/^[A-Za-z0-9].*[=:]/.test(lines[i + 1])) {
            val = lines[i + 1].trim();
          }
        }
        val = val
          .replace(
            /\s+(?:User\s*name|Username|User\s*id|Login|User|Password|Pass|Pwd|E-?mail|Mail|Token|Cookie|2\s*FA\s*\/\s*Token|2\s*FA|2FA|Phone|Mobile)\s*[:=].*$/i,
            ''
          )
          .trim();
        // Don't cut token at internal colons — only at " | " style new fields
        if (key !== 'token') val = val.replace(/\s*[|]\s*.*$/, '').trim();
        if (val) out[key] = stripQuotes(val);
      }
    }
  }
  return out;
}

function applyHint(parts, hintKeys) {
  const f = {};
  if (!parts || !parts.length || !hintKeys || !hintKeys.length) return null;
  const n = Math.min(parts.length, hintKeys.length);
  for (let i = 0; i < n; i++) {
    const key = hintKeys[i];
    if (key && parts[i] != null && parts[i] !== '') f[key] = parts[i];
  }
  if (parts.length > hintKeys.length) f.extra = parts.slice(hintKeys.length).join(' | ');
  return f;
}

function partsToFields(parts) {
  const f = {};
  if (!parts || !parts.length) return f;
  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const isTokenish = (s) => isLikely2FA(s) || s.length > 40 || /^(otpauth|eyJ|ghp_|sk-)/i.test(s);
  if (parts.length === 1) {
    f.username = parts[0];
    return f;
  }
  if (parts.length === 2) {
    if (isEmail(parts[0])) {
      f.email = parts[0];
      f.password = parts[1];
    } else {
      f.username = parts[0];
      f.password = parts[1];
    }
    return f;
  }

  // 3+ parts: detect email-first vs username-first; last likely-2FA → token; rest → extra
  let i = 0;
  if (isEmail(parts[0])) {
    f.email = parts[0];
    i = 1;
  } else {
    f.username = parts[0];
    i = 1;
  }

  // Find 2FA from the end
  let twoFaIdx = -1;
  for (let j = parts.length - 1; j >= i; j--) {
    if (isTokenish(parts[j]) || isLikely2FA(parts[j])) {
      twoFaIdx = j;
      break;
    }
  }

  if (twoFaIdx >= i) {
    f.token = parts[twoFaIdx];
    if (i < twoFaIdx) {
      f.password = parts[i];
      const mid = parts.slice(i + 1, twoFaIdx);
      if (mid.length) f.extra = mid.join(' | ');
    }
    const after = parts.slice(twoFaIdx + 1);
    if (after.length) f.extra = [f.extra, after.join(' | ')].filter(Boolean).join(' | ');
    return f;
  }

  f.password = parts[i];
  const rest = parts.slice(i + 1);
  if (rest.length === 1) {
    if (isEmail(rest[0]) && !f.email) f.email = rest[0];
    else if (isTokenish(rest[0])) f.token = rest[0];
    else f.extra = rest[0];
  } else if (rest.length > 1) {
    if (isEmail(rest[0]) && !f.email) {
      f.email = rest[0];
      f.extra = rest.slice(1).join(' | ');
    } else {
      f.extra = rest.join(' | ');
    }
  }
  return f;
}

function fieldsToText(f) {
  const lines = [];
  // Always: identity first, then secrets (email/username before password)
  if (f.email) lines.push('Email: ' + f.email);
  if (f.username) lines.push('Username: ' + f.username);
  if (f.password) lines.push('Password: ' + f.password);
  if (f.email_password) lines.push('Email Password: ' + f.email_password);
  if (f.phone) lines.push('Phone: ' + f.phone);
  if (f.token) lines.push('2FA / Token: ' + f.token);
  if (f.extra) lines.push('Extra: ' + f.extra);
  return lines.join('\n');
}

export function formatOneAccount(raw, formatHint) {
  const text = clean(raw);
  if (!text) return '';

  const labeled = extractLabeled(text);
  // Trust labeled parse only when we got a real password or a clean email without a fat token blob
  if (labeled.password && (labeled.username || labeled.email)) {
    return fieldsToText(labeled);
  }
  if (labeled.email && labeled.token && !labeled.password) {
    // Might be mis-merged — fall through to delimiter split using hint
  } else if (labeled.username || labeled.password || labeled.email) {
    return fieldsToText(labeled);
  }

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const j = JSON.parse(text);
      const obj = Array.isArray(j) ? j[0] : j;
      if (obj && typeof obj === 'object') {
        const t = fieldsToText({
          username: obj.username || obj.user || obj.login || obj.id || obj.account,
          password: obj.password || obj.pass || obj.pwd,
          email: obj.email || obj.mail,
          email_password: obj.email_password || obj.emailPassword || obj.mail_pass,
          token: obj.token || obj.cookie || obj['2fa'] || obj.twofa || obj.secret,
          phone: obj.phone || obj.mobile
        });
        if (t) return t;
      }
    } catch (_) {}
  }

    const expected = Array.isArray(formatHint) ? formatHint.length : 0;
  let parts = splitDelimiters(text.replace(/\n/g, ' ').replace(/\s+/g, ' '), expected);
  if (parts && parts.length >= 2) {
    const hinted = applyHint(parts, formatHint);
    if (hinted && (hinted.username || hinted.password || hinted.email || hinted.token || hinted.email_password)) {
      return fieldsToText(hinted);
    }
    return fieldsToText(partsToFields(parts));
  }

const lines = text.split(/\n+/).map(clean).filter(Boolean);
  if (lines.length >= 2 && !lines[0].includes(' ')) {
    const hinted = applyHint(lines, formatHint);
    if (hinted) return fieldsToText(hinted);
    return fieldsToText(partsToFields(lines));
  }

  return text.replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * @param {string|object} details - raw supplier credential blob
 * @param {string} [description] - product description (format hint)
 */
export function formatCredentials(details, description) {
  if (details == null) return '';
  if (typeof details === 'object') {
    try {
      details = JSON.stringify(details);
    } catch (_) {
      details = String(details);
    }
  }
  let text = clean(details);
  if (!text) return '';

  const hint = parseFormatHint(description);

    let chunks = text.split(/\n\s*\n|\n-{3,}\n|\n={3,}\n/).map(clean).filter(Boolean);
  if (chunks.length === 1) {
    const lines = text.split(/\n+/).map(clean).filter(Boolean);
    const looksLabeled = lines.some((ln) =>
      /^(Username|Password|Email|Email Password|Phone|2FA\s*\/\s*Token|Token|User|Login)\s*:/i.test(ln)
    );
    // Only split one block into many when lines look like separate accounts (email:pass each),
    // NOT when they are labeled fields of a single account.
    const looksLikeAccounts =
      !looksLabeled &&
      lines.length > 1 &&
      lines.every((ln) => /[:|;]/.test(ln) || /^[^\s]+@[^\s]+/.test(ln));
    if (looksLikeAccounts) chunks = lines;
  }

const formatted = chunks.map((c) => formatOneAccount(c, hint)).filter(Boolean);
  if (!formatted.length) return text;
  return formatted.join('\n\n');
}

export default formatCredentials;


/**
 * Number multiple delivered logs under one order for display + storage.
 * 1. first log
 * 2. second log
 * ...
 */
export function formatMultiLogCredentials(items, formatHint) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const blocks = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const raw =
      typeof item === 'string'
        ? item
        : item?.details || item?.credential || item?.login_credentials || '';
    const formatted =
      formatCredentials(String(raw || ''), formatHint) || String(raw || '').trim();
    if (!formatted) continue;
    blocks.push(String(i + 1) + '. ' + formatted);
  }
  return blocks.length ? blocks.join('\n\n') : null;
}

/**
 * Join raw supplier payloads for admin / product_details without reformatting.
 */
export function joinRawLogDetails(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const blocks = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const raw =
      typeof item === 'string'
        ? item
        : item?.details || item?.credential || item?.login_credentials || '';
    const s = String(raw || '').trim();
    if (!s) continue;
    blocks.push(String(i + 1) + '. ' + s);
  }
  return blocks.length ? blocks.join('\n\n') : null;
}
