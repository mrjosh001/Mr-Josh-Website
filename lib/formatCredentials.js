/**
 * MJ Hub credential formatter
 * tabs (labeled + unlabeled), space FB logs, colon chains
 * LinkedIn email:pass:user:2fa, Nextdoor email:pass:email:pass, TextPlus Number/Location
 */

function clean(s) {
  return String(s ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
}
function stripQuotes(s) {
  return clean(s).replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
}
function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(s));
}
function isUrl(s) {
  return /^(?:https?|ftp):\/\/\S+/i.test(clean(s));
}
function isLikely2FA(s) {
  const t = String(s || '').trim();
  if (!t || t.length < 8) return false;
  if (/@/.test(t) || /^https?:\/\//i.test(t)) return false;
  const compact = t.replace(/\s+/g, '');
  if (/^[A-Z2-7]{8,64}$/.test(compact)) return true;
  if (/^[A-Z0-9]{16,64}$/.test(compact) && compact === compact.toUpperCase()) return true;
  if (/^[A-Z0-9]{3,5}(?:\s+[A-Z0-9]{3,5}){1,6}$/.test(t) && t === t.toUpperCase()) return true;
  return false;
}
function isLikelyUsername(s) {
  const t = String(s || '').trim();
  if (!t || isEmail(t) || isUrl(t) || isLikely2FA(t)) return false;
  if (/^[a-z0-9][a-z0-9._-]{2,64}$/i.test(t) && /[-_]/.test(t)) return true;
  if (/^[a-zA-Z][a-zA-Z0-9._]{2,40}$/.test(t) && !/^[A-Z0-9]+$/.test(t)) return true;
  return false;
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
  if (f.email_password && f.email_password !== f.password) lines.push('Email Password: ' + f.email_password);
  if (f.activation_code) lines.push('Activation Code: ' + f.activation_code);
  if (f.phone) lines.push('Number: ' + f.phone);
  if (f.location) lines.push('Location: ' + f.location);
  if (f.twofa_url) lines.push('2FA URL: ' + f.twofa_url);
  if (f.token) lines.push('2FA / Token: ' + f.token);
  if (f.profile_url) {
    if (/facebook\.com/i.test(f.profile_url)) lines.push('Facebook Link: ' + f.profile_url);
    else lines.push('Profile URL: ' + f.profile_url);
  }
  if (f.link) {
    if (/facebook\.com/i.test(f.link)) lines.push('Facebook Link: ' + f.link);
    else lines.push('Login URL: ' + f.link);
  }
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
  let labeledCount = 0;

  while (i < parts.length) {
    const key = mapToken(parts[i]);
    if (key && i + 1 < parts.length) {
      const val = parts[i + 1];
      if (val && !/^[:\-–]*$/.test(val) && !mapToken(val)) {
        if (!fields[key]) fields[key] = val.replace(/\n+/g, ', ').trim();
        labeledCount++;
        i += 2;
        continue;
      }
    }
    const value = parts[i];
    if (!value) { i++; continue; }
    if (isUrl(value) && /facebook\.com|instagram\.com/i.test(value)) {
      if (!fields.profile_url) fields.profile_url = value;
      else if (!fields.link) fields.link = value;
      else extras.push(value);
    } else if (isUrl(value) && !fields.link) {
      fields.link = value;
    } else if (isEmail(value) && !fields.email) {
      fields.email = value;
    } else if (isLikely2FA(value) && !fields.token) {
      fields.token = value;
    } else {
      extras.push(value);
    }
    i += 1;
  }

  if (labeledCount === 0 && extras.length >= 2) {
    const a = extras.shift();
    const b = extras.shift();
    if (isEmail(a)) { fields.email = a; fields.password = b; }
    else { fields.username = a; fields.password = b; }
    if (extras.length && !fields.token) {
      const maybe2fa = extras.join(' ');
      if (isLikely2FA(maybe2fa) || /^[A-Z0-9 ]{8,}$/.test(maybe2fa)) {
        fields.token = maybe2fa;
        extras.length = 0;
      }
    }
  }

  if ((fields.email || fields.username) && !fields.password && extras.length) {
    fields.password = extras.shift();
  }

  if (extras.length) fields.extra = extras.join(' | ');
  if (fields.username || fields.password || fields.email || fields.token || fields.phone || fields.activation_code) {
    return fields;
  }
  return null;
}

function parseSpaceSeparated(text) {
  const t = clean(text).replace(/^\d+\.\s+/, '');
  if (!t || t.includes('\t')) return null;

  const urls = [];
  const protectedText = t.replace(/https?:\/\/\S+/gi, (m) => {
    urls.push(m);
    return `__URL${urls.length - 1}__`;
  });

  const tokens = protectedText.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const fields = {};
  const rest = [];

  for (const tok of tokens) {
    if (/^__URL(\d+)__$/.test(tok)) {
      const u = urls[Number(RegExp.$1)];
      if (/facebook\.com|instagram\.com|tiktok\.com/i.test(u)) {
        if (!fields.profile_url) fields.profile_url = u;
        else if (!fields.link) fields.link = u;
      } else if (!fields.link) fields.link = u;
      else rest.push(u);
      continue;
    }
    if (isEmail(tok) && !fields.email) fields.email = tok;
    else if (!fields.password && fields.email) fields.password = tok;
    else if (!fields.username && !fields.email && !isLikely2FA(tok)) fields.username = tok;
    else rest.push(tok);
  }

  if (rest.length) {
    const twoFaParts = [];
    const other = [];
    for (const r of rest) {
      if (/^[A-Z0-9]{3,8}$/.test(r) && r === r.toUpperCase()) twoFaParts.push(r);
      else if (isLikely2FA(r) && !fields.token) fields.token = r;
      else other.push(r);
    }
    if (twoFaParts.length >= 2 && !fields.token) fields.token = twoFaParts.join(' ');
    else if (twoFaParts.length === 1 && !fields.token) fields.token = twoFaParts[0];
    else if (twoFaParts.length && fields.token) other.push(...twoFaParts);
    if (!fields.password && fields.username && other.length) fields.password = other.shift();
    if (other.length) fields.extra = other.join(' | ');
  }

  if (fields.email && !fields.password && tokens.length === 2 && !isUrl(tokens[1])) {
    fields.password = tokens[1];
  }

  if (fields.email || fields.username || fields.password || fields.token) return fields;
  return null;
}

function parseColonSeparated(text) {
  const t = clean(text);
  if (!t.includes(':') || t.includes('\t')) return null;
  if (/^https?:\/\//i.test(t)) return null;

  const urls = [];
  const protectedText = t.replace(/https?:\/\/[^\s|:]+/gi, (m) => {
    urls.push(m);
    return `__URL${urls.length - 1}__`;
  });

  const parts = protectedText.split(':').map((p) =>
    stripQuotes(p.replace(/__URL(\d+)__/g, (_, i) => urls[Number(i)] || ''))
  ).filter(Boolean);

  if (parts.length < 2) return null;

  const fields = {};

  if (isEmail(parts[0])) {
    fields.email = parts[0];
    fields.password = parts[1];

    if (parts.length >= 4 && isEmail(parts[2]) && parts[2].toLowerCase() === parts[0].toLowerCase()) {
      if (parts[3] && parts[3] !== parts[1]) fields.email_password = parts[3];
      return fields;
    }
    if (parts.length === 3 && isEmail(parts[2]) && parts[2].toLowerCase() === parts[0].toLowerCase()) {
      return fields;
    }

    if (parts.length >= 4) {
      if (isLikely2FA(parts[3]) || (/^[A-Z0-9]{16,}$/.test(parts[3]) && parts[3] === parts[3].toUpperCase())) {
        fields.token = parts[3];
        if (isLikelyUsername(parts[2]) || (!isLikely2FA(parts[2]) && !isEmail(parts[2]))) {
          fields.username = parts[2];
        } else if (isLikely2FA(parts[2])) {
          fields.token = parts[2];
          fields.extra = parts.slice(3).join(':');
        }
      } else if (isUrl(parts[3])) {
        fields.profile_url = parts[3];
        if (!isEmail(parts[2])) fields.username = parts[2];
      } else {
        if (isLikelyUsername(parts[2])) fields.username = parts[2];
        else if (isLikely2FA(parts[2])) fields.token = parts[2];
        else fields.token = parts[2];
        if (parts[3]) fields.extra = parts.slice(3).join(':');
      }
    } else if (parts.length === 3) {
      if (isUrl(parts[2])) fields.profile_url = parts[2];
      else if (isLikely2FA(parts[2])) fields.token = parts[2];
      else if (isLikelyUsername(parts[2])) fields.username = parts[2];
      else fields.token = parts[2];
    }
  } else {
    fields.username = parts[0];
    fields.password = parts[1];
    if (parts[2]) {
      if (isEmail(parts[2])) fields.email = parts[2];
      else if (isUrl(parts[2])) fields.profile_url = parts[2];
      else if (isLikely2FA(parts[2])) fields.token = parts[2];
      else fields.token = parts[2];
    }
    if (parts[3]) {
      if (isLikely2FA(parts[3])) fields.token = parts[3];
      else if (isUrl(parts[3])) fields.profile_url = parts[3];
    }
  }

  if (fields.email || fields.username) return fields;
  return null;
}

export function formatOneAccount(raw, formatHint) {
  const text = clean(raw);
  if (!text) return '';

  const tabFields = parseTabDelimited(text);
  if (tabFields) return fieldsToText(tabFields);

  const spaceFields = parseSpaceSeparated(text);
  if (spaceFields) return fieldsToText(spaceFields);

  const colonFields = parseColonSeparated(text);
  if (colonFields) return fieldsToText(colonFields);

  return text;
}

export function formatCredentials(details, description) {
  if (details == null) return '';
  if (typeof details === 'object') {
    try { details = JSON.stringify(details); } catch (_) { details = String(details); }
  }
  let text = clean(details);
  if (!text) return '';

  const chunks = text.split(/\n\s*\n|\n-{3,}\n|\n={3,}\n/).map(clean).filter(Boolean);
  if (chunks.length > 1) {
    return chunks.map((c, i) => {
      const formatted = formatOneAccount(c, description);
      return (i + 1) + '. ' + formatted.replace(/\n/g, '\n   ');
    }).join('\n\n');
  }

  return formatOneAccount(text, description) || text;
}

export function joinRawLogDetails(items) {
  if (!Array.isArray(items)) return '';
  return items
    .map((item) => {
      if (item == null) return '';
      if (typeof item === 'string') return item.trim();
      const value = item.details ?? item.login_credentials ?? item.raw ?? '';
      if (value == null) return '';
      if (typeof value === 'string') return value.trim();
      try { return JSON.stringify(value); }
      catch (_) { return String(value).trim(); }
    })
    .filter(Boolean)
    .join('\n\n');
}

export default formatCredentials;
