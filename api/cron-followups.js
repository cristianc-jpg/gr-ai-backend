// api/cron-followups.js
import { createClient } from '@supabase/supabase-js';
import Twilio from 'twilio';

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilio = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export default async function handler(req, res) {
  try {
    // Optional: simple auth so randos can’t call this
    const auth = req.headers['authorization'] || '';
    const tokenOk = auth === `Bearer ${process.env.CRON_SECRET}`;
    if (!tokenOk) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const nowIso = new Date().toISOString();

    // 1) get due, unsent followups
    const { data: dues, error: dErr } = await supa
      .from('followups')
      .select('id, lead_id, kind, due_at')
      .lte('due_at', nowIso)
      .is('sent_at', null)
      .limit(50);

    if (dErr) throw dErr;
    if (!dues?.length) return res.status(200).json({ ok: true, processed: 0 });

    // 2) hydrate phones
    const leadIds = [...new Set(dues.map(f => f.lead_id))];
    const { data: leads, error: lErr } = await supa
      .from('leads')
      .select('id, phone')
      .in('id', leadIds);

    if (lErr) throw lErr;
    const phoneByLead = new Map(leads.map(l => [l.id, l.phone]));

    let sentCount = 0;

    for (const f of dues) {
      const to = phoneByLead.get(f.lead_id);
      if (!to) {
        // skip & mark as sent to avoid looping forever
        await supa.from('followups').update({ sent_at: nowIso }).eq('id', f.id);
        continue;
      }

      // 3) message by kind
      let body = '';
      if (f.kind === 'quote_d1') {
        body = "Quick check-in—would you like to hold a **morning (8–12)** or **early afternoon (12–3)** arrival? If you want date options, just say 'options'.";
        // plain SMS: remove **bold**
        body = body.replace(/\*\*/g, '');
      } else {
        body = 'Just checking in—can I answer any questions?';
      }

      try {
        const msg = await twilio.messages.create({
          from: process.env.TWILIO_FROM_NUMBER,
          to,
          body
        });

        // log message
        await supa.from('messages').insert({
          lead_id: f.lead_id,
          direction: 'outbound',
          body,
          channel: 'sms',
          twilio_message_id: msg.sid
        });

        // mark followup sent
        await supa.from('followups').update({ sent_at: new Date().toISOString() }).eq('id', f.id);
        sentCount++;
      } catch (e) {
        console.warn('followup send failed', e?.message || e);
      }
    }

    return res.status(200).json({ ok: true, processed: sentCount });
  } catch (e) {
    console.error('cron-followups error', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
