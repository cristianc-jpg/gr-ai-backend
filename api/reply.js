// api/reply.js
import { createClient } from '@supabase/supabase-js';
import Twilio from 'twilio';

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const { to, body } = req.body || {};

    if (!to || !body) {
      return res.status(400).json({ ok: false, error: 'Missing "to" or "body"' });
    }

    // normalize phone (assume already in E.164). If not, add your own formatter here.

    // 1) upsert lead
    const { data: leadRow, error: upsertErr } = await supa
      .from('leads')
      .upsert({ phone: to }, { onConflict: 'phone' })
      .select()
      .single();
    if (upsertErr) throw upsertErr;

    // 2) send SMS via Twilio
    const msg = await client.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to,
      body
    });

    // 3) store outbound message
    const { error: msgErr } = await supa.from('messages').insert({
      lead_id: leadRow.id,
      direction: 'outbound',
      body,
      channel: 'sms',
      twilio_message_sid: msg.sid
    });
    if (msgErr) throw msgErr;

    return res.status(200).json({ ok: true, sid: msg.sid });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
