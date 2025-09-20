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
  // If already starts with 1 and length 11, keep; otherwise prefix +1
  const d10 = digits.length === 11 && digits.startsWith('1') ? digits : (digits.length === 10 ? '1' + digits : digits);
  return `+${d10}`;
}

// Helper: determine if stage is already at/after quote
function isAtOrAfterQuote(stage) {
  return stage === 'quote_sent' || stage === 'closed_won' || stage === 'closed_lost';
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
    const from = normE164((p.From || '').toString().replace(/^whatsapp:/, ''));
    const to   = normE164((p.To   || '').toString().replace(/^whatsapp:/, ''));
    const body = (p.Body || '').toString();
    const sid  = (p.MessageSid || '').toString();
    const numMedia = parseInt(p.NumMedia || '0', 10) || 0;

    if (!isValidTwilio(req, p)) {
      return res.status(403).json({ ok: false, error: 'Invalid Twilio signature' });
    }
    if (!from) return res.status(200).json({ ok: false, error: 'Missing From' });

    // Upsert the lead by phone
    const { data: lead, error: upErr } = await supa
      .from('leads')
      .upsert({ phone: from }, { onConflict: 'phone' })
      .select()
      .single();
    if (upErr) throw upErr;

    const leadId = lead.id;
    const existingStage = lead.stage || null;

    // Detect photos (MMS)
    const mediaUrls = [];
    for (let i = 0; i < numMedia; i++) {
      const url = p[`MediaUrl${i}`];
      if (url) mediaUrls.push(String(url));
    }
    const hasPhotos = mediaUrls.length > 0;

    // Store inbound message
    const insertPayload = {
      lead_id: leadId,
      direction: 'inbound',
      body: body || (hasPhotos ? '[Photo(s) received]' : ''),
      channel: 'sms',
      twilio_message_id: sid || null,
      // If you later add a media_urls jsonb column, you can include it here:
      // media_urls: hasPhotos ? mediaUrls : null,
    };
    const { error: msgErr } = await supa.from('messages').insert(insertPayload);
    if (msgErr) throw msgErr;

    // Stage updates (idempotent; never downgrade)
    if (hasPhotos) {
      // Move to awaiting_owner_quote only if not already at/after quote
      if (!isAtOrAfterQuote(existingStage) && existingStage !== 'awaiting_owner_quote') {
        await supa.from('leads').update({ stage: 'awaiting_owner_quote' }).eq('id', leadId);
      }
      // 🔹 Track last_intent for simple reporting
      await supa.from('leads').update({ last_intent: 'photos' }).eq('id', leadId);

      // Owner alert (single path; we only message OWNER_CELL to avoid duplicates)
      if (process.env.OWNER_CELL && process.env.TWILIO_FROM_NUMBER) {
        const count = mediaUrls.length;
        const alertText =
          `Photos in from ${from} (${count}). ` +
          `Reply with a number 2–8 on the owner line to set hours.`;
        try {
          await twilioClient.messages.create({
            from: process.env.TWILIO_FROM_NUMBER,
            to: process.env.OWNER_CELL,
            body: alertText,
          });
        } catch (_) {}
      }
    } else {
      // Only set qualifying if lead is new/cold; don't override progressed stages
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

    // Create a short run (we keep it snappy)
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
        ? 'Got your photos—thank you. I’m reviewing them now and will send your time estimate shortly.'
        : 'Hi—this is Garage Raiders. Two wide photos of your garage is the fastest way to get a precise time estimate.');

    // Clean bracket-style citations
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
