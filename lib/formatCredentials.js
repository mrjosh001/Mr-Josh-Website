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
  return keys.length >= 2 ? keys : null;
}

function splitDelimiters(line) {
  const t = clean(line);
  if (!t) return [];
  if (t.includes('|')) return t.split('|').map(stripQuotes).filter(Boolean);
  if (t.includes(';') && t.split(';').length >= 2) return t.split(';').map(stripQuotes).filter(Boolean);
  if (t.includes(':')) {
    const emailPass = t.match(/^([^\s:]+@[^\s:]+):(.+)$/);
    if (emailPass) return [emailPass[1], emailPass[2]];
    const parts = t.split(':').map(stripQuotes).filter((p) => p.length > 0);
    if (parts.length >= 2) return parts;
  }
  if (/\s{2,}|\t/.test(t)) return t.split(/\s{2,}|\t/).map(stripQuotes).filter(Boolean);
  return [t];
}

function extractLabeled(text) {
  const out = {};
  const patterns = [
    ['username', /(?:^|\n)\s*(?:user\s*name|username|user\s*id|\blogin\b)\s*[:=\-]\s*(.+)/i],
    ['password', /(?:^|\n)\s*(?:pass\s*word|password|\bpass\b|\bpwd\b)\s*[:=\-]\s*(.+)/i],
    ['email_password', /(?:^|\n)\s*(?:email\s*pass(?:word)?|mail\s*pass(?:word)?)\s*[:=\-]\s*(.+)/i],
    ['email', /(?:^|\n)\s*(?:e-?mail\s*address|e-?mail|\bmail\b)\s*[:=\-]\s*(.+)/i],
    ['token', /(?:^|\n)\s*(?:auth\s*token|\btoken\b|\bcookie\b|2\s*fa|\b2fa\b|otp\s*secret)\s*[:=\-]\s*(.+)/i],
    ['phone', /(?:^|\n)\s*(?:\bphone\b|\bmobile\b)\s*[:=\-]\s*(.+)/i]
  ];
  for (const line of clean(text).split(/\n+/)) {
    for (const [key, re] of patterns) {
      const m = line.match(re);
      if (m && m[1] && !out[key]) {
        let val = m[1].trim();
        val = val
          .replace(
            /\s+(?:User\s*name|Username|User\s*id|Login|User|Password|Pass|Pwd|E-?mail|Mail|Token|Cookie|2\s*FA|2FA|Phone|Mobile)\s*[:=].*$/i,
            ''
          )
          .trim();
        val = val.replace(/\s*[|]\s*.*$/, '').trim();
        out[key] = stripQuotes(val);
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
  const isTokenish = (s) => s.length > 40 || /^(otpauth|eyJ|ghp_|sk-)/i.test(s);
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
  f.username = parts[0];
  f.password = parts[1];
  if (parts[2]) {
    if (isEmail(parts[2])) f.email = parts[2];
    else if (isTokenish(parts[2])) f.token = parts[2];
    else f.email = parts[2];
  }
  if (parts[3]) {
    if (isEmail(parts[3]) && !f.email) f.email = parts[3];
    else if (isTokenish(parts[3])) f.token = parts[3];
    else f.email_password = parts[3];
  }
  if (parts[4]) {
    if (isTokenish(parts[4])) f.token = parts[4];
    else f.extra = parts.slice(4).join(' | ');
  }
  if (parts.length > 5 && !f.extra) f.extra = parts.slice(5).join(' | ');
  return f;
}

function fieldsToText(f) {
  const lines = [];
  if (f.username) lines.push('Username: ' + f.username);
  if (f.password) lines.push('Password: ' + f.password);
  if (f.email) lines.push('Email: ' + f.email);
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
  if (labeled.username || labeled.password || labeled.email) {
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

  const parts = splitDelimiters(text.replace(/\n/g, ' ').replace(/\s+/g, ' '));
  if (parts && parts.length >= 2) {
    const hinted = applyHint(parts, formatHint);
    if (hinted && (hinted.username || hinted.password || hinted.email)) {
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
    const looksLikeAccounts =
      lines.length > 1 && lines.every((ln) => /[:|;]/.test(ln) || /^[^\s]+@[^\s]+/.test(ln));
    if (looksLikeAccounts) chunks = lines;
  }

  const formatted = chunks.map((c) => formatOneAccount(c, hint)).filter(Boolean);
  if (!formatted.length) return text;
  return formatted.join('\n\n');
}

export default formatCredentials;
