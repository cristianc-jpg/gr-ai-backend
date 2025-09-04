// api/inbound.js
import { createClient } from '@supabase/supabase-js';
import { parse } from 'querystring';

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Helper: read Twilio x-www-form-urlencoded body
async function readRawBody(req) {
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const raw = await readRawBody(req);
    const body = parse(raw);

    const from = (body.From || '').replace(/^whatsapp:/, ''); // keep E.164 for SMS
    const to = (body.To || '');
    const text = body.Body || '';
    const sid = body.MessageSid || null;

    if (!from || !text) {
      return res.status(400).json({ ok: false, error: 'Missing From or Body' });
    }

    // 1) upsert lead by phone
    const { data: leadRow, error: upsertErr } = await supa
      .from('leads')
      .upsert({ phone: from }, { onConflict: 'phone' })
      .select()
      .single();
    if (upsertErr) throw upsertErr;

    // 2) insert inbound message
    const { error: msgErr } = await supa.from('messages').insert({
      lead_id: leadRow.id,
      direction: 'inbound',
      body: text,
      channel: 'sms',
      twilio_message_sid: sid
    });
    if (msgErr) throw msgErr;

    // 3) respond OK (no auto-reply yet)
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
