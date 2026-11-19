import { getServiceSupabase, requireCron, setNoStore } from '../lib/secure.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_RETENTION_DAYS = 60;
const MESSAGE_RETENTION_DAYS = 90;
const BATCH_SIZE = 200;

function extractStorageObject(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    const match = url.pathname.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/i);
    if (!match) return null;
    const bucket = decodeURIComponent(match[1]);
    const objectPath = match[2].split('/').map(part => decodeURIComponent(part)).join('/');
    if (!bucket || !objectPath || objectPath.includes('..')) return null;
    return { bucket, path: objectPath };
  } catch (_) {
    return null;
  }
}

function attachmentUrls(body) {
  const matches = [];
  const re = /\[\[MJURL\]\]([\s\S]*?)\[\[\/MJURL\]\]/gi;
  let match;
  while ((match = re.exec(String(body || '')))) {
    const url = String(match[1] || '').trim();
    if (/^https?:\/\//i.test(url)) matches.push(url);
  }
  return matches;
}

function expiredBody(body) {
  return String(body || '').replace(
    /\[\[MJURL\]\][\s\S]*?\[\[\/MJURL\]\]/gi,
    '[Attachment expired]'
  );
}

async function deleteTicketAttachments(supabase, ticketId, counters) {
  const { data: messages, error } = await supabase
    .from('support_messages')
    .select('id,body')
    .eq('ticket_id', ticketId)
    .limit(1000);
  if (error) throw error;

  for (const message of messages || []) {
    const urls = attachmentUrls(message.body);
    if (!urls.length) continue;
    let safeToMarkExpired = true;

    for (const url of urls) {
      const object = extractStorageObject(url);
      if (!object) {
        safeToMarkExpired = false;
        counters.unparsedAttachments++;
        console.warn('[support-retention] could not parse attachment URL', { ticketId, messageId: message.id });
        continue;
      }
      const { error: removeError } = await supabase.storage.from(object.bucket).remove([object.path]);
      if (removeError) {
        safeToMarkExpired = false;
        counters.storageDeleteFailures++;
        console.error('[support-retention] storage deletion failed', {
          ticketId, messageId: message.id, bucket: object.bucket, error: removeError.message
        });
      } else {
        counters.attachmentsDeleted++;
      }
    }

    if (safeToMarkExpired) {
      const { error: updateError } = await supabase
        .from('support_messages')
        .update({ body: expiredBody(message.body) })
        .eq('id', message.id)
        .eq('ticket_id', ticketId);
      if (updateError) {
        counters.messageUpdateFailures++;
        console.error('[support-retention] could not mark expired attachment', {
          ticketId, messageId: message.id, error: updateError.message
        });
      }
    }
  }
}

export default async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }
  const auth = requireCron(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ success: false, message: auth.error.message });
  }

  try {
    const supabase = getServiceSupabase();
    const now = Date.now();
    const attachmentCutoff = new Date(now - ATTACHMENT_RETENTION_DAYS * DAY_MS).toISOString();
    const messageCutoff = new Date(now - MESSAGE_RETENTION_DAYS * DAY_MS).toISOString();
    const counters = {
      ticketsScanned: 0,
      attachmentTicketsProcessed: 0,
      attachmentsDeleted: 0,
      messagesDeleted: 0,
      storageDeleteFailures: 0,
      messageUpdateFailures: 0,
      unparsedAttachments: 0
    };

    // closed_at is cleared by the database trigger when a ticket is reopened.
    const { data: attachmentTickets, error: attachmentTicketError } = await supabase
      .from('support_tickets')
      .select('id,closed_at')
      .eq('status', 'closed')
      .not('closed_at', 'is', null)
      .lte('closed_at', attachmentCutoff)
      .order('closed_at', { ascending: true })
      .limit(BATCH_SIZE);
    if (attachmentTicketError) throw attachmentTicketError;

    for (const ticket of attachmentTickets || []) {
      counters.ticketsScanned++;
      await deleteTicketAttachments(supabase, ticket.id, counters);
      counters.attachmentTicketsProcessed++;
    }

    // Message deletion is separate and later. This only runs for tickets
    // still closed at the 90-day cutoff, so reopened tickets are protected.
    const { data: messageTickets, error: messageTicketError } = await supabase
      .from('support_tickets')
      .select('id')
      .eq('status', 'closed')
      .not('closed_at', 'is', null)
      .lte('closed_at', messageCutoff)
      .order('closed_at', { ascending: true })
      .limit(BATCH_SIZE);
    if (messageTicketError) throw messageTicketError;

    for (const ticket of messageTickets || []) {
      const { error: deleteError, count } = await supabase
        .from('support_messages')
        .delete({ count: 'exact' })
        .eq('ticket_id', ticket.id);
      if (deleteError) {
        console.error('[support-retention] message deletion failed', { ticketId: ticket.id, error: deleteError.message });
        continue;
      }
      counters.messagesDeleted += Number(count || 0);
    }

    console.info('[support-retention] completed', counters);
    return res.status(200).json({ success: true, counters });
  } catch (error) {
    console.error('[support-retention] failed', error);
    return res.status(500).json({ success: false, message: 'Support retention cleanup failed' });
  }
}
