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

// ---- helpers ---------------------------------------------------------------

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

// Validate Twilio signature (recommended)
function isValidTwilio(req, paramsObj) {
  const sig = req.headers['x-twilio-signature'];
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!sig || !authToken) return true; // if token missing, don't block (dev mode)
  const url = `https://${req.headers.host}/api/inbound`; // exact public URL Twilio calls
  return twilio.validateRequest(authToken, sig, url, paramsObj);
}

// ----------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  try {
    // Parse application/x-www-form-urlencoded (Twilio default)
    const raw = await readRawBody(req);
    const params = typeof raw === 'string' && raw.length ? parseQuery(raw) : (req.body || {});
    const from = (params.From || '').toString().replace(/^whatsapp:/, '');
    const text = (params.Body || '').toString();
    const sid = (params.MessageSid || '').toString();

    // Signature check (no generic Authorization header required)
    if (!isValidTwilio(req, params)) {
      return res.status(403).json({ ok: false, error: 'Invalid Twilio signature' });
    }

    if (!from || !text) {
      return res.status(200).json({ ok: false, error: 'Missing From or Body' });
    }

    // Upsert lead by phone
    const { data: leadRow, error: upsertErr } = await supa
      .from('leads')
      .upsert({ phone: from }, { onConflict: 'phone' })
      .select()
      .single();
    if (upsertErr) throw upsertErr;

    const leadId = leadRow.id;

    // Store inbound message
    const { error: msgErr } = await supa.from('messages').insert({
      lead_id: leadId,
      direction: 'inbound',
      body: text,
      channel: 'sms',
      twilio_message_sid: sid || null,
    });
    if (msgErr) throw msgErr;

    // Optional: send yourself an alert
    if (process.env.WIX_ALERT_NUMBER) {
      try {
        await twilioClient.messages.create({
          from: process.env.TWILIO_FROM_NUMBER,
          to: process.env.WIX_ALERT_NUMBER,
          body: `📩 New SMS from ${from}: ${text}`,
        });
      } catch (_) {
        // non-fatal
      }
    }

    // Ensure OpenAI thread
    let threadId = leadRow.thread_id;
    if (!threadId) {
      const created = await openai('/threads', { method: 'POST', body: JSON.stringify({}) });
      threadId = created.id;
      const { error: leadUpdateErr } = await supa.from('leads').update({ thread_id: threadId }).eq('id', leadId);
      if (leadUpdateErr) throw leadUpdateErr;
    }

    // Append user's message
    await openai(`/threads/${threadId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'user', content: text }),
    });

    // Create run
    const run = await openai(`/threads/${threadId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ assistant_id: process.env.OPENAI_ASSISTANT_ID, metadata: { phone: from } }),
    });

    // Poll briefly (keep it snappy for Twilio)
    let runStatus = run;
    const deadline = Date.now() + 10000; // 10s cap
    while (['queued', 'in_progress', 'cancelling'].includes(runStatus.status)) {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 900));
      runStatus = await openai(`/threads/${threadId}/runs/${run.id}`, { method: 'GET' });

      if (runStatus.status === 'requires_action' && runStatus.required_action?.submit_tool_outputs) {
        const calls = runStatus.required_action.submit_tool_outputs.tool_calls || [];
        const tool_outputs = calls.map((c) => ({
          tool_call_id: c.id,
          output: JSON.stringify({ ok: true, note: 'Tool not implemented yet on server.' }),
        }));
        await openai(`/threads/${threadId}/runs/${run.id}/submit_tool_outputs`, {
          method: 'POST',
          body: JSON.stringify({ tool_outputs }),
        });
      }
    }

    // Fetch the latest assistant message
    const list = await openai(`/threads/${threadId}/messages?order=desc&limit=1`, { method: 'GET' });
    const last = list.data?.[0];
    let reply =
      last?.content?.[0]?.text?.value ||
      "Thanks for reaching out to Garage Raiders—we’ll follow up shortly.";

    // Clean bracket-style citations
    reply = reply
      .replace(/【\d+:\d+†.*?†.*?】/g, '')
      .replace(/\[\d+\]/g, '')
      .replace(/\(source.*?\)/gi, '');

    // Send reply via Twilio + store outbound
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
      twilio_message_sid: sent.sid,
    });

    return res.status(200).json({ ok: true, threadId, runId: run.id, sid: sent.sid });
  } catch (e) {
    console.error('Inbound error:', e);
    // Respond 200 so Twilio doesn't retry forever
    return res.status(200).json({ ok: false, error: String(e.message || e) });
  }
}
