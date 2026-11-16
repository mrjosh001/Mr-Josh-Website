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

  // Explicit "Format: user/pass/email" or "Delivery format: ..." block only
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

  // Explicit slash-only line like "USER/PASS/EMAIL/2FA" with no prose around it
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
 */
function splitDelimiters(line) {
  const text = clean(line);
  if (!text) return [];
  if (text.includes('|')) return text.split('|').map(stripQuotes).filter(Boolean);
  if (text.includes(';') && text.split(';').length >= 2) return text.split(';').map(stripQuotes).filter(Boolean);
  if (text.includes(':')) {
    // email:password only (two fields, first is email)
    const emailPass = text.match(/^([^\s:]+@[^\s:]+):(.+)$/);
    if (emailPass && !emailPass[2].includes(':')) return [emailPass[1], emailPass[2]];

    // Protect http(s):// so colon-split does not tear URLs apart
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

function extractLabeled(text) {
  const result = {};
  const patterns = [
    ['username', /(?:^|\n)\s*(?:user\s*name|username|user\s*id|\blogin\b)\s*[:=\-]\s*(.+)/i],
    ['password', /(?:^|\n)\s*(?:pass\s*word|password|\bpass\b|\bpwd\b)\s*[:=\-]\s*(.+)/i],
    ['email_password', /(?:^|\n)\s*(?:email\s*pass(?:word)?|mail\s*pass(?:word)?)\s*[:=\-]\s*(.+)/i],
    ['email', /(?:^|\n)\s*(?:e-?mail\s*address|e-?mail|\bmail\b)\s*[:=\-]\s*(.+)/i],
    ['token', /(?:^|\n)\s*(?:auth\s*token|\btoken\b|\bcookie\b|2\s*fa|\b2fa\b|otp\s*secret)\s*[:=\-]\s*(.+)/i],
    ['phone', /(?:^|\n)\s*(?:\bphone\b|\bmobile\b)\s*[:=\-]\s*(.+)/i]
  ];
  for (const line of clean(text).split(/\n+/)) {
    for (const [key, pattern] of patterns) {
      const match = line.match(pattern);
      if (match && match[1] && !result[key]) {
        let value = match[1].trim()
          .replace(/\s+(?:User\s*name|Username|User\s*id|Login|User|Password|Pass|Pwd|E-?mail|Mail|Token|Cookie|2\s*FA|2FA|Phone|Mobile)\s*[:=].*$/i, '')
          .replace(/\s*[|]\s*.*$/, '').trim();
        result[key] = stripQuotes(value);
      }
    }
  }
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

  // Common X / social log: user:pass:email:mailpass:2fa_url  (5 fields, last is URL)
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
  // Prefer username first when present (X / social logins)
  if (fields.username) lines.push('Username: ' + fields.username);
  if (fields.password) lines.push('Password: ' + fields.password);
  if (fields.email) lines.push('Email: ' + fields.email);
  if (fields.email_password) lines.push('Email Password: ' + fields.email_password);
  if (fields.phone) lines.push('Phone: ' + fields.phone);
  if (fields.token) lines.push('2FA / Token: ' + fields.token);
  if (fields.extra) lines.push('Extra: ' + fields.extra);
  return lines.join('\n');
}

export function formatOneAccount(raw, formatHint) {
  const text = clean(raw);
  if (!text) return '';
  const labeled = extractLabeled(text);
  if (labeled.username || labeled.password || labeled.email) return fieldsToText(labeled);

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
    const looksLikeAccounts = lines.length > 1 && lines.every(line => /[:|;]/.test(line) || /^[^\s]+@[^\s]+/.test(line));
    if (looksLikeAccounts) chunks = lines;
  }
  const formatted = chunks.map(chunk => formatOneAccount(chunk, hint)).filter(Boolean);
  return formatted.length ? formatted.join('\n\n') : text;
}

/**
 * Formats multiple supplier items independently. Never assumes an item's
 * details field is a string, and preserves the original payload if formatting
 * cannot produce a non-empty result.
 */
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

/** Preserve supplier-provided details without attempting to interpret them. */
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
