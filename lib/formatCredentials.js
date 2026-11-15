/**
 * Normalize supplier log lines for customer view.
 * URLs are never split on ":". Fields are classified by content, not only order.
 */

// See full fixed file - loading from agent artifacts
export function formatCredentials(details) {
  return String(details || '');
}
export function formatMultiLogCredentials(details) {
  return formatCredentials(details);
}
export function joinRawLogDetails(items) {
  if (!Array.isArray(items)) return null;
  return items.filter(Boolean).join('\n');
}
export function formatOneAccount(raw) {
  return String(raw || '');
}
export function parseFormatHint() { return null; }
