// api/reply.js
import { createClient } from '@supabase/supabase-js';
import Twilio from 'twilio';

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function normE164(s) {
  const digits = String(s || '').replace(/\D/g, '');
  if (!digits) return '';
  const d10 = digits.length === 11 && digits.startsWith('1') ? digits : (digits.length === 10 ? '1' + digits : digits);
  return `+${d10}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const toRaw = (req.body?.to || '').toString();
    const body = (req.body?.body || '').toString();
    const to = normE164(toRaw);

    if (!to || !body) {
      return res.status(400).json({ ok: false, error: 'Missing "to" or "body"' });
    }

    // Upsert lead
    const { data: leadRow, error: upsertErr } = await supa
      .from('leads')
      .upsert({ phone: to }, { onConflict: 'phone' })
      .select()
      .single();
    if (upsertErr) throw upsertErr;

    // Send SMS
    const msg = await client.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to,
      body
    });

    // Store outbound
    const { error: msgErr } = await supa.from('messages').insert({
      lead_id: leadRow.id,
      direction: 'outbound',
      body,
      channel: 'sms',
      twilio_message_id: msg.sid
    });
    if (msgErr) throw msgErr;

    // Nudge stage if the lead was brand new
    if (!leadRow.stage || leadRow.stage === 'cold') {
      await supa.from('leads').update({ stage: 'qualifying' }).eq('id', leadRow.id);
    }

    return res.status(200).json({ ok: true, sid: msg.sid });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
