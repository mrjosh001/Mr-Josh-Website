/**
 * Shared credential formatter for all log suppliers and manual fulfilment.
 * Keep supplier adapters thin: formatting and multi-item aggregation belong here.
 */

function clean(value) {
  return String(value ?? '').replace(/\r/g, '').replace(/\u0000/g, '').trim();
}

function stripQuotes(value) {
  return clean(value).replace(/^["']|["']$/g, '');
}

function mapToken(token) {
  const value = String(token || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (/^(USER NAME|USERNAME|USER|LOGIN|ID|ACCOUNT)$/.test(value)) return 'username';
  if (/^(PASS WORD|PASSWORD|PASS|PWD)$/.test(value)) return 'password';
  if (/^(EMAIL PASS(WORD)?|MAIL PASS(WORD)?)$/.test(value)) return 'email_password';
  if (/^(E-?MAIL|MAIL|EMAIL)$/.test(value)) return 'email';
  if (/^(2 FA|2FA|TOKEN|COOKIE|AUTH TOKEN|SECRET)$/.test(value)) return 'token';
  if (/^(PHONE|MOBILE|NUMBER)$/.test(value)) return 'phone';
  return null;
}

/**
 * Only accept EXPLICIT format declarations.
 * Do NOT scan free-text product descriptions for words like "email", "pass", "login",
 * "2FA" — that scrambled X logs (user:pass:email:mailpass:url) into the wrong order.
 */
export function parseFormatHint(description) {
  if (!description) return null;
  const text = clean(description);

  const fmtBlock = text.match(
    /(?:delivery\s*format|credentials?\s*format|\bformat)\s*[:\-–]\s*([^\n]+)/i
  );
  if (fmtBlock) {
    const focus = fmtBlock[1];
    const slash = focus.match(
      /\b((?:USER(?:NAME)?|PASS(?:WORD)?|EMAIL(?:\s*PASS(?:WORD)?)?|2FA|TOKEN|COOKIE|LOGIN)(?:\s*[\/|]\s*(?:USER(?:NAME)?|PASS(?:WORD)?|EMAIL(?:\s*PASS(?:WORD)?)?|2FA|TOKEN|COOKIE|LOGIN))+)/i
    );
    const source = slash ? slash[1] : focus;
    const found = source.match(
      /Email\s*Password|User\s*name|Username|Password|Login|Email|User|Pass|2\s*FA|2FA|Token|Cookie|Phone|Mobile|USER|PASS|PWD|MAIL|ID/gi
    );
    if (found && found.length >= 2) {
      const keys = [];
      for (const part of found) {
        const key = mapToken(part);
        if (key && !keys.includes(key)) keys.push(key);
      }
      if (keys.length >= 2) return keys;
    }
  }

  const slashOnly = text.match(
    /^\s*((?:USER(?:NAME)?|PASS(?:WORD)?|EMAIL(?:\s*PASS(?:WORD)?)?|2FA|TOKEN|COOKIE|LOGIN)(?:\s*[\/|]\s*(?:USER(?:NAME)?|PASS(?:WORD)?|EMAIL(?:\s*PASS(?:WORD)?)?|2FA|TOKEN|COOKIE|LOGIN))+)\s*$/im
  );
  if (slashOnly) {
    const found = slashOnly[1].match(
      /Email\s*Password|User\s*name|Username|Password|Login|Email|User|Pass|2\s*FA|2FA|Token|Cookie|Phone|Mobile|USER|PASS|PWD|MAIL|ID/gi
    );
    if (found && found.length >= 2) {
      const keys = [];
      for (const part of found) {
        const key = mapToken(part);
        if (key && !keys.includes(key)) keys.push(key);
      }
      if (keys.length >= 2) return keys;
    }
  }

  return null;
}

/**
 * Split on | ; or : without breaking URLs (https://...).
 * If segments look labeled (Key: value), do NOT split on | — extractLabeled handles that.
 */
function splitDelimiters(line) {
  const text = clean(line);
  if (!text) return [];

  // Pipe-separated LABELED fields: "Email: x | Password: y | Plan: z"
  if (text.includes('|') && /(?:^|\|)\s*[A-Za-z][A-Za-z0-9 _-]{0,24}\s*[:=]/.test(text)) {
    return [text];
  }

  if (text.includes('|')) return text.split('|').map(stripQuotes).filter(Boolean);
  if (text.includes(';') && text.split(';').length >= 2) return text.split(';').map(stripQuotes).filter(Boolean);
  if (text.includes(':')) {
    const emailPass = text.match(/^([^\s:]+@[^\s:]+):(.+)$/);
    if (emailPass && !emailPass[2].includes(':')) return [emailPass[1], emailPass[2]];

    const urls = [];
    const protectedText = text.replace(/https?:\/\/[^\s|;]+/gi, (m) => {
      urls.push(m);
      return `__URL${urls.length - 1}__`;
    });
    const parts = protectedText
      .split(':')
      .map((p) => stripQuotes(p.replace(/__URL(\d+)__/g, (_, i) => urls[Number(i)] || '')))
      .filter(Boolean);
    if (parts.length >= 2) return parts;
  }
  if (/\s{2,}|\t/.test(text)) return text.split(/\s{2,}|\t/).map(stripQuotes).filter(Boolean);
  return [text];
}

/**
 * Extract labeled fields. Supports:
 *   - newline-separated: Email: x\nPassword: y
 *   - pipe-separated on one line: Email: x | Password: y | Plan: z
 * Unknown labels go into extra (as "Label: value").
 */
function extractLabeled(text) {
  const result = {};
  const extras = [];

  const known = [
    ['username', /^(?:user\s*name|username|user\s*id|login)$/i],
    ['password', /^(?:pass\s*word|password|pass|pwd)$/i],
    ['email_password', /^(?:email\s*pass(?:word)?|mail\s*pass(?:word)?)$/i],
    ['email', /^(?:e-?mail\s*address|e-?mail|mail)$/i],
    ['token', /^(?:auth\s*token|token|cookie|2\s*fa|2fa|otp\s*secret)$/i],
    ['phone', /^(?:phone|mobile|number)$/i]
  ];

  const normalized = clean(text).replace(/\s*\|\s*/g, '\n');

  for (const line of normalized.split(/\n+/)) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 _-]{0,30})\s*[:=\-]\s*(.+)$/);
    if (!m) continue;
    const label = m[1].trim();
    let value = stripQuotes(m[2].trim());
    if (!value) continue;

    let matched = false;
    for (const [key, pattern] of known) {
      if (pattern.test(label) && !result[key]) {
        result[key] = value;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const looksLikeField = /^[A-Za-z][A-Za-z0-9 _-]{0,24}$/.test(label) && !/[0-9]{3,}/.test(label) && label.length <= 24;
      if (looksLikeField) extras.push(label.replace(/\s+/g, ' ') + ': ' + value);
    }
  }

  if (extras.length) result.extra = extras.join('\n');
  return result;
}

function applyHint(parts, hintKeys) {
  if (!parts?.length || !hintKeys?.length) return null;
  const fields = {};
  const count = Math.min(parts.length, hintKeys.length);
  for (let i = 0; i < count; i++) {
    if (hintKeys[i] && parts[i] != null && parts[i] !== '') fields[hintKeys[i]] = parts[i];
  }
  if (parts.length > hintKeys.length) fields.extra = parts.slice(hintKeys.length).join(' | ');
  return fields;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function isTokenish(value) {
  return (
    isUrl(value) ||
    value.length > 40 ||
    /^(otpauth|eyJ|ghp_|sk-)/i.test(value) ||
    /2fa[-.]/i.test(value)
  );
}

function partsToFields(parts) {
  const fields = {};
  if (!parts?.length) return fields;

  if (parts.length >= 5 && isUrl(parts[parts.length - 1])) {
    fields.username = parts[0];
    fields.password = parts[1];
    if (isEmail(parts[2])) {
      fields.email = parts[2];
      fields.email_password = parts[3];
      fields.token = parts[parts.length - 1];
      if (parts.length > 5) {
        const middle = parts.slice(4, -1).filter(Boolean);
        if (middle.length) fields.extra = middle.join(' | ');
      }
      return fields;
    }
  }

  if (parts.length === 1) return { username: parts[0] };
  if (parts.length === 2) {
    if (isEmail(parts[0])) {
      fields.email = parts[0];
      fields.password = parts[1];
    } else {
      fields.username = parts[0];
      fields.password = parts[1];
    }
    return fields;
  }

  fields.username = parts[0];
  fields.password = parts[1];
  if (parts[2]) {
    if (isEmail(parts[2])) fields.email = parts[2];
    else if (isTokenish(parts[2])) fields.token = parts[2];
    else fields.email = parts[2];
  }
  if (parts[3]) {
    if (isEmail(parts[3]) && !fields.email) fields.email = parts[3];
    else if (isTokenish(parts[3])) fields.token = parts[3];
    else fields.email_password = parts[3];
  }
  if (parts[4]) {
    if (isTokenish(parts[4])) fields.token = parts[4];
    else fields.extra = parts.slice(4).join(' | ');
  }
  if (parts.length > 5 && !fields.extra) fields.extra = parts.slice(5).join(' | ');
  return fields;
}

function fieldsToText(fields) {
  const lines = [];
  if (fields.username) lines.push('Username: ' + fields.username);
  if (fields.email && !fields.username) lines.push('Email: ' + fields.email);
  if (fields.password) lines.push('Password: ' + fields.password);
  if (fields.email && fields.username) lines.push('Email: ' + fields.email);
  if (fields.email_password) lines.push('Email Password: ' + fields.email_password);
  if (fields.phone) lines.push('Phone: ' + fields.phone);
  if (fields.token) lines.push('2FA / Token: ' + fields.token);
  if (fields.extra) {
    for (const line of String(fields.extra).split(/\n+/)) {
      if (line.trim()) lines.push(line.trim());
    }
  }
  return lines.join('\n');
}

export function formatOneAccount(raw, formatHint) {
  const text = clean(raw);
  if (!text) return '';

  const labeled = extractLabeled(text);
  // Only trust labeled parse when a real credential field was found.
  if (labeled.username || labeled.password || labeled.email || labeled.email_password || labeled.phone || labeled.token) {
    return fieldsToText(labeled);
  }

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const object = Array.isArray(parsed) ? parsed[0] : parsed;
      if (object && typeof object === 'object') {
        const formatted = fieldsToText({
          username: object.username || object.user || object.login || object.id || object.account,
          password: object.password || object.pass || object.pwd,
          email: object.email || object.mail,
          email_password: object.email_password || object.emailPassword || object.mail_pass,
          token: object.token || object.cookie || object['2fa'] || object.twofa || object.secret,
          phone: object.phone || object.mobile
        });
        if (formatted) return formatted;
      }
    } catch (_) {}
  }

  const parts = splitDelimiters(text.replace(/\n/g, ' ').replace(/\s+/g, ' '));
  if (parts.length >= 2) {
    const hinted = applyHint(parts, formatHint);
    if (hinted && (hinted.username || hinted.password || hinted.email)) return fieldsToText(hinted);
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
  let input = details;
  if (typeof input === 'object') {
    try { input = JSON.stringify(input); } catch (_) { input = String(input); }
  }
  const text = clean(input);
  if (!text) return '';
  const hint = parseFormatHint(description);
  let chunks = text.split(/\n\s*\n|\n-{3,}\n|\n={3,}\n/).map(clean).filter(Boolean);
  if (chunks.length === 1) {
    const lines = text.split(/\n+/).map(clean).filter(Boolean);
    const allLabeled = lines.length > 1 && lines.every(line =>
      /^(?:E-?mails?|User\s*names?|Usernames?|Pass(?:words?)?|Logins?|Phones?|Mobiles?|Tokens?|2\s*FAs?|2FAs?|Plans?|AutoRenews?|Expire(?:Dates?)?|Days?\s*Left|Serials?|Keys?|Codes?|Pins?)\b[^:\n]{0,20}\s*[:=\-]/i.test(line)
    );
    if (allLabeled) {
      // keep as single chunk
    } else {
      const looksLikeAccounts = lines.length > 1 && lines.every(line => /[:|;]/.test(line) || /^[^\s]+@[^\s]+/.test(line));
      if (looksLikeAccounts) chunks = lines;
    }
  }
  const formatted = chunks.map(chunk => formatOneAccount(chunk, hint)).filter(Boolean);
  return formatted.length ? formatted.join('\n\n') : text;
}

export function formatMultiLogCredentials(items, description) {
  if (!Array.isArray(items)) return formatCredentials(items, description);
  const formatted = [];
  for (const item of items) {
    const raw = item && typeof item === 'object'
      ? (item.details ?? item.credential ?? item.login_credentials ?? item.raw ?? '')
      : item;
    const result = formatCredentials(raw, description);
    if (result) formatted.push(result);
  }
  return formatted.join('\n\n');
}

export function joinRawLogDetails(items) {
  if (!Array.isArray(items)) return clean(items);
  return items.map(item => {
    const raw = item && typeof item === 'object'
      ? (item.details ?? item.credential ?? item.login_credentials ?? item.raw ?? '')
      : item;
    if (raw == null) return '';
    if (typeof raw === 'string') return raw.trim();
    try { return JSON.stringify(raw); } catch (_) { return String(raw); }
  }).filter(Boolean).join('\n\n');
}

export default formatCredentials;
