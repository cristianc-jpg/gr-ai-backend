// api/reply.js
import { createClient } from '@supabase/supabase-js';
import Twilio from 'twilio';

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Normalize to E.164 (+1XXXXXXXXXX).
function normE164(s) {
  const digits = String(s || '').replace(/\D/g, '');
  if (!digits) return '';
  const d10 = digits.length === 11 && digits.startsWith('1') ? digits
           : digits.length === 10 ? '1' + digits
           : digits;
  return `+${d10}`;
}

// Detect “quote-like” messages (2–8 hours).
function detectQuotedHours(text) {
  const t = (text || '').toLowerCase();
  const m = t.match(/\b([2-8])\s*(?:-|to\s*)?[2-8]?\s*(?:h|hr|hrs|hour|hours)\b/);
  if (m && m[1]) return parseInt(m[1], 10);
  const m2 = t.match(/[~≈]\s*([2-8])\b/);
  if (m2 && m2[1] && /\bh(?:r|rs)?|hour/.test(t)) return parseInt(m2[1], 10);
  return null;
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

    // Send SMS via Twilio
    const msg = await client.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to,
      body
    });

    // Store outbound message
    await supa.from('messages').insert({
      lead_id: leadRow.id,
      direction: 'outbound',
      body,
      channel: 'sms',
      twilio_message_id: msg.sid
    });

    // Stage updates
    const updates = {};
    if (!leadRow.stage || leadRow.stage === 'cold') {
      updates.stage = 'qualifying';
    }

    const hoursQuoted = detectQuotedHours(body);
    if (hoursQuoted && hoursQuoted >= 2 && hoursQuoted <= 8) {
      updates.stage = 'quote_sent';
      try {
        const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await supa.from('followups').insert({
          lead_id: leadRow.id,
          due_at: dueAt,
          kind: 'quote_d1'
        });
      } catch (_) {}
    }

    if (Object.keys(updates).length > 0) {
      await supa.from('leads').update(updates).eq('id', leadRow.id);
    }

    return res.status(200).json({ ok: true, sid: msg.sid, quoted_hours: hoursQuoted || null });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
