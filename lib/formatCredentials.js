/**
 * MJ Hub credential formatter
 * tabs, space FB logs, colon chains, pipe IG logs, VPN key=value pipes
 * LinkedIn / Nextdoor / TextPlus / Instagram / ExpressVPN
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
  if (f.plan) lines.push('Plan: ' + f.plan);
  if (f.expire_date) lines.push('Expire Date: ' + f.expire_date);
  if (f.days_left) lines.push('Days Left: ' + f.days_left);
  if (f.profile_url) {
    if (/facebook\.com/i.test(f.profile_url)) lines.push('Facebook Link: ' + f.profile_url);
    else lines.push('Profile URL: ' + f.profile_url);
  }
  if (f.link) {
    if (/facebook\.com/i.test(f.link)) lines.push('Facebook Link: ' + f.link);
    else lines.push('Login URL: ' + f.link);
  }
  if (f.extra) {
    if (/^Cookies:\s*/i.test(f.extra)) lines.push(f.extra);
    else lines.push('Extra: ' + f.extra);
  }
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

/** Pipe-delimited Instagram-style: user|pass|2fa|cookies */
function parsePipeDelimited(text) {
  const t = clean(text);
  if (!t.includes('|') || t.includes('\t')) return null;
  if (/=/.test(t) && /\s\|\s/.test(t)) return null; // prefer VPN style
  const parts = t.split('|').map((p) => clean(p)).filter((p) => p.length);
  if (parts.length < 2) return null;
  if (/\s/.test(parts[0]) && !isEmail(parts[0])) return null;

  const fields = {};
  if (isEmail(parts[0])) fields.email = parts[0];
  else fields.username = parts[0];
  fields.password = parts[1];

  if (parts.length >= 3) {
    const p2 = parts[2];
    if (isLikely2FA(p2) || (/^[A-Z0-9]{16,}$/.test(p2) && p2 === p2.toUpperCase())) {
      fields.token = p2;
    } else if (/csrftoken=|sessionid=|ds_user_id=/i.test(p2)) {
      fields.extra = 'Cookies: ' + parts.slice(2).join('|');
    } else if (isLikelyUsername(p2)) {
      fields.username = fields.username || p2;
    } else {
      fields.token = p2;
    }
  }
  if (parts.length >= 4) {
    const rest = parts.slice(3).join('|');
    if (/csrftoken=|sessionid=|ds_user_id=|cookie/i.test(rest)) {
      fields.extra = 'Cookies: ' + rest;
    } else if (!fields.token && isLikely2FA(parts[3])) {
      fields.token = parts[3];
      if (parts.length > 4) fields.extra = parts.slice(4).join('|');
    } else if (!fields.extra) {
      fields.extra = rest;
    }
  }
  if (fields.username || fields.email) return fields;
  return null;
}

/** email:pass | Plan = X | ExpireDate = Y | DaysLeft = Z (ExpressVPN etc.) */
function parseVpnStyle(text) {
  const t = clean(text);
  if (!t.includes('|') || !/=/.test(t)) return null;
  const segments = t.split(/\s*\|\s*/).map((s) => clean(s)).filter(Boolean);
  if (segments.length < 2) return null;

  const fields = {};
  const first = segments[0];
  if (first.includes(':')) {
    const colon = first.indexOf(':');
    const left = first.slice(0, colon).trim();
    const right = first.slice(colon + 1).trim();
    if (isEmail(left)) {
      fields.email = left;
      fields.password = right;
    } else {
      fields.username = left;
      fields.password = right;
    }
  } else if (isEmail(first)) {
    fields.email = first;
  } else {
    return null;
  }

  const extras = [];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const m = seg.match(/^([A-Za-z][A-Za-z0-9 _-]{1,40})\s*=\s*(.+)$/);
    if (!m) {
      extras.push(seg);
      continue;
    }
    const key = m[1].replace(/\s+/g, ' ').trim();
    const val = m[2].trim();
    const kl = key.toLowerCase().replace(/[\s_]+/g, '');
    if (kl === 'plan' || kl === 'subscription') fields.plan = val;
    else if (kl === 'expiredate' || kl === 'expiry' || kl === 'expires' || kl === 'expiration') fields.expire_date = val;
    else if (kl === 'daysleft' || kl === 'days' || kl === 'remaining') fields.days_left = val;
    else if (kl === 'password' && !fields.password) fields.password = val;
    else if (kl === 'email' && !fields.email) fields.email = val;
    else extras.push(key + ': ' + val);
  }
  if (extras.length) fields.extra = extras.join(' | ');
  if (fields.email || fields.username || fields.password) return fields;
  return null;
}

export function formatOneAccount(raw, formatHint) {
  const text = clean(raw);
  if (!text) return '';

  const tabFields = parseTabDelimited(text);
  if (tabFields) return fieldsToText(tabFields);

  const vpnFields = parseVpnStyle(text);
  if (vpnFields) return fieldsToText(vpnFields);

  const pipeFields = parsePipeDelimited(text);
  if (pipeFields) return fieldsToText(pipeFields);

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
