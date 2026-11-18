/**
 * Shared credential formatter for supplier and manual log fulfilment.
 * Prefer explicit labels/JSON keys, retain repeated and unknown fields, and never
 * silently discard additional credential records.
 */
function clean(value) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
}
function stripQuotes(value) {
  return clean(value).replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
}
function normalizeKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
const FIELD_ALIASES = [
  ['username', /^(user name|username|user id|userid|login|login id|account|account name|screen name)$/],
  ['password', /^(password|pass word|pass|pwd|login password)$/],
  ['email', /^(email|e mail|email address|mail|mail address)$/],
  ['email_password', /^(email password|email pass|mail password|mail pass|inbox password)$/],
  ['recovery_email', /^(recovery email|backup email|secondary email|recovery mail)$/],
  ['recovery_phone', /^(recovery phone|backup phone|recovery number|backup number)$/],
  ['phone', /^(phone|phone number|mobile|mobile number|number)$/],
  ['token', /^(2fa|2 fa|two factor|two factor code|auth token|token|otp secret|secret|totp)$/],
  ['cookie', /^(cookie|cookies|session cookie|session|session id)$/],
  ['twofa_url', /^(2fa url|2 fa url|2fa link|authenticator url|authenticator link)$/],
  ['profile_url', /^(profile url|profile link|account url|account link)$/],
  ['link', /^(link|url|login url|login link|website|site|access link)$/],
  ['recovery', /^(recovery code|backup codes|recovery|backup code)$/],
  ['client_id', /^(client id|client_id|app id)$/],
  ['extra', /^(note|notes|extra|additional info|details|remark|remarks)$/]
];
function mapToken(token) {
  const key = normalizeKey(token);
  for (const [field, pattern] of FIELD_ALIASES) if (pattern.test(key)) return field;
  return null;
}
function splitFormatTokens(source) {
  return clean(source).split(/\s*(?:\/|\||;|,|:)\s*/)
    .map(part => part.replace(/^[\s"']+|[\s"']+$/g, '').trim()).filter(Boolean);
}
/** Only explicit format declarations are trusted. Repeated keys are retained. */
export function parseFormatHint(description) {
  const text = clean(description);
  if (!text) return null;
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:delivery\s*format|credentials?\s*format|format)\s*[:=\-–]\s*(.+?)\s*$/i);
    if (!match) continue;
    const keys = splitFormatTokens(match[1]).map(mapToken);
    if (keys.length >= 2 && keys.every(Boolean)) return keys;
  }
  if (text.includes('/') || text.includes('|') || text.includes(';')) {
    const keys = splitFormatTokens(text).map(mapToken);
    if (keys.length >= 2 && keys.every(Boolean)) return keys;
  }
  return null;
}
function addValue(fields, key, value) {
  const val = stripQuotes(value);
  if (!val) return;
  fields[key] = fields[key] == null || fields[key] === '' ? val : String(fields[key]) + '\n' + val;
}
function labelPattern() {
  return /^\s*([A-Za-z][A-Za-z0-9 _./()-]{0,39})\s*[:=]\s*(.*?)\s*$/;
}
function parseLabeledRecord(input) {
  const fields = {};
  const extras = [];
  let found = false;
  for (const original of clean(input).split('\n')) {
    const match = original.trim().match(labelPattern());
    if (!match) continue;
    const label = match[1].trim();
    const value = stripQuotes(match[2]);
    if (!value || /^(https?|ftp)$/i.test(label)) continue;
    const key = mapToken(label);
    if (key) {
      addValue(fields, key, value);
      found = true;
    } else {
      extras.push(label + ': ' + value);
    }
  }
  if (extras.length) fields.extra = [fields.extra, ...extras].filter(Boolean).join('\n');
  return found ? fields : null;
}
function splitPipeLabeled(text) {
  const parts = clean(text).split(/\s*\|\s*/);
  if (parts.length < 2) return text;
  const allLabeled = parts.every(part => {
    const m = part.match(labelPattern());
    return !!(m && (mapToken(m[1]) || /^[A-Za-z][A-Za-z0-9 _./()-]{0,39}$/.test(m[1])));
  });
  return allLabeled ? parts.join('\n') : text;
}
function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value));
}
function isUrl(value) {
  return /^(?:https?|ftp):\/\/\S+$/i.test(clean(value));
}
function protectUrls(value) {
  const urls = [];
  const text = value.replace(/\b(?:https?|ftp):\/\/[^\s|;]+/gi, url => {
    const index = urls.push(url) - 1;
    return '__MJURL' + index + '__';
  });
  return { text, restore(part) {
    return part.replace(/__MJURL(\d+)__/g, (_, index) => urls[Number(index)] || '');
  }};
}
function splitDelimitedRecord(input) {
  const text = clean(input);
  if (!text) return [];
  if (text.includes('|')) return text.split('|').map(stripQuotes).filter(Boolean);
  if (text.includes(';')) return text.split(';').map(stripQuotes).filter(Boolean);
  const protectedValue = protectUrls(text);
  const pieces = protectedValue.text.split(':');
  if (pieces.length > 1) {
    const restored = pieces.map(piece => stripQuotes(protectedValue.restore(piece))).filter(Boolean);
    if (restored.length > 1) return restored;
  }
  if (/\t|\s{2,}/.test(text)) return text.split(/\t+|\s{2,}/).map(stripQuotes).filter(Boolean);
  return [text];
}
function fieldsFromJsonObject(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  const fields = {};
  const extras = [];
  const aliases = {
    username: ['username', 'user', 'login', 'userid', 'user_id', 'account', 'account_name'],
    password: ['password', 'pass', 'pwd', 'login_password'],
    email: ['email', 'mail', 'email_address'],
    email_password: ['email_password', 'emailPassword', 'mail_pass', 'mail_password', 'inbox_password'],
    recovery_email: ['recovery_email', 'backup_email', 'secondary_email'],
    recovery_phone: ['recovery_phone', 'backup_phone', 'recovery_number'],
    phone: ['phone', 'mobile', 'phone_number', 'mobile_number'],
    token: ['token', 'auth_token', 'access_token', 'refresh_token', 'bearer_token', 'twofa', 'two_fa', '2fa', 'otp_secret', 'secret', 'totp'],
    cookie: ['cookie', 'cookies', 'session', 'session_cookie'],
    link: ['link', 'url', 'login_url', 'login_link'],
    recovery: ['recovery', 'recovery_code', 'backup_codes'],
    client_id: ['client_id', 'clientId', 'app_id'],
    extra: ['extra', 'notes', 'note', 'details', 'additional_info']
  };
  const consumed = new Set();
  const entries = Object.entries(object);
  const lookup = key => {
    if (Object.prototype.hasOwnProperty.call(object, key)) return [key, object[key]];
    const lower = key.toLowerCase();
    return entries.find(([candidate]) => candidate.toLowerCase() === lower) || [];
  };
  for (const [field, keys] of Object.entries(aliases)) {
    for (const key of keys) {
      const [actualKey, value] = lookup(key);
      if (!actualKey || value == null || value === '') continue;
      consumed.add(actualKey);
      addValue(fields, field, Array.isArray(value) ? value.join('\n') : (typeof value === 'object' ? JSON.stringify(value) : value));
    }
  }
  for (const [key, value] of entries) {
    if (consumed.has(key) || value == null || value === '') continue;
    extras.push(key + ': ' + (typeof value === 'object' ? JSON.stringify(value) : String(value)));
  }
  if (extras.length) fields.extra = [fields.extra, ...extras].filter(Boolean).join('\n');
  return Object.keys(fields).length ? fields : null;
}
function fieldsToText(fields) {
  if (!fields) return '';
  const order = [
    ['username', 'Username'], ['password', 'Password'], ['email', 'Email'],
    ['email_password', 'Email Password'], ['recovery_email', 'Recovery Email'],
    ['recovery_phone', 'Recovery Phone'], ['phone', 'Phone'], ['token', '2FA / Token'],
    ['cookie', 'Cookie / Session'], ['twofa_url', '2FA URL'], ['link', 'Login URL'], ['profile_url', 'Profile URL'], ['client_id', 'Client ID'],
    ['recovery', 'Recovery Code']
  ];
  const lines = [];
  for (const [key, label] of order) {
    if (fields[key] == null || fields[key] === '') continue;
    for (const value of String(fields[key]).split('\n')) if (value.trim()) lines.push(label + ': ' + value.trim());
  }
  if (fields.extra) for (const line of String(fields.extra).split('\n')) if (line.trim()) lines.push(line.trim());
  return lines.join('\n');
}
function applyHint(parts, hintKeys) {
  if (!parts.length || !hintKeys?.length) return null;
  const fields = {};
  const extras = [];
  const count = Math.min(parts.length, hintKeys.length);
  for (let i = 0; i < count; i++) {
    const key = hintKeys[i];
    if (!key || !parts[i]) continue;
    if (fields[key] == null) fields[key] = parts[i];
    else extras.push(key.replace(/_/g, ' ') + ' (additional): ' + parts[i]);
  }
  if (parts.length > hintKeys.length) extras.push('Additional fields: ' + parts.slice(hintKeys.length).join(' | '));
  if (extras.length) fields.extra = [fields.extra, ...extras].filter(Boolean).join('\n');
  return fields;
}
function inferFields(parts) {
  const fields = {};
  if (!parts.length) return fields;
  if (parts.length === 1) {
    if (isEmail(parts[0])) fields.email = parts[0];
    else fields.username = parts[0];
    return fields;
  }
  if (parts.length === 2) {
    if (isEmail(parts[0])) { fields.email = parts[0]; fields.password = parts[1]; }
    else { fields.username = parts[0]; fields.password = parts[1]; }
    return fields;
  }
  fields.username = parts[0];
  fields.password = parts[1];
  for (let i = 2; i < parts.length; i++) {
    const value = parts[i];
    if (isEmail(value) && !fields.email) fields.email = value;
    else if (isUrl(value) && !fields.link) fields.link = value;
    else if (/^\+?[0-9 ()-]{7,}$/.test(value) && !fields.phone) fields.phone = value;
    else if (!fields.token && (value.length > 35 || /^(?:otpauth|eyJ|ghp_|sk-)/i.test(value))) fields.token = value;
    else fields.extra = [fields.extra, value].filter(Boolean).join(' | ');
  }
  return fields;
}
function formatLabeledRecords(text) {
  const groups = [];
  let current = [];
  let hasPrimary = false;
  for (const line of clean(text).split('\n')) {
    const match = line.match(labelPattern());
    const key = match ? mapToken(match[1]) : null;
    const primary = key === 'username' || key === 'email';
    if (primary && hasPrimary && current.length) {
      groups.push(current.join('\n'));
      current = [];
      hasPrimary = false;
    }
    current.push(line);
    if (primary) hasPrimary = true;
  }
  if (current.length) groups.push(current.join('\n'));
  return groups.map(group => {
    const fields = parseLabeledRecord(group);
    return fields ? fieldsToText(fields) : group;
  }).filter(Boolean).join('\n\n');
}

function parseJsonRecords(text) {
  const trimmed = clean(text);
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
  try {
    const parsed = JSON.parse(trimmed);
    function unwrap(value) {
      if (Array.isArray(value)) return value.flatMap(unwrap);
      if (!value || typeof value !== 'object') return [value];
      for (const key of ['items', 'credentials', 'accounts', 'results']) {
        if (Array.isArray(value[key])) return value[key].flatMap(unwrap);
      }
      for (const key of ['data', 'result', 'credential', 'account']) {
        if (value[key] && typeof value[key] === 'object') return unwrap(value[key]);
      }
      return [value];
    }
    const values = unwrap(parsed);
    const records = [];
    for (const value of values) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const formatted = fieldsToText(fieldsFromJsonObject(value));
        records.push(formatted || JSON.stringify(value));
      } else if (value != null) records.push(String(value));
    }
    return records.length ? records : null;
  } catch (_) { return null; }
}
function parseTabDelimitedRecord(text) {
  if (!text.includes('\t')) return null;
  const parts = text.split('\t').map(part => clean(part)).filter((part, index, all) => part || index < all.length - 1);
  if (parts.length < 4) return null;
  const fields = {};
  let i = 0;
  let recognized = 0;
  while (i < parts.length - 1) {
    const key = mapToken(parts[i]);
    if (!key) break;
    addValue(fields, key, parts[i + 1]);
    recognized++;
    i += 2;
  }
  if (recognized < 2) return null;
  const extras = [];
  for (; i < parts.length; i++) {
    const value = parts[i];
    if (!value) continue;
    if (isUrl(value) && /(?:2fa\.live|authenticator|totp)/i.test(value)) addValue(fields, 'twofa_url', value);
    else if (isUrl(value) && /instagram\.com/i.test(value)) addValue(fields, 'profile_url', value);
    else if (isUrl(value) && !fields.link) addValue(fields, 'link', value);
    else if (/^[A-Z0-9]{4}(?:\s+[A-Z0-9]{4}){2,}$/i.test(value) || (value.length >= 12 && !/\s{2,}/.test(value))) addValue(fields, 'token', value);
    else extras.push(value);
  }
  if (extras.length) fields.extra = [fields.extra, ...extras].filter(Boolean).join('\\n');
  return fields;
}
function parseHintedSpaceRecord(text, hintKeys) {
  if (!hintKeys || hintKeys.length < 3 || !/\s/.test(text)) return null;
  const parts = text.trim().split(/\s+/);
  if (parts.length < 4 || !isEmail(parts[0]) || !isUrl(parts[parts.length - 2]) && !parts.some(isUrl)) return null;
  const urlIndex = parts.findIndex(isUrl);
  if (urlIndex < 3) return null;
  const fields = {};
  const emailKey = hintKeys[0];
  const passwordKey = hintKeys[1];
  const tokenKey = hintKeys[2];
  const linkKey = hintKeys[3] || 'link';
  if (!['email','username'].includes(emailKey) || passwordKey !== 'password' || tokenKey !== 'token') return null;
  fields[emailKey] = parts[0];
  fields.password = parts[1];
  const tokenParts = parts.slice(2, urlIndex);
  if (!tokenParts.length) return null;
  fields.token = tokenParts.join(' ');
  fields[linkKey] = parts[urlIndex];
  if (parts.length > urlIndex + 1) fields.extra = parts.slice(urlIndex + 1).join(' ');
  return fields;
}

export function formatOneAccount(raw, formatHint) {
  const text = clean(raw);
  if (!text) return '';
  const tabFields = parseTabDelimitedRecord(text);
  if (tabFields) return fieldsToText(tabFields);
  const json = parseJsonRecords(text);
  if (json) return json.join('\n\n');
  const labeled = parseLabeledRecord(splitPipeLabeled(text));
  if (labeled) return fieldsToText(labeled);
  const normalized = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = splitDelimitedRecord(normalized);
  if (formatHint?.length && parts.length >= 2) {
    const hinted = applyHint(parts, formatHint);
    if (hinted) return fieldsToText(hinted);
  }
  if (parts.length >= 2) return fieldsToText(inferFields(parts));
  return text;
}
export function formatCredentials(details, description) {
  if (details == null) return '';
  if (Array.isArray(details)) return formatMultiLogCredentials(details, description);
  if (typeof details === 'object') {
    const json = parseJsonRecords(JSON.stringify(details));
    return json ? json.join('\n\n') : JSON.stringify(details);
  }
  const text = clean(details);
  if (!text) return '';
  const hint = parseFormatHint(description);
  const jsonRecords = parseJsonRecords(text);
  if (jsonRecords) return jsonRecords.join('\n\n');

  const lines = text.split('\n').map(clean).filter(Boolean);
  const allLabeled = lines.length > 1 && lines.every(line => {
    const match = line.match(labelPattern());
    return !!(match && (mapToken(match[1]) || /^[A-Za-z][A-Za-z0-9 _./()-]{0,39}$/.test(match[1])));
  });
  if (allLabeled) return formatLabeledRecords(text);

  const chunks = text.split(/\n\s*\n|\n-{3,}\n|\n={3,}\n/).map(clean).filter(Boolean);
  if (chunks.length > 1) return chunks.map(chunk => formatOneAccount(chunk, hint)).filter(Boolean).join('\n\n');
  if (lines.length > 1 && lines.every(line => /[|;]/.test(line) || /^[^\s]+@[^\s]+/.test(line))) {
    return lines.map(line => formatOneAccount(line, hint)).filter(Boolean).join('\n\n');
  }
  return formatOneAccount(text, hint) || text;
}
export function formatMultiLogCredentials(items, description) {
  if (!Array.isArray(items)) return formatCredentials(items, description);
  const formatted = [];
  for (const item of items) {
    const raw = item && typeof item === 'object'
      ? (item.details ?? item.credential ?? item.login_credentials ?? item.raw ?? item.data ?? item)
      : item;
    const result = formatCredentials(raw, description);
    if (result) formatted.push(result);
  }
  return formatted.join('\n\n');
}
export function joinRawLogDetails(items) {
  if (!Array.isArray(items)) {
    if (items == null) return '';
    if (typeof items === 'string') return items.trim();
    try { return JSON.stringify(items); } catch (_) { return String(items); }
  }
  return items.map(item => {
    const raw = item && typeof item === 'object'
      ? (item.details ?? item.credential ?? item.login_credentials ?? item.raw ?? item.data ?? item)
      : item;
    if (raw == null) return '';
    if (typeof raw === 'string') return raw.trim();
    try { return JSON.stringify(raw); } catch (_) { return String(raw); }
  }).filter(Boolean).join('\n\n');
}
export default formatCredentials;
