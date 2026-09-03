/**
 * Normalize supplier log lines for customer view.
 * URLs are never split on ":". Fields are classified by content, not only order.
 */

function clean(s) {
  return String(s || '').replace(/\r/g, '').replace(/\u0000/g, '').trim();
}
function stripQuotes(s) {
  return clean(s).replace(/^["']|["']$/g, '');
}

function isEmail(s) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(s || '').trim());
}
function isUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}
function isPhone(s) {
  const raw = String(s || '').trim();
  // Bare 10–15 digit IDs are Facebook/UIDs, not phone numbers
  if (/^\d{8,}$/.test(raw)) return false;
  const t = raw.replace(/[\s()-]/g, '');
  return /^\+\d{10,15}$/.test(t);
}

function protectUrls(text) {
  const urls = [];
  let s = String(text || '').replace(/:(https?:\/\/)/gi, '|$1');
  s = s.replace(/https?:\/\/[^\s|;,]+/gi, (m) => {
    const u = m.replace(/[)\].,;]+$/g, '');
    const i = urls.length;
    urls.push(u);
    return `__URL${i}__`;
  });
  return { text: s, urls };
}
function restoreUrls(text, urls) {
  let t = String(text || '');
  for (let i = 0; i < urls.length; i++) t = t.split(`__URL${i}__`).join(urls[i]);
  return t;
}

function isLikely2FA(s) {
  const t = String(s || '').trim();
  if (!t || t.length < 10) return false;
  if (/@/.test(t) || isUrl(t)) return false;
  const compact = t.replace(/[\s-]/g, '');
  if (compact.length < 12 || compact.length > 80) return false;
  if (/^[A-Z2-7]{12,64}$/.test(compact)) return true;
  if (/^[A-Z0-9]{12,64}$/.test(compact) && /[A-Z]/.test(compact) && compact === compact.toUpperCase()) return true;
  if (/^[A-Za-z0-9]{16,64}$/.test(compact) && /[A-Za-z]/.test(compact) && /[0-9]/.test(compact)) return true;
  if (/^(?:[A-Z2-7]{4}\s+){2,}[A-Z2-7]{2,8}$/.test(t) && compact.length >= 12) return true;
  const letters = compact.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 12) {
    const up = (letters.match(/[A-Z]/g) || []).length;
    if (up / letters.length >= 0.7 && compact.length >= 14) return true;
  }
  return false;
}

function isCookieBlob(s) {
  const t = String(s || '').trim();
  if (t.length < 20) return false;
  if (/c_user=|xs=|datr=|sb=|fr=|sessionid=|auth_token=|li_at=/i.test(t)) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(t)) return true; // JWT
  if (t.split(';').length >= 3 && /=/.test(t) && t.length > 40) return true;
  return false;
}

function mapToken(p) {
  const u = String(p || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (/^(USER NAME|USERNAME|USER|LOGIN|ID|UID|ACCOUNT)$/.test(u)) return 'username';
  if (/^(PASS WORD|PASSWORD|PASS|PWD)$/.test(u)) return 'password';
  if (/^(EMAIL PASS(WORD)?|MAIL PASS(WORD)?)$/.test(u)) return 'email_password';
  if (/^(E-?MAIL|MAIL|EMAIL)$/.test(u)) return 'email';
  if (/^(2 FA|2FA|2FA CODE|TWO FA|TOTP|OTP SECRET|SECRET)$/.test(u)) return 'token';
  if (/^(TOKEN|COOKIE|COOKIES|AUTH TOKEN)$/.test(u)) return 'cookie';
  if (/^(PHONE|MOBILE|NUMBER)$/.test(u)) return 'phone';
  if (/^(RECOVERY|RECOVERY MAIL|RECOVERY EMAIL|BACKUP MAIL)$/.test(u)) return 'extra';
  return null;
}

export function parseFormatHint(description) {
  if (!description) return null;
  const text = clean(description);
  let focus = text;
  const fmtBlock = text.match(/(?:delivery\s*format|format|credentials?\s*format)\s*[:\-–]?\s*([^\n]+)/i);
  if (fmtBlock) focus = fmtBlock[1];
  // Only use compact "UID|PASS|2FA" slash lists when that is the whole format.
  // Do NOT shrink "Facebook UID | Facebook Password | 2FA CODE | ..." down to "Password | 2FA".
  const slash = text.match(
    /\b((?:USER(?:NAME)?|PASS(?:WORD)?|EMAIL(?:\s*PASS(?:WORD)?)?|2FA|TOKEN|COOKIE|LOGIN|UID)(?:\s*[\/|]\s*(?:USER(?:NAME)?|PASS(?:WORD)?|EMAIL(?:\s*PASS(?:WORD)?)?|2FA|TOKEN|COOKIE|LOGIN|UID))+)\b/i
  );
  if (slash && /[\/|]/.test(slash[1])) {
    const slashTokens = slash[1].split(/[\/|]/).map((x) => x.trim()).filter(Boolean);
    const focusTokens = (focus.match(/UID|USER(?:NAME)?|PASS(?:WORD)?|2\s*FA|2FA|EMAIL|COOKIE|TOKEN|LOGIN/gi) || []).length;
    if (!fmtBlock || slashTokens.length >= Math.max(3, focusTokens)) focus = slash[1];
  }
  const tokenRe =
    /Email\s*Password|Recovery\s*mail|User\s*name|Username|Password|Login|Email|User|Pass|2\s*FA\s*CODE|2\s*FA|2FA|Token|Cookies?|Phone|Mobile|Uid|ID/gi;
  const found = [];
  let m;
  const re = new RegExp(tokenRe.source, 'gi');
  while ((m = re.exec(focus)) !== null) {
    const key = mapToken(m[0]);
    if (key && !found.includes(key)) found.push(key);
  }
  return found.length >= 2 ? found : null;
}

function classifyPart(p) {
  const s = stripQuotes(p);
  if (!s) return { kind: 'empty', value: s };
  if (isUrl(s)) return { kind: 'url', value: s };
  if (isEmail(s)) return { kind: 'email', value: s };
  if (isCookieBlob(s)) return { kind: 'cookie', value: s };
  if (isLikely2FA(s)) return { kind: 'token', value: s.replace(/\s+/g, '') };
  if (isPhone(s)) return { kind: 'phone', value: s };
  if (/^\d{8,}$/.test(s)) return { kind: 'uid', value: s };
  if (s.length >= 2 && s.length <= 64 && !/\s/.test(s)) return { kind: 'secret', value: s };
  return { kind: 'text', value: s };
}

function fieldsFromClassified(parts) {
  const f = {};
  const extras = [];
  let passwordTaken = false;
  for (const raw of parts) {
    const { kind, value } = classifyPart(raw);
    if (kind === 'empty') continue;
    if (kind === 'email' && !f.email) f.email = value;
    else if (kind === 'uid' && !f.username) f.username = value;
    else if (kind === 'phone' && !f.phone) f.phone = value;
    else if (kind === 'token' && !f.token) f.token = value;
    else if (kind === 'cookie') {
      f.token = f.token ? f.token + ' | ' + value : value;
    } else if (kind === 'url') extras.push(value);
    else if (kind === 'secret') {
      if (!f.username && !f.email) f.username = value;
      else if (!passwordTaken) {
        f.password = value;
        passwordTaken = true;
      } else extras.push(value);
    } else if (kind === 'text') {
      if (!f.username && !isUrl(value) && value.length <= 80) f.username = value;
      else if (!passwordTaken && value.length >= 2 && value.length <= 64 && !/\s/.test(value)) {
        f.password = value;
        passwordTaken = true;
      } else extras.push(value);
    } else extras.push(value);
  }
  if (extras.length) f.extra = extras.join(' | ');
  return f;
}

function splitDelimiters(line, expectedCount) {
  let t = clean(line);
  if (!t) return [];
  t = t.replace(/^\d+\.\s+/, '');
  const { text: protectedText, urls } = protectUrls(t);
  t = protectedText;
  const restoreParts = (parts) =>
    parts.map((p) => restoreUrls(stripQuotes(p), urls)).filter((p) => p.length > 0);

  if (t.includes('|')) {
    let segs = t.split('|').map(stripQuotes).filter(Boolean);
    if (segs.length >= 1 && segs[0].includes(':') && !/^__URL\d+__$/.test(segs[0])) {
      const head = segs[0];
      const em = head.match(/^([^\s:<>]+@[^\s:<>]+)\s*:\s*(.+)$/);
      if (em) segs = [em[1], em[2], ...segs.slice(1)];
      else {
        const colonParts = head.split(':').map(stripQuotes).filter(Boolean);
        if (colonParts.length >= 2) segs = [...colonParts, ...segs.slice(1)];
      }
    }
    return restoreParts(segs);
  }
  if (t.includes(';') && t.split(';').filter(Boolean).length >= 2 && !isCookieBlob(restoreUrls(t, urls))) {
    return restoreParts(t.split(';'));
  }

  const emailHead = t.match(/^([^\s:<>]+@[^\s:<>]+)\s*:\s*(.+)$/);
  if (emailHead) {
    const email = emailHead[1];
    const rest = emailHead[2];
    const segs = rest.split(':').map(stripQuotes).filter(Boolean);
    return restoreParts([email, ...segs]);
  }

  if (t.includes(':')) {
    const parts = t.split(':').map(stripQuotes).filter((p) => p.length > 0);
    if (parts.length >= 2) {
      if (expectedCount && expectedCount >= 2 && parts.length > expectedCount) {
        const head = parts.slice(0, expectedCount - 1);
        const tailParts = parts.slice(expectedCount - 1);
        const tailHasUrl = tailParts.some((x) => /__URL\d+__/.test(x) || /^https?:/i.test(x));
        if (tailHasUrl) return restoreParts([...head, ...tailParts]);
        return restoreParts([...head, tailParts.join(':')]);
      }
      return restoreParts(parts);
    }
  }

  // Space-separated unlabeled tokens first (uid pass 2FA url)
  const spaced = splitSpacedTokens(restoreUrls(t, urls));
  if (spaced && spaced.length >= 2) return spaced;

  const prose = parseProseCredential(restoreUrls(t, urls));
  if (prose && prose.length >= 2) return prose;

  return restoreParts([t]);
}

function splitSpacedTokens(text) {
  const raw = clean(text);
  if (!raw) return null;
  const { text: prot, urls } = protectUrls(raw);
  const LABEL = /^(uid|user(?:name)?|login|id|pass(?:word)?|pwd|email|mail|token|2fa|link|url|number)$/i;
  const tokens = prot
    .split(/\s+/)
    .map((x) => restoreUrls(stripQuotes(x), urls))
    .filter((x) => x && !LABEL.test(x));
  if (tokens.length < 2) return null;
  // Need at least two classifiable pieces (email/uid/secret/token/url)
  let useful = 0;
  for (const tok of tokens) {
    const k = classifyPart(tok).kind;
    if (k !== 'empty' && k !== 'text') useful += 1;
    else if (k === 'text' && tok.length >= 2 && tok.length <= 64) useful += 1;
  }
  if (useful < 2) return null;
  return tokens;
}

function parseProseCredential(text) {
  const t = clean(text);
  if (!t || t.length < 6) return null;
  const passM = t.match(/\b(?:password|pass|pwd)\s*[:=\-]?\s*(\S+)/i);
  const uidM =
    t.match(/\b(?:uid|user(?:name)?|login|id)\s*(?:number)?\s*[:=\-]?\s*(\d{6,})\b/i) ||
    t.match(/\b(\d{10,})\b/);
  const emailM = t.match(/\b([^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)\b/);
  const { urls } = protectUrls(t);
  const flat = t.replace(/[\n\r]+/g, ' ');
  const spaced2fa = flat.match(/\b(?:[A-Z2-7]{2,8}(?:\s+[A-Z0-9]{2,8}){2,})\b/);
  const compact2fa = t.match(/\b([A-Z2-7]{12,64})\b/);
  const links = urls.length ? urls : t.match(/https?:\/\/[^\s]+/gi) || [];
  if (!passM && !uidM && !emailM && links.length < 1 && !spaced2fa) return null;
  const parts = [];
  if (emailM) parts.push(emailM[1]);
  if (uidM) parts.push(uidM[1]);
  if (passM && !/^(https?)$/i.test(passM[1])) parts.push(passM[1]);
  if (spaced2fa) parts.push(spaced2fa[0].replace(/\s+/g, ''));
  else if (compact2fa && isLikely2FA(compact2fa[1])) parts.push(compact2fa[1]);
  for (const u of links) if (!parts.includes(u)) parts.push(u);
  return parts.length >= 2 ? parts : null;
}


function pretty2fa(s) {
  const compact = String(s || '').replace(/\s+/g, '').toUpperCase();
  if (!compact) return s;
  return compact.match(/.{1,4}/g).join(' ');
}
function tokenFrom2faUrl(s) {
  const m = String(s || '').match(/2fa\.live\/([A-Za-z0-9]{10,80})/i);
  return m ? m[1].replace(/\s+/g, '').toUpperCase() : '';
}
function polishLabeled(labeled, original) {
  const f = { ...labeled };
  const blob = [original, f.extra, f.token, f.password, f.username].filter(Boolean).join('\n');
  if (f.token && isUrl(String(f.token))) {
    const fromTok = tokenFrom2faUrl(f.token);
    if (fromTok) {
      f.extra = [f.token, f.extra].filter(Boolean).join(' | ');
      f.token = fromTok;
    }
  }
  if (!f.token) {
    const fromUrl = tokenFrom2faUrl(blob);
    if (fromUrl) f.token = fromUrl;
  }
  if (!/^(?:Email|Username|Password|2FA)\s*:/im.test(String(original || ''))) {
    const { text: prot, urls } = protectUrls(String(original || '').replace(/\n+/g, ' '));
    const bits = prot.split(/[:|]+/).map((x) => restoreUrls(stripQuotes(x), urls)).filter(Boolean);
    if (bits.length >= 2 && !isUrl(bits[0]) && !/^https?$/i.test(bits[0])) {
      if (!f.username && !f.email && !isLikely2FA(bits[0]) && !/^(email|username|user|password|pass|2fa|token|extra)$/i.test(bits[0])) f.username = bits[0];
      if (!f.password && bits[1] && !isUrl(bits[1]) && !isLikely2FA(bits[1])) f.password = bits[1];
    }
  }
  if (f.token) {
    const compact = String(f.token).replace(/\s+/g, '').toUpperCase();
    const extra = String(f.extra || '');
    if (/2fa\.live\//i.test(extra) && extra.toUpperCase().includes(compact)) {
      delete f.extra;
    }
    f.token = pretty2fa(compact);
  }
  return f;
}
function extractLabeled(text) {
  const out = {};
  const { text: protectedText, urls } = protectUrls(clean(text));
  const patterns = [
    ['username', /(?:^|\n)\s*(?:user\s*name|username|user\s*id|\blogin\b|\buid\b|\bid\b)\s*[:=\-]\s*(.+)/i],
    ['password', /(?:^|\n)\s*(?:pass\s*word|password|\bpass\b|\bpwd\b)\s*[:=\-]\s*(.+)/i],
    ['email_password', /(?:^|\n)\s*(?:email\s*pass(?:word)?|mail\s*pass(?:word)?)\s*[:=\-]\s*(.+)/i],
    ['email', /(?:^|\n)\s*(?:e-?mail\s*address|e-?mail|\bmail\b)\s*[:=\-]\s*(.+)/i],
    ['token', /(?:^|\n)\s*(?:2\s*fa\s*\/\s*token|auth\s*token|\btoken\b|\bcookie\b|2\s*fa|\b2fa\b|otp\s*secret)\s*[:=\-]\s*(.+)/i],
    ['phone', /(?:^|\n)\s*(?:\bphone\b|\bmobile\b)\s*[:=\-]\s*(.+)/i]
  ];
  const lines = protectedText.split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [key, re] of patterns) {
      const m = line.match(re);
      if (m && m[1] && !out[key]) {
        let val = m[1].trim();
        if (!val || /^[:\-–]*$/.test(val)) {
          if (lines[i + 1] && !/^[A-Za-z0-9].*[=:]/.test(lines[i + 1])) val = lines[i + 1].trim();
        }
        val = val
          .replace(
            /\s+(?:User\s*name|Username|User\s*id|Login|User|Password|Pass|Pwd|E-?mail|Mail|Token|Cookie|2\s*FA\s*\/\s*Token|2\s*FA|2FA|Phone|Mobile|Uid)\s*[:=].*$/i,
            ''
          )
          .trim();
        if (key !== 'token') val = val.replace(/\s*[|]\s*.*$/, '').trim();
        val = restoreUrls(val, urls);
        if (val) out[key] = stripQuotes(val);
      }
    }
  }
  return out;
}

function applyHint(parts, hintKeys) {
  const f = {};
  if (!parts || !parts.length || !hintKeys || !hintKeys.length) return null;
  const extras = [];
  const n = Math.min(parts.length, hintKeys.length);
  for (let i = 0; i < n; i++) {
    const key = hintKeys[i];
    const val = parts[i];
    if (!key || val == null || val === '') continue;
    if (key === 'extra') {
      extras.push(val);
      continue;
    }
    if (key === 'cookie') {
      extras.push(val);
      continue;
    }
    if (isUrl(val) && (key === 'password' || key === 'token' || key === 'email_password')) {
      extras.push(val);
      continue;
    }
    if (isCookieBlob(val) && key !== 'token') {
      extras.push(val);
      continue;
    }
    if (isEmail(val) && key !== 'email') {
      if (!f.email) f.email = val;
      else extras.push(val);
      continue;
    }
    if (isLikely2FA(val) && key !== 'token') {
      if (!f.token) f.token = val;
      else extras.push(val);
      continue;
    }
    f[key] = val;
  }
  if (parts.length > hintKeys.length) extras.push(...parts.slice(hintKeys.length));
  if (extras.length) f.extra = [f.extra, extras.join(' | ')].filter(Boolean).join(' | ');
  return f;
}

function mergePreferContent(parts, hinted) {
  const c = fieldsFromClassified(parts || []);
  const f = { ...(hinted || {}) };
  if (c.email) f.email = c.email;
  if (c.username) f.username = c.username;
  if (c.password && !isEmail(c.password) && !isLikely2FA(c.password) && !/^\d{8,}$/.test(c.password)) {
    f.password = c.password;
  }
  if (c.token) f.token = c.token;
  if (c.phone && !f.phone) f.phone = c.phone;
  if (f.email_password && isEmail(f.email_password)) {
    if (!f.email) f.email = f.email_password;
    delete f.email_password;
  }
  if (f.email_password && isLikely2FA(f.email_password)) {
    if (!f.token) f.token = f.email_password;
    delete f.email_password;
  }
  if (f.password && isLikely2FA(f.password) && !f.token) {
    f.token = f.password;
    if (c.password && c.password !== f.password) f.password = c.password;
    else delete f.password;
  }
  if (f.password && /^\d{8,}$/.test(String(f.password)) && c.password && c.password !== f.password) {
    f.password = c.password;
  }
  const used = new Set(
    [f.email, f.username, f.password, f.token, f.email_password, f.phone]
      .filter(Boolean)
      .map((x) => String(x).replace(/\s+/g, '').toLowerCase())
  );
  const leftover = [];
  for (const p of parts || []) {
    const key = String(p || '').replace(/\s+/g, '').toLowerCase();
    if (!key || used.has(key)) continue;
    leftover.push(String(p).trim());
  }
  if (leftover.length) f.extra = leftover.join(' | ');
  else if (c.extra && !f.extra) f.extra = c.extra;
  return f;
}

function flattenJsonObject(obj, depth) {
  if (!obj || typeof obj !== 'object' || depth > 3) return {};
  const f = {};
  const extras = [];
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 3) return;
    for (const [k, v] of Object.entries(o)) {
      if (v == null) continue;
      const key = String(k).toLowerCase();
      if (typeof v === 'object' && !Array.isArray(v)) {
        walk(v, d + 1);
        continue;
      }
      const val = Array.isArray(v) ? v.map(String).join(' | ') : String(v);
      if (/^(user(name)?|login|uid|id|account)$/.test(key) && !f.username) f.username = val;
      else if (/^(pass(word)?|pwd)$/.test(key) && !f.password) f.password = val;
      else if (/^(email|mail)$/.test(key) && !f.email) f.email = val;
      else if (/email.?pass/.test(key) && !f.email_password) f.email_password = val;
      else if (/^(token|cookie|secret|2fa|twofa|otp)$/.test(key) && !f.token) f.token = val;
      else if (/^(phone|mobile)$/.test(key) && !f.phone) f.phone = val;
      else if (/^(url|link|profile|extra)$/.test(key)) extras.push(val);
      else if (isEmail(val) && !f.email) f.email = val;
      else if (isUrl(val)) extras.push(val);
    }
  };
  walk(obj, 0);
  if (extras.length) f.extra = extras.join(' | ');
  return f;
}

function splitMultipleAccounts(text) {
  const t = clean(text);
  if (!t) return [t];

  const blank = t.split(/\n\s*\n|\n-{3,}\n|\n={3,}\n/).map(clean).filter(Boolean);
  if (blank.length > 1) return blank;

  // Repeated email:pass on new lines
  const lines = t.split(/\n+/).map(clean).filter(Boolean);
  const emailPassLines = lines.filter((ln) => /^[^\s@]+@[^\s@]+\.[^\s@]+\s*[:|;]\s*\S+/.test(ln));
  if (emailPassLines.length >= 2 && emailPassLines.length === lines.length) return lines;

  // Two emails in one blob → split before second email
  const emails = [...t.matchAll(/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/g)];
  if (emails.length >= 2) {
    const chunks = [];
    let last = 0;
    for (let i = 0; i < emails.length; i++) {
      const start = emails[i].index;
      if (i === 0) continue;
      const slice = t.slice(last, start).trim();
      if (slice) chunks.push(slice);
      last = start;
    }
    const tail = t.slice(last).trim();
    if (tail) chunks.push(tail);
    if (chunks.length >= 2) return chunks;
  }

  // Two long digit uids — ignore IDs that sit inside a URL
  const uids = [...t.matchAll(/\b\d{10,}\b/g)].filter((m) => {
    const before = t.slice(Math.max(0, m.index - 40), m.index);
    return !/https?:\/\/\S*$/i.test(before) && !/profile\.php\?id=$/i.test(before);
  });
  if (uids.length >= 2 && uids[1].index - uids[0].index > 8) {
    const mid = uids[1].index;
    const a = t.slice(0, mid).trim();
    const b = t.slice(mid).trim();
    if (a.length > 8 && b.length > 8) return [a, b];
  }
  return [t];
}

function cleanupFields(f) {
  if (f.password && /^(https?)$/i.test(String(f.password).trim())) delete f.password;
  if (f.username && /^(https?)$/i.test(String(f.username).trim())) delete f.username;
  const em = String(f.email || '').trim().toLowerCase();
  const un = String(f.username || '').trim().toLowerCase();
  // Same login printed twice (email used as username)
  if (em && un && em === un) delete f.username;
  // Username field is actually an email and Email is empty → keep Email only
  if (!em && un && isEmail(f.username)) {
    f.email = f.username;
    delete f.username;
  }
  if (f.password && /^\/\//.test(String(f.password).trim())) {
    f.extra = ['https:' + f.password, f.extra].filter(Boolean).join(' | ');
    delete f.password;
  }
  if (f.token && /^\/\//.test(String(f.token).trim())) f.token = 'https:' + f.token;
  if (f.token && isLikely2FA(f.token)) f.token = String(f.token).replace(/\s+/g, '');
  return f;
}

function fieldsToText(f) {
  f = cleanupFields({ ...f });
  f = polishLabeled(f, [f.username, f.email, f.password, f.token, f.extra].filter(Boolean).join('\n'));
  const lines = [];
  if (f.email) lines.push('Email: ' + f.email);
  if (f.username) lines.push('Username: ' + f.username);
  if (f.password) lines.push('Password: ' + f.password);
  if (f.email_password) lines.push('Email Password: ' + f.email_password);
  if (f.phone) lines.push('Phone: ' + f.phone);
  if (f.token) {
    lines.push((isCookieBlob(f.token) ? 'Cookie / Token: ' : '2FA / Token: ') + (isCookieBlob(f.token) ? f.token : pretty2fa(f.token)));
  }
  if (f.extra) lines.push('Extra: ' + f.extra);
  return lines.join('\n');
}

function repairBrokenFormatted(text) {
  let s = clean(text);
  if (!s) return '';
  if (!/\/\/[a-z0-9.-]+/i.test(s) && !/\bhttps\s*$/im.test(s) && !/Username:.*\bpassword\b/i.test(s)) {
    return '';
  }
  const flat = s.replace(/[\n\r]+/g, ' ');
  const secretMatches = flat.match(/\b(?:[A-Z2-7]{2,8}(?:\s+[A-Z0-9]{2,8}){2,})\b/g) || [];
  let token = '';
  for (const m of secretMatches) {
    const c = m.replace(/\s+/g, '');
    if (c.length >= 12 && c.length <= 64 && c.length > token.length) token = c;
  }
  const uidM = s.match(/\b(?:uid\s*number\s*)?(\d{10,})\b/i);
  const username = uidM ? uidM[1] : '';
  let password = '';
  const passM = s.match(/\bpassword\s*[:=\-]?\s*([A-Za-z0-9._@!#$%*-]+)/i);
  if (passM && !/^(https?)$/i.test(passM[1]) && !/^\/\//.test(passM[1])) password = passM[1];
  const links = [];
  const fbIds = [...s.matchAll(/profile\.php\?\s*id=(\d+)/gi)].map((x) => x[1]);
  for (const id of fbIds) {
    const u = 'https://www.facebook.com/profile.php?id=' + id;
    if (!links.includes(u)) links.push(u);
  }
  if (/2fa\.live/i.test(s)) {
    const u = token ? 'https://2fa.live/' + token : 'https://2fa.live/';
    if (!links.some((l) => l.includes('2fa.live'))) links.unshift(u);
  }
  if (!username && !password && !token) return '';
  const lines = [];
  if (username) lines.push('Username: ' + username);
  if (password) lines.push('Password: ' + password);
  if (token) lines.push('2FA / Token: ' + token);
  if (links.length) lines.push('Extra: ' + links.join(' | '));
  return lines.join('\n');
}

export function formatOneAccount(raw, formatHint) {
  const text = clean(raw);
  if (!text) return '';

  const labeled = polishLabeled(extractLabeled(text), text);
  const previewParts = splitDelimiters(text.replace(/\n/g, ' ').replace(/\s+/g, ' '), Array.isArray(formatHint) ? formatHint.length : 0);
  const previewClassified = fieldsFromClassified(previewParts || []);
  const labeledMissing =
    (previewClassified.email && !labeled.email) ||
    (previewClassified.token && !labeled.token) ||
    (previewClassified.extra && !labeled.extra && !labeled.token);
  if (!labeledMissing && (labeled.password || labeled.username || labeled.email || labeled.token)) {
    if (labeled.password && /^(https?)$/i.test(labeled.password)) {
      /* keep going */
    } else if (/^(Email|Username|Password|2FA \/ Token|2FA|Phone|Cookie)\s*:/im.test(text)) {
      return fieldsToText(labeled);
    } else {
      return fieldsToText(mergePreferContent(previewParts, labeled));
    }
  }

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const j = JSON.parse(text);
      const obj = Array.isArray(j) ? j[0] : j;
      if (obj && typeof obj === 'object') {
        const t = fieldsToText(flattenJsonObject(obj, 0));
        if (t) return t;
      }
    } catch (_) {}
  }

  const expected = Array.isArray(formatHint) ? formatHint.length : 0;
  const parts = splitDelimiters(text.replace(/\n/g, ' ').replace(/\s+/g, ' '), expected);
  if (globalThis.DEBUGFMT) console.log('parts', parts, 'hint', formatHint);
  if (parts && parts.length >= 2) {
    const hinted = applyHint(parts, formatHint);
    if (hinted && (hinted.username || hinted.password || hinted.email || hinted.token || hinted.email_password)) {
      return fieldsToText(mergePreferContent(parts, hinted));
    }
    return fieldsToText(mergePreferContent(parts, null));
  }

  const lines = text.split(/\n+/).map(clean).filter(Boolean);
  if (lines.length >= 2 && !lines[0].includes(' ')) {
    const hinted = applyHint(lines, formatHint);
    if (hinted) return fieldsToText(mergePreferContent(lines, hinted));
    return fieldsToText(mergePreferContent(lines, null));
  }

  const prose = parseProseCredential(text);
  if (prose && prose.length >= 2) return fieldsToText(fieldsFromClassified(prose));

  const spaced = splitSpacedTokens(text);
  if (spaced && spaced.length >= 2) return fieldsToText(fieldsFromClassified(spaced));

  if (isCookieBlob(text)) return fieldsToText({ token: text });

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

  const alreadyLabeled = /^(Email|Username|Password|2FA \/ Token|2FA|Phone)\s*:/im.test(text);
  if (!alreadyLabeled) {
    const repaired = repairBrokenFormatted(text);
    if (repaired && (repaired.includes('Password:') || repaired.includes('2FA'))) return repaired;
  }

  const hint = parseFormatHint(description);
  const chunks = splitMultipleAccounts(text);
  const formatted = chunks.map((c) => formatOneAccount(c, hint)).filter(Boolean);
  if (!formatted.length) return text;
  if (formatted.length === 1) return formatted[0];
  return formatted.map((b, i) => String(i + 1) + '. ' + b).join('\n\n');
}

export default formatCredentials;

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
