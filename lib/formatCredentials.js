/**
 * Normalize supplier log lines using optional product description format hints.
 * Critical: never split https:// or http:// on ":" — that was mangling Facebook/2FA links.
 */

function clean(s) {
  return String(s || '').replace(/\r/g, '').replace(/\u0000/g, '').trim();
}
function stripQuotes(s) {
  return clean(s).replace(/^["']|["']$/g, '');
}

/** Protect URLs so delimiter splits do not break scheme:// */
function protectUrls(text) {
  const urls = [];
  // Separate adjacent URLs stuck with ":" (common in supplier packs)
  let s = String(text || '').replace(/:(https?:\/\/)/gi, '|$1');
  s = s.replace(/https?:\/\/[^\s|;,]+/gi, (m) => {
    let u = m.replace(/[)\].,;]+$/g, '');
    const i = urls.length;
    urls.push(u);
    return `__URL${i}__`;
  });
  return { text: s, urls };
}
function restoreUrls(text, urls) {
  let t = String(text || '');
  for (let i = 0; i < urls.length; i++) {
    t = t.split(`__URL${i}__`).join(urls[i]);
  }
  return t;
}

/** TOTP / authenticator secrets are usually uppercase base32-ish */
function isLikely2FA(s) {
  const t = String(s || '').trim();
  if (!t || t.length < 10) return false;
  if (/@/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  // "RVYQ DU4M 70X2 6ZWD SE3V TEWI EGI6 ECDK" → compact base32-ish
  const compact = t.replace(/\s+/g, '');
  if (/^[A-Z2-7]{12,64}$/.test(compact)) return true;
  if (/^[A-Z0-9]{12,64}$/.test(compact) && /[A-Z]/.test(compact) && compact === compact.toUpperCase()) return true;
  // Spaced groups of 4 (authenticator style)
  if (/^(?:[A-Z2-7]{4}\s+){2,}[A-Z2-7]{2,8}$/.test(t.trim()) && compact.length >= 12) return true;
  const letters = compact.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 12) {
    const up = (letters.match(/[A-Z]/g) || []).length;
    if (up / letters.length >= 0.8 && compact.length >= 14) return true;
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

  const slash = text.match(
    /\b((?:USER(?:NAME)?|PASS(?:WORD)?|EMAIL(?:\s*PASS(?:WORD)?)?|2FA|TOKEN|COOKIE|LOGIN)(?:\s*[\/|]\s*(?:USER(?:NAME)?|PASS(?:WORD)?|EMAIL(?:\s*PASS(?:WORD)?)?|2FA|TOKEN|COOKIE|LOGIN))+)/i
  );
  if (slash && /[\/|]/.test(slash[1])) focus = slash[1];

  const tokenRe =
    /Email\s*Password|User\s*name|Username|Password|Login|Email|User|Pass|2\s*FA|2FA|Token|Cookie|Phone|Mobile|Uid|ID/gi;
  const found = [];
  let m;
  const re = new RegExp(tokenRe.source, 'gi');
  while ((m = re.exec(focus)) !== null) {
    const key = mapToken(m[0]);
    if (key && !found.includes(key)) found.push(key);
  }
  return found.length >= 2 ? found : null;
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
    // Expand first segment if still uid:password or email:password
    if (segs.length >= 1 && segs[0].includes(':') && !/^__URL\d+__$/.test(segs[0])) {
      const head = segs[0];
      const em = head.match(/^([^\s:<>]+@[^\s:<>]+)\s*:\s*(.+)$/);
      if (em) {
        segs = [em[1], em[2], ...segs.slice(1)];
      } else {
        const colonParts = head.split(':').map(stripQuotes).filter(Boolean);
        if (colonParts.length >= 2) {
          segs = [...colonParts, ...segs.slice(1)];
        }
      }
    }
    return restoreParts(segs);
  }
  if (t.includes(';') && t.split(';').length >= 2) {
    return restoreParts(t.split(';'));
  }

  // email:password:… with URLs already protected
  const emailHead = t.match(/^([^\s:<>]+@[^\s:<>]+)\s*:\s*(.+)$/);
  if (emailHead) {
    const email = emailHead[1];
    const rest = emailHead[2];
    const segs = rest.split(':').map(stripQuotes).filter(Boolean);
    const n = expectedCount && expectedCount >= 2 ? expectedCount : 0;

    let twoFaIdx = -1;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (isLikely2FA(restoreUrls(segs[i], urls))) {
        twoFaIdx = i;
        break;
      }
    }

    if (twoFaIdx >= 0) {
      const token = segs[twoFaIdx];
      const before = segs.slice(0, twoFaIdx);
      const after = segs.slice(twoFaIdx + 1);
      const password = before[0] || '';
      const middle = before.slice(1).join(':');
      const leftover = [middle, after.join(':')].filter(Boolean).join(' | ');
      if (n === 2) return restoreParts(password ? [email, password] : [email, token]);
      if (password && leftover) return restoreParts([email, password, token, leftover]);
      if (password) return restoreParts([email, password, token]);
      if (leftover) return restoreParts([email, token, leftover]);
      return restoreParts([email, token]);
    }

    if (n === 2) return restoreParts([email, rest]);
    if (n >= 3 && segs.length >= 2) {
      return restoreParts([email, segs[0], segs.slice(1).join(':')]);
    }
    if (segs.length >= 2) {
      return restoreParts([email, segs[0], segs.slice(1).join(':')]);
    }
    return restoreParts([email, rest]);
  }

  // Colon split ONLY after URLs are protected (placeholders have no colons)
  if (t.includes(':')) {
    const parts = t.split(':').map(stripQuotes).filter((p) => p.length > 0);
    if (parts.length >= 2) {
      if (expectedCount && expectedCount >= 2 && parts.length > expectedCount) {
        // Keep URL placeholders as separate parts — joining with ":" would re-break them later
        const head = parts.slice(0, expectedCount - 1);
        const tailParts = parts.slice(expectedCount - 1);
        const tailHasUrl = tailParts.some((x) => /__URL\d+__/.test(x) || /^https?:/i.test(x));
        if (tailHasUrl) return restoreParts([...head, ...tailParts]);
        const tail = tailParts.join(':');
        return restoreParts([...head, tail]);
      }
      return restoreParts(parts);
    }
  }

  // Space-separated prose: "uid number X password Y https://... Facebook link https://..."
  const prose = parseProseCredential(restoreUrls(t, urls));
  if (prose && prose.length >= 2) return prose;

  return restoreParts([t]);
}

/**
 * Free-text supplier lines without | or clean email:pass
 */
function parseProseCredential(text) {
  const t = clean(text);
  if (!t || t.length < 6) return null;

  // Pattern: ... password <pwd> ... or pass <pwd>
  const passM = t.match(/\b(?:password|pass|pwd)\s*[:=\-]?\s*(\S+)/i);
  // uid / username number
  const uidM =
    t.match(/\b(?:uid|user(?:name)?|login|id)\s*(?:number)?\s*[:=\-]?\s*(\d{6,})\b/i) ||
    t.match(/\b(\d{10,})\b/);

  const { urls } = protectUrls(t);
  const tokenish = t.match(/\b([A-Z2-7]{12,64})\b/);
  const links = urls.length ? urls : (t.match(/https?:\/\/[^\s]+/gi) || []);

  if (!passM && !uidM && links.length < 1) return null;

  const parts = [];
  if (uidM) parts.push(uidM[1]);
  if (passM) parts.push(passM[1]);
  if (tokenish && isLikely2FA(tokenish[1])) parts.push(tokenish[1]);
  for (const u of links) {
    if (!parts.includes(u)) parts.push(u);
  }
  return parts.length >= 2 ? parts : null;
}

function extractLabeled(text) {
  const out = {};
  // Work on URL-protected text so "Password: https://..." stays one value
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
          if (lines[i + 1] && !/^[A-Za-z0-9].*[=:]/.test(lines[i + 1])) {
            val = lines[i + 1].trim();
          }
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
    // http(s) links are not passwords or TOTP secrets — park in Extra
    if (/^https?:\/\//i.test(val) && (key === 'password' || key === 'token' || key === 'email_password')) {
      extras.push(val);
      continue;
    }
    f[key] = val;
  }
  if (parts.length > hintKeys.length) {
    extras.push(...parts.slice(hintKeys.length));
  }
  if (extras.length) f.extra = [f.extra, extras.join(' | ')].filter(Boolean).join(' | ');
  return f;
}

function partsToFields(parts) {
  const f = {};
  if (!parts || !parts.length) return f;
  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const isUrl = (s) => /^https?:\/\//i.test(s);
  const isTokenish = (s) =>
    isLikely2FA(s) || (!isUrl(s) && (s.length > 40 || /^(otpauth|eyJ|ghp_|sk-)/i.test(s)));

  if (parts.length === 1) {
    f.username = parts[0];
    return f;
  }
  if (parts.length === 2) {
    if (isEmail(parts[0])) {
      f.email = parts[0];
      f.password = parts[1];
    } else if (isUrl(parts[1])) {
      f.username = parts[0];
      f.extra = parts[1];
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

  // Password = first non-url non-2fa after identity
  while (i < parts.length && (isUrl(parts[i]) || isLikely2FA(parts[i]))) {
    i++;
  }
  if (i < parts.length && !isUrl(parts[i])) {
    f.password = parts[i];
    i++;
  }

  const extras = [];
  const tokens = [];
  for (; i < parts.length; i++) {
    const p = parts[i];
    if (isLikely2FA(p) || isTokenish(p)) tokens.push(p);
    else extras.push(p);
  }
  if (tokens.length) f.token = tokens.join(' | ');
  if (extras.length) f.extra = extras.join(' | ');
  return f;
}

function cleanupFields(f) {
  // Drop bogus password that is only "https" (broken URL split leftover)
  if (f.password && /^(https?)$/i.test(String(f.password).trim())) {
    delete f.password;
  }
  if (f.username && /^(https?)$/i.test(String(f.username).trim())) {
    delete f.username;
  }
  // If password starts with // it was a broken URL — move to extra
  if (f.password && /^\/\//.test(String(f.password).trim())) {
    f.extra = ['https:' + f.password, f.extra].filter(Boolean).join(' | ');
    delete f.password;
  }
  if (f.token && /^\/\//.test(String(f.token).trim())) {
    f.token = 'https:' + f.token;
  }
  return f;
}

function fieldsToText(f) {
  f = cleanupFields({ ...f });
  const lines = [];
  if (f.email) lines.push('Email: ' + f.email);
  if (f.username) lines.push('Username: ' + f.username);
  if (f.password) lines.push('Password: ' + f.password);
  if (f.email_password) lines.push('Email Password: ' + f.email_password);
  if (f.phone) lines.push('Phone: ' + f.phone);
  if (f.token) lines.push('2FA / Token: ' + f.token);
  if (f.extra) lines.push('Extra: ' + f.extra);
  return lines.join('\n');
}


/**
 * Repair credentials that were mangled by colon-splitting https:// URLs.
 * e.g. "Password: //2fa.live RVYQ … ECDK" + "https" fragments
 */
function repairBrokenFormatted(text) {
  let s = clean(text);
  if (!s) return '';
  // Only attempt when it looks mangled
  if (!/\/\/[a-z0-9.-]+/i.test(s) && !/\bhttps\s*$/im.test(s) && !/\bpassword ashraful/i.test(s)) {
    // still try if username line embeds "password"
    if (!/Username:.*\bpassword\b/i.test(s)) return '';
  }

  // Collect 2FA secret across line breaks: "RVYQ DU4M 70X2\n6ZWD SE3V TEWI EGI6 ECDK"
  const flat = s.replace(/[\n\r]+/g, ' ');
  const secretMatches = flat.match(/\b(?:[A-Z2-7]{2,8}(?:\s+[A-Z0-9]{2,8}){2,})\b/g) || [];
  let token = '';
  for (const m of secretMatches) {
    const c = m.replace(/\s+/g, '');
    if (c.length >= 12 && c.length <= 64 && c.length > token.length) token = c;
  }

  // UID / username digits
  const uidM = s.match(/\b(?:uid\s*number\s*)?(\d{10,})\b/i);
  const username = uidM ? uidM[1] : '';

  // Password: after word password, not a url fragment
  let password = '';
  const passM = s.match(/\bpassword\s*[:=\-]?\s*([A-Za-z0-9._@!#$%*-]+)/i);
  if (passM && !/^(https?)$/i.test(passM[1]) && !/^\/\//.test(passM[1])) {
    password = passM[1];
  }

  // Rebuild URLs from //host fragments and https leftovers
  const links = [];
  // //2fa.live … or //www.facebook.com/…
  // facebook profile ids
  const fbIds = [...s.matchAll(/profile\.php\?\s*id=(\d+)/gi)].map((x) => x[1]);
  for (const id of fbIds) {
    const u = 'https://www.facebook.com/profile.php?id=' + id;
    if (!links.includes(u)) links.push(u);
  }
  if (/2fa\.live/i.test(s)) {
    const u = token
      ? 'https://2fa.live/' + token
      : 'https://2fa.live/';
    if (!links.some((l) => l.includes('2fa.live'))) links.unshift(u);
  }
  const fragRe = /\/\/((?:2fa\.live|www\.[a-z0-9.-]+|[a-z0-9.-]+\.[a-z]{2,})[^\s]*)/gi;
  let fm;
  while ((fm = fragRe.exec(flat)) !== null) {
    let path = fm[1].replace(/\s+/g, '');
    path = path.replace(/(?:Facebook|link|page).*$/i, '');
    if (token) path = path.split(token).join('');
    path = path.replace(/(?:[A-Z2-7]{4}){3,}/g, '');
    if (path.length > 5 && !links.some((l) => l.includes(path.slice(0, 24)))) {
      links.push('https://' + path.replace(/\/+$/, ''));
    }
  }
  // Standard full URLs if any survived
  const full = s.match(/https?:\/\/[^\s]+/gi) || [];
  for (const u of full) {
    if (!links.includes(u)) links.push(u);
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

  // Already well-labeled and clean?
  const labeled = extractLabeled(text);
  if (labeled.password && (labeled.username || labeled.email)) {
    // Reject if password looks like broken URL fragment
    if (!/^(https?)$/i.test(labeled.password) && !/^\/\//.test(labeled.password)) {
      return fieldsToText(labeled);
    }
  }
  if (labeled.email && labeled.token && !labeled.password) {
    // fall through
  } else if (
    (labeled.username || labeled.password || labeled.email) &&
    labeled.password &&
    !/^(https?)$/i.test(labeled.password)
  ) {
    return fieldsToText(labeled);
  }

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const j = JSON.parse(text);
      const obj = Array.isArray(j) ? j[0] : j;
      if (obj && typeof obj === 'object') {
        const t = fieldsToText({
          username: obj.username || obj.user || obj.login || obj.id || obj.account || obj.uid,
          password: obj.password || obj.pass || obj.pwd,
          email: obj.email || obj.mail,
          email_password: obj.email_password || obj.emailPassword || obj.mail_pass,
          token: obj.token || obj.cookie || obj['2fa'] || obj.twofa || obj.secret,
          phone: obj.phone || obj.mobile,
          extra: obj.link || obj.url || obj.profile || obj.extra
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

  // Fix rows already saved with broken colon-split URLs
  const repaired = repairBrokenFormatted(text);
  if (repaired && (repaired.includes('Password:') || repaired.includes('2FA'))) {
    return repaired;
  }

  const hint = parseFormatHint(description);

  let chunks = text.split(/\n\s*\n|\n-{3,}\n|\n={3,}\n/).map(clean).filter(Boolean);
  if (chunks.length === 1) {
    const lines = text.split(/\n+/).map(clean).filter(Boolean);
    const looksLabeled = lines.some((ln) =>
      /^(Username|Password|Email|Email Password|Phone|2FA\s*\/\s*Token|Token|User|Login)\s*:/i.test(ln)
    );
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
 * Join raw supplier payloads for admin without reformatting.
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
