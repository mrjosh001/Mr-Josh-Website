/**
 * MJ Hub credential formatter
 * Base: strong August version (aggressive, rarely left raw)
 * Advanced: Sujan tabs, 2FA URL / Profile URL, cleaner labels, multi-log
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
  const u = String(p || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (/^(USER NAME|USERNAME|USER|LOGIN|ID|ACCOUNT|SCREEN NAME)$/.test(u)) return 'username';
  if (/^(PASS WORD|PASSWORD|PASS|PWD|LOGIN PASSWORD)$/.test(u)) return 'password';
  if (/^(EMAIL PASS(WORD)?|MAIL PASS(WORD)?|INBOX PASSWORD)$/.test(u)) return 'email_password';
  if (/^(E-?MAIL|MAIL|EMAIL|EMAIL ADDRESS)$/.test(u)) return 'email';
  if (/^(2 FA|2FA|TOKEN|COOKIE|AUTH TOKEN|SECRET|OTP SECRET|TOTP)$/.test(u)) return 'token';
  if (/^(PHONE|MOBILE|NUMBER|PHONE NUMBER)$/.test(u)) return 'phone';
  if (/^(2FA URL|2 FA URL|2FA LINK|AUTHENTICATOR URL|AUTHENTICATOR LINK)$/.test(u)) return 'twofa_url';
  if (/^(PROFILE URL|PROFILE LINK|ACCOUNT URL|ACCOUNT LINK)$/.test(u)) return 'profile_url';
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
    /Email\s*Password|User\s*name|Username|Password|Login|Email|User|Pass|2\s*FA|2FA|Token|Cookie|Phone|Mobile|USER|PASS|PWD|MAIL|ID/gi;
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

function splitDelimiters(line, expectedCount) {
  let t = clean(line);
  if (!t) return [];
  t = t.replace(/^\d+\.\s+/, '');

  if (t.includes('|')) return t.split('|').map(stripQuotes).filter(Boolean);
  if (t.includes(';') && t.split(';').length >= 2) return t.split(';').map(stripQuotes).filter(Boolean);

  const emailHead = t.match(/^([^\s:<>]+@[^\s:<>]+)\s*:\s*(.+)$/);
  if (emailHead) {
    const email = emailHead[1];
    const rest = emailHead[2];
    const segs = rest.split(':').map(stripQuotes).filter(Boolean);
    const n = expectedCount && expectedCount >= 2 ? expectedCount : 0;

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
      if (password && leftover) return [email, password, token, leftover];
      if (password) return [email, password, token];
      if (leftover) return [email, token, leftover];
      return [email, token];
    }

    if (n === 2) return [email, rest];
    if (n >= 3 && segs.length >= 2) return [email, segs[0], segs.slice(1).join(':')];
    if (segs.length >= 2) return [email, segs[0], segs.slice(1).join(':')];
    return [email, rest].map(stripQuotes);
  }

  if (t.includes(':')) {
    const urls = [];
    const protectedText = t.replace(/https?:\/\/[^\s|;]+/gi, (m) => {
      urls.push(m);
      return `__URL${urls.length - 1}__`;
    });
    const parts = protectedText
      .split(':')
      .map((p) => stripQuotes(p.replace(/__URL(\d+)__/g, (_, i) => urls[Number(i)] || '')))
      .filter((p) => p.length > 0);
    if (parts.length >= 2) {
      if (expectedCount && expectedCount >= 2 && parts.length > expectedCount) {
        return parts.slice(0, expectedCount - 1).concat(parts.slice(expectedCount - 1).join(':'));
      }
      return parts;
    }
  }

  if (/\s{2,}|\t/.test(t)) return t.split(/\s{2,}|\t/).map(stripQuotes).filter(Boolean);

  const words = t.split(/\s+/).map(stripQuotes).filter(Boolean);
  if (words.length >= 2 && words.length <= 12) return words;
  return [t];
}

function extractLabeled(text) {
  const out = {};
  const patterns = [
    ['username', /(?:^|\n)\s*(?:user\s*name|username|user\s*id|\blogin\b|\bid\b)\s*[:=\-]\s*(.+)/i],
    ['password', /(?:^|\n)\s*(?:pass\s*word|password|\bpass\b|\bpwd\b)\s*[:=\-]\s*(.+)/i],
    ['email_password', /(?:^|\n)\s*(?:email\s*pass(?:word)?|mail\s*pass(?:word)?)\s*[:=\-]\s*(.+)/i],
    ['email', /(?:^|\n)\s*(?:e-?mail\s*address|e-?mail|\bmail\b)\s*[:=\-]\s*(.+)/i],
    ['token', /(?:^|\n)\s*(?:2\s*fa\s*\/\s*token|auth\s*token|\btoken\b|\bcookie\b|2\s*fa|\b2fa\b|otp\s*secret|secret\s*key)\s*[:=\-]\s*(.+)/i],
    ['phone', /(?:^|\n)\s*(?:\bphone\b|\bmobile\b)\s*[:=\-]\s*(.+)/i],
    ['twofa_url', /(?:^|\n)\s*(?:2\s*fa\s*url|2\s*fa\s*link|authenticator\s*url|2fa\s*generator)\s*[:=\-]\s*(.+)/i],
    ['profile_url', /(?:^|\n)\s*(?:profile\s*url|profile\s*link|instagram\s*profile|account\s*url)\s*[:=\-]\s*(.+)/i],
    ['link', /(?:^|\n)\s*(?:login\s*url|login\s*link|\blink\b|\burl\b)\s*[:=\-]\s*(.+)/i]
  ];
  const lines = clean(text).split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [key, re] of patterns) {
      const m = line.match(re);
      if (m && m[1] && !out[key]) {
        let val = m[1].trim();
        if (!val || /^[:\-–]*$/.test(val)) {
          if (lines[i + 1] && !/^[A-Za-z0-9].*[=:]/.test(lines[i + 1])) {
            val = lines[i + 1].trim();
          }
        }
        val = val
          .replace(
            /\s+(?:User\s*name|Username|User\s*id|Login|User|Password|Pass|Pwd|E-?mail|Mail|Token|Cookie|2\s*FA\s*\/\s*Token|2\s*FA|2FA|Phone|Mobile|Profile|Link)\s*[:=].*$/i,
            ''
          )
          .trim();
        if (key !== 'token') val = val.replace(/\s*[|]\s*.*$/, '').trim();
        if (val) out[key] = stripQuotes(val);
      }
    }
  }
  return out;
}

/** Sujan-style: username\tvalue\tpassword\tvalue\thttps://2fa.live\tSECRET\thttps://instagram.com/... */
function parseTabDelimited(text) {
  if (!text.includes('\t')) return null;
  const parts = text.split('\t').map((p) => clean(p)).filter((p, i, arr) => p || i < arr.length - 1);
  if (parts.length < 2) return null;

  const fields = {};
  let i = 0;
  let recognized = 0;

  while (i < parts.length - 1) {
    const key = mapToken(parts[i]);
    if (!key) break;
    if (!fields[key]) fields[key] = parts[i + 1];
    recognized++;
    i += 2;
  }

  const extras = [];
  for (; i < parts.length; i++) {
    const value = parts[i];
    if (!value) continue;
    if (isUrl(value) && /(?:2fa\.live|authenticator|totp)/i.test(value)) {
      if (!fields.twofa_url) fields.twofa_url = value;
    } else if (isUrl(value) && /instagram\.com/i.test(value)) {
      if (!fields.profile_url) fields.profile_url = value;
    } else if (isUrl(value) && !fields.link) {
      fields.link = value;
    } else if (isLikely2FA(value) || (value.length >= 12 && !/\s{2,}/.test(value) && !isEmail(value))) {
      if (!fields.token) fields.token = value;
      else extras.push(value);
    } else {
      extras.push(value);
    }
  }

  if (recognized < 1 && !fields.username && !fields.password && !fields.email) {
    if (parts.length >= 2) {
      if (isEmail(parts[0])) {
        fields.email = parts[0];
        fields.password = parts[1];
      } else {
        fields.username = parts[0];
        fields.password = parts[1];
      }
      for (let j = 2; j < parts.length; j++) {
        const v = parts[j];
        if (isUrl(v) && /2fa\.live/i.test(v)) fields.twofa_url = v;
        else if (isUrl(v) && /instagram\.com/i.test(v)) fields.profile_url = v;
        else if (isUrl(v) && !fields.link) fields.link = v;
        else if (isLikely2FA(v) && !fields.token) fields.token = v;
        else if (!fields.token && v.length >= 12) fields.token = v;
        else extras.push(v);
      }
    }
  }

  if (extras.length) fields.extra = extras.join(' | ');
  if (fields.username || fields.password || fields.email || fields.token) return fields;
  return null;
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

  let i = 0;
  if (isEmail(parts[0])) {
    f.email = parts[0];
    i = 1;
  } else {
    f.username = parts[0];
    i = 1;
  }

  let twoFaIdx = -1;
  for (let j = parts.length - 1; j >= i; j--) {
    if (isTokenish(parts[j]) || isLikely2FA(parts[j])) {
      twoFaIdx = j;
      break;
    }
  }

  const rest = parts.slice(i);
  const urls = [];
  const nonUrls = [];
  for (const p of rest) {
    if (isUrl(p)) urls.push(p);
    else nonUrls.push(p);
  }
  for (const u of urls) {
    if (/2fa\.live|authenticator|totp/i.test(u) && !f.twofa_url) f.twofa_url = u;
    else if (/instagram\.com/i.test(u) && !f.profile_url) f.profile_url = u;
    else if (!f.link) f.link = u;
  }

  if (twoFaIdx >= i) {
    const tokenCandidate = parts[twoFaIdx];
    if (!isUrl(tokenCandidate)) f.token = tokenCandidate;
  }

  if (nonUrls.length) {
    f.password = nonUrls[0];
    const mid = nonUrls.slice(1).filter((x) => x !== f.token);
    if (mid.length) {
      if (!f.token && mid.length && isLikely2FA(mid[mid.length - 1])) {
        f.token = mid.pop();
      }
      if (mid.length) f.extra = mid.join(' | ');
    }
  }

  return f;
}

function fieldsToText(f) {
  const lines = [];
  if (f.email) lines.push('Email: ' + f.email);
  if (f.username) lines.push('Username: ' + f.username);
  if (f.password) lines.push('Password: ' + f.password);
  if (f.email_password) lines.push('Email Password: ' + f.email_password);
  if (f.phone) lines.push('Phone: ' + f.phone);
  if (f.twofa_url) lines.push('2FA URL: ' + f.twofa_url);
  if (f.token) lines.push('2FA / Token: ' + f.token);
  if (f.profile_url) lines.push('Profile URL: ' + f.profile_url);
  if (f.link) lines.push('Login URL: ' + f.link);
  if (f.extra) lines.push('Extra: ' + f.extra);
  return lines.join('\n');
}

export function formatOneAccount(raw, formatHint) {
  const text = clean(raw);
  if (!text) return '';

  const tabFields = parseTabDelimited(text);
  if (tabFields && (tabFields.username || tabFields.password || tabFields.email || tabFields.token)) {
    return fieldsToText(tabFields);
  }

  const labeled = extractLabeled(text);
  if (labeled.password && (labeled.username || labeled.email)) {
    return fieldsToText(labeled);
  }
  if (labeled.email && labeled.token && !labeled.password) {
    // fall through
  } else if (labeled.username || labeled.password || labeled.email || labeled.token) {
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
          phone: obj.phone || obj.mobile,
          twofa_url: obj.twofa_url || obj.twofaUrl,
          profile_url: obj.profile_url || obj.profileUrl || obj.profile,
          link: obj.link || obj.url || obj.login_url
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
      /^(Username|Password|Email|Email Password|Phone|2FA\s*\/\s*Token|Token|User|Login|2FA URL|Profile URL)\s*:/i.test(ln)
    );
    const looksLikeAccounts =
      !looksLabeled &&
      lines.length > 1 &&
      lines.every((ln) => /[:|;\t]/.test(ln) || /^[^\s]+@[^\s]+/.test(ln));
    if (looksLikeAccounts) chunks = lines;
  }

  const formatted = chunks.map((c) => formatOneAccount(c, hint)).filter(Boolean);
  if (!formatted.length) return text;
  return formatted.join('\n\n');
}

export function formatMultiLogCredentials(items, formatHint) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const blocks = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const raw =
      typeof item === 'string'
        ? item
        : item?.details || item?.credential || item?.login_credentials || item?.raw || '';
    const formatted =
      formatCredentials(String(raw || ''), formatHint) || String(raw || '').trim();
    if (!formatted) continue;
    blocks.push(String(i + 1) + '. ' + formatted);
  }
  return blocks.length ? blocks.join('\n\n') : null;
}

export function joinRawLogDetails(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const blocks = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const raw =
      typeof item === 'string'
        ? item
        : item?.details || item?.credential || item?.login_credentials || item?.raw || '';
    const s = String(raw || '').trim();
    if (!s) continue;
    blocks.push(String(i + 1) + '. ' + s);
  }
  return blocks.length ? blocks.join('\n\n') : null;
}

export default formatCredentials;
