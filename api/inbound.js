// api/inbound.js
import { createClient } from '@supabase/supabase-js';
import Twilio from 'twilio';
import { parse } from 'querystring';

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const OA_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  'Content-Type': 'application/json',
  'OpenAI-Beta': 'assistants=v2'
};

// Read Twilio x-www-form-urlencoded body
async function readRawBody(req) {
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

async function openai(path, options = {}) {
  const res = await fetch(`https://api.openai.com/v1${path}`, {
    ...options,
    headers: { ...OA_HEADERS, ...(options.headers || {}) }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    // 1) Parse inbound Twilio webhook
    const raw = await readRawBody(req);
    const body = parse(raw);
    const from = (body.From || '').replace(/^whatsapp:/, '');
    const text = body.Body || '';
    const sid = body.MessageSid || null;

    if (!from || !text) {
      return res.status(400).json({ ok: false, error: 'Missing From or Body' });
    }

    // 2) Upsert lead by phone
    const { data: leadRow, error: upsertErr } = await supa
      .from('leads')
      .upsert({ phone: from }, { onConflict: 'phone' })
      .select()
      .single();
    if (upsertErr) throw upsertErr;

    const leadId = leadRow.id;

    // 3) Store inbound message
    const { error: msgErr } = await supa.from('messages').insert({
      lead_id: leadId,
      direction: 'inbound',
      body: text,
      channel: 'sms',
      twilio_message_sid: sid
    });
    if (msgErr) throw msgErr;
    // 👇 add this block right after inserting the inbound message
if (text && from) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_FROM_NUMBER, // your Twilio number
    to: process.env.WIX_ALERT_NUMBER,     // your Wix cell/forwarding number
    body: `📩 New SMS from ${from}: ${text}`
  });
}
    // 4) Ensure we have a thread for this lead
    let threadId = leadRow.thread_id;
    if (!threadId) {
      const created = await openai('/threads', { method: 'POST', body: JSON.stringify({}) });
      threadId = created.id;

      const { error: leadUpdateErr } = await supa
        .from('leads')
        .update({ thread_id: threadId })
        .eq('id', leadId);
      if (leadUpdateErr) throw leadUpdateErr;
    }

    // 5) Append user's message to the thread
    await openai(`/threads/${threadId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        role: 'user',
        content: text
      })
    });

    // 6) Create a run with your Assistant
    const run = await openai(`/threads/${threadId}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        assistant_id: process.env.OPENAI_ASSISTANT_ID,
        metadata: { phone: from }
      })
    });

    // 7) Poll until done (and handle tool calls if needed)
    let runStatus = run;
    const deadline = Date.now() + 15000; // ~15s
    while (['queued', 'in_progress', 'cancelling'].includes(runStatus.status)) {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 1000));
      runStatus = await openai(`/threads/${threadId}/runs/${run.id}`, { method: 'GET' });

      // If assistant requests tools, stub them for now and continue
      if (runStatus.status === 'requires_action' && runStatus.required_action?.submit_tool_outputs) {
        const calls = runStatus.required_action.submit_tool_outputs.tool_calls || [];
        const tool_outputs = calls.map((c) => {
          // You can implement real logic based on c.function.name & c.function.arguments
          // For now we acknowledge so the run can continue.
          return {
            tool_call_id: c.id,
            output: JSON.stringify({ ok: true, note: 'Tool not implemented yet on server. Human will follow up.' })
          };
        });

        await openai(`/threads/${threadId}/runs/${run.id}/submit_tool_outputs`, {
          method: 'POST',
          body: JSON.stringify({ tool_outputs })
        });
      }
    }

    // 8) Fetch the latest assistant message
    const list = await openai(`/threads/${threadId}/messages?order=desc&limit=1`, { method: 'GET' });
    const last = list.data?.[0];
    let reply =
      last?.content?.[0]?.text?.value ||
      "Thanks for reaching out to Garage Raiders, we’ll follow up shortly.";

    // 9) Send reply via Twilio + store outbound
    const sent = await twilioClient.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to: from,
      body: reply
    });

    const { error: outErr } = await supa.from('messages').insert({
      lead_id: leadId,
      direction: 'outbound',
      body: reply,
      channel: 'sms',
      twilio_message_sid: sent.sid
    });
    if (outErr) throw outErr;

    return res.status(200).json({ ok: true, threadId, runId: run.id, sid: sent.sid });
  } catch (e) {
    console.error('Inbound error:', e);
    // Fail closed but respond 200 so Twilio doesn’t retry forever
    return res.status(200).json({ ok: false, error: String(e.message || e) });
  }
}
