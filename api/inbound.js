// api/inbound.js
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { parse as parseQuery } from 'querystring';

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const OA_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  'Content-Type': 'application/json',
  'OpenAI-Beta': 'assistants=v2',
};

// ---------- helpers ----------
async function readRawBody(req) {
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

async function openai(path, options = {}) {
  const res = await fetch(`https://api.openai.com/v1${path}`, {
    ...options,
    headers: { ...OA_HEADERS, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// Validate Twilio signature (production)
function isValidTwilio(req, paramsObj) {
  const sig = req.headers['x-twilio-signature'];
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sig || !token) return true; // dev mode
  const url = `https://${req.headers.host}/api/inbound`;
  return twilio.validateRequest(token, sig, url, paramsObj);
}

function normE164(s) {
  const digits = String(s || '').replace(/\D/g, '');
  if (!digits) return '';
  const d10 = digits.length === 11 && digits.startsWith('1') ? digits
           : digits.length === 10 ? '1' + digits
           : digits;
  return `+${d10}`;
}

// Parse owner command like "6" or "6 +13465551234"
function detectOwnerHoursAndPhone(text) {
  const t = String(text || '').trim();
  const hm = t.match(/\b([2-8])\b/);
  const hours = hm ? parseInt(hm[1], 10) : null;
  const pm = t.match(/(\+?1?\D?\d{3}\D?\d{3}\D?\d{4})/);
  const phone = pm ? normE164(pm[1]) : null;
  return { hours, phone };
}

// Helper: determine if stage is already at/after quote
function isAtOrAfterQuote(stage) {
  return stage === 'quote_sent' || stage === 'closed_won' || stage === 'closed_lost';
}

// ---------- Twilio media fetch + upload helpers ----------
async function fetchTwilioMedia(url) {
  // Twilio MMS media URLs require basic auth with your SID/token
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) throw new Error(`media fetch ${r.status}`);
  const contentType = r.headers.get('content-type') || 'application/octet-stream';
  const buf = await r.arrayBuffer();
  // Convert ArrayBuffer -> Node Buffer for supabase-js in Node runtimes
  const nodeBuf = Buffer.from(new Uint8Array(buf));
  return { nodeBuf, contentType };
}

function extFromContentType(ct) {
  const map = { 'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif' };
  return map[ct] || 'bin';
}

function readableKey(fromE164, i, ext) {
  // phone folder (no '+'), date folder, timestamp-based filename
  const phoneSafe = String(fromE164 || '').replace('+','');
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  const dateFolder = `${y}-${m}-${day}`;
  const ts = d.getTime();
  return `${phoneSafe}/${dateFolder}/${ts}_${i}.${ext}`;
}

// ---------- main ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  try {
    // Parse Twilio x-www-form-urlencoded
    const raw = await readRawBody(req);
    const p = typeof raw === 'string' && raw.length ? parseQuery(raw) : (req.body || {});
    const fromRaw = (p.From || '').toString().replace(/^whatsapp:/, '');
    const toRaw   = (p.To   || '').toString().replace(/^whatsapp:/, '');
    const from = normE164(fromRaw);
    const to   = normE164(toRaw);
    const body = (p.Body || '').toString();
    const sid  = (p.MessageSid || '').toString();
    const numMedia = parseInt(p.NumMedia || '0', 10) || 0;

    if (!isValidTwilio(req, p)) {
      return res.status(403).json({ ok: false, error: 'Invalid Twilio signature' });
    }
    if (!from) return res.status(200).json({ ok: false, error: 'Missing From' });

    // ---------- OWNER CONTROL SHORT-CIRCUIT ----------
    const ownerCell = process.env.OWNER_CELL ? normE164(process.env.OWNER_CELL) : '';
    const fromE164  = from;

    if (ownerCell && fromE164 === ownerCell) {
      const { hours, phone: explicitPhone } = detectOwnerHoursAndPhone(body);

      if (!hours || hours < 2 || hours > 8) {
        await twilioClient.messages.create({
          from: process.env.TWILIO_FROM_NUMBER,
          to: fromE164,
          body: 'Reply with a number 2–8 to send the hour estimate. To target a specific number, use e.g. "6 +13465884264".'
        });
        return res.status(200).json({ ok: true, owner_hint: true });
      }

      // Resolve target lead: explicit phone beats queue
      let target = null;
      if (explicitPhone) {
        const { data: byPhone, error: lerr } = await supa
          .from('leads')
          .select('id, phone, name')
          .eq('phone', explicitPhone)
          .maybeSingle();
        if (lerr) throw lerr;
        target = byPhone || null;
      } else {
        const { data: awaiting, error: aerr } = await supa
          .from('leads')
          .select('id, phone, name')
          .eq('stage', 'awaiting_owner_quote')
          .order('updated_at', { ascending: false })
          .limit(1);
        if (aerr) throw aerr;
        target = awaiting?.[0] || null;
      }

      if (!target) {
        await twilioClient.messages.create({
          from: process.env.TWILIO_FROM_NUMBER,
          to: fromE164,
          body: 'No lead found to send that estimate. Include the phone, e.g. "6 +13465884264".'
        });
        return res.status(200).json({ ok: false, reason: 'no_target' });
      }

      const quoteText =
        `Here’s your time estimate for the Garage Raid: ~${hours} hour${hours>1?'s':''} on site for a two-person team.\n\n` +
        `What day works best? We hold morning (8–12) and early afternoon (12–3) arrivals. ` +
        `If you’d like to see openings, just say “options”.`;

      // Send quote to customer
      const sentQuote = await twilioClient.messages.create({
        from: process.env.TWILIO_FROM_NUMBER,
        to: target.phone,
        body: quoteText
      });

      // Log + stage update + schedule D+1 follow-up (best-effort)
      await supa.from('messages').insert({
        lead_id: target.id,
        direction: 'outbound',
        body: quoteText,
        channel: 'sms',
        twilio_message_id: sentQuote.sid
      });
      await supa.from('leads').update({ stage: 'quote_sent' }).eq('id', target.id);
      try {
        await supa.from('followups').insert({
          lead_id: target.id,
          due_at: new Date(Date.now() + 24*60*60*1000).toISOString(),
          kind: 'quote_d1'
        });
      } catch (_) {}

      // Confirm back to owner
      await twilioClient.messages.create({
        from: process.env.TWILIO_FROM_NUMBER,
        to: fromE164,
        body: `Sent ${hours}h estimate to ${target.name || target.phone}.`
      });

      // IMPORTANT: stop here; do not call OpenAI for owner commands
      return res.status(200).json({ ok: true, owner_quote_sent: true, hours, to: target.phone });
    }
    // ---------- END OWNER CONTROL SHORT-CIRCUIT ----------

    // Detect photos (MMS)
    const mediaUrls = [];
    for (let i = 0; i < numMedia; i++) {
      const url = p[`MediaUrl${i}`];
      if (url) mediaUrls.push(String(url));
    }
    const hasPhotos = mediaUrls.length > 0;

    // Upsert the (customer) lead by phone
    const { data: lead, error: upErr } = await supa
      .from('leads')
      .upsert({ phone: from }, { onConflict: 'phone' })
      .select()
      .single();
    if (upErr) throw upErr;

    const leadId = lead.id;
    const existingStage = lead.stage || null;

    // If MMS: upload to Supabase Storage and build public links
    let publicMedia = [];
    if (hasPhotos) {
      try {
        for (let i = 0; i < mediaUrls.length; i++) {
          const { nodeBuf, contentType } = await fetchTwilioMedia(mediaUrls[i]);
          const ext = extFromContentType(contentType);
          const key = readableKey(from, i, ext); // phone/date/timestamp path for readability
          const up = await supa.storage.from('inbound-mms').upload(key, nodeBuf, {
            contentType,
            upsert: false
          });
          if (up.error) throw up.error;
          publicMedia.push(`${process.env.SUPABASE_URL}/storage/v1/object/public/inbound-mms/${key}`);
        }
      } catch (e) {
        console.warn('MMS upload warning:', e?.message || e);
        // proceed without links if upload failed
        publicMedia = [];
      }
    }

    // Store inbound message
    const insertPayload = {
      lead_id: leadId,
      direction: 'inbound',
      body: body || (hasPhotos ? '[Photo(s) received]' : ''),
      channel: 'sms',
      twilio_message_id: sid || null,
      media_urls: hasPhotos && publicMedia.length ? publicMedia : null,
    };
    const { error: msgErr } = await supa.from('messages').insert(insertPayload);
    if (msgErr) throw msgErr;

    // Stage updates (idempotent; never downgrade)
    if (hasPhotos) {
      if (!isAtOrAfterQuote(existingStage) && existingStage !== 'awaiting_owner_quote') {
        await supa.from('leads').update({ stage: 'awaiting_owner_quote' }).eq('id', leadId);
      }
      // Owner alert with clickable links (cap 3 to limit SMS segments)
      if (process.env.OWNER_CELL && process.env.TWILIO_FROM_NUMBER) {
        const links = (publicMedia || []).slice(0, 3);
        const more = publicMedia.length > links.length ? ` (+${publicMedia.length - links.length} more)` : '';
        const alertText =
          `Photos in from ${from} (${publicMedia.length}). Reply 2–8 to set hours.` +
          (links.length ? `\n${links.join('\n')}${more}` : '');
        try {
          await twilioClient.messages.create({
            from: process.env.TWILIO_FROM_NUMBER,
            to: process.env.OWNER_CELL,
            body: alertText,
          });
        } catch (_) {}
      }
    } else {
      if (!existingStage || existingStage === 'cold') {
        await supa.from('leads').update({ stage: 'qualifying' }).eq('id', leadId);
      }
    }

    // Ensure an OpenAI thread for this lead
    let threadId = lead.thread_id;
    if (!threadId) {
      const created = await openai('/threads', { method: 'POST', body: JSON.stringify({}) });
      threadId = created.id;
      const { error: upLead } = await supa.from('leads').update({ thread_id: threadId }).eq('id', leadId);
      if (upLead) throw upLead;
    }

    // Append the message for the model
    if (body) {
      await openai(`/threads/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role: 'user', content: body }),
      });
    } else if (hasPhotos) {
      await openai(`/threads/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role: 'user', content: 'Sent photos of the garage.' }),
      });
    }

    // Create a short run
    const run = await openai(`/threads/${threadId}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        assistant_id: process.env.OPENAI_ASSISTANT_ID,
        metadata: { phone: from, stage: hasPhotos ? 'awaiting_owner_quote' : (existingStage || 'qualifying') },
      }),
    });

    // Quick poll (<=10s)
    let status = run;
    const deadline = Date.now() + 10000;
    while (['queued', 'in_progress', 'cancelling'].includes(status.status)) {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 800));
      status = await openai(`/threads/${threadId}/runs/${run.id}`, { method: 'GET' });

      if (status.status === 'requires_action' && status.required_action?.submit_tool_outputs) {
        const calls = status.required_action.submit_tool_outputs.tool_calls || [];
        const tool_outputs = calls.map((c) => ({
          tool_call_id: c.id,
          output: JSON.stringify({ ok: true, note: 'tool not implemented yet' }),
        }));
        await openai(`/threads/${threadId}/runs/${run.id}/submit_tool_outputs`, {
          method: 'POST',
          body: JSON.stringify({ tool_outputs }),
        });
      }
    }

    // Get latest assistant message
    const list = await openai(`/threads/${threadId}/messages?order=desc&limit=1`, { method: 'GET' });
    const last = list.data?.[0];
    let reply =
      last?.content?.[0]?.text?.value ||
      (hasPhotos
        ? 'Got your photos—thank you. The owner will review and text your time estimate shortly.'
        : 'Hi—this is Garage Raiders. Two wide photos of your garage is the fastest way to get a precise time estimate.');

    // Remove bracket citations if any
    reply = reply.replace(/【\d+:\d+†.*?†.*?】/g, '').replace(/\[\d+\]/g, '').replace(/\(source.*?\)/gi, '');

    // Send reply and log outbound
    const sent = await twilioClient.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to: from,
      body: reply,
    });

    await supa.from('messages').insert({
      lead_id: leadId,
      direction: 'outbound',
      body: reply,
      channel: 'sms',
      twilio_message_id: sent.sid,
    });

    return res.status(200).json({ ok: true, leadId, threadId, runId: run.id });
  } catch (e) {
    console.error('Inbound error:', e);
    // Return 200 so Twilio doesn’t hammer retries
    return res.status(200).json({ ok: false, error: String(e.message || e) });
  }
}
