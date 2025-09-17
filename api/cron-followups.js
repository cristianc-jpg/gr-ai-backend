import { createClient } from '@supabase/supabase-js';
import Twilio from 'twilio';

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const tw = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export default async function handler(req, res){
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');
  try {
    const now = new Date().toISOString();
    const { data: due, error } = await supa
      .from('followups')
      .select('id, lead_id, kind, due_at, sent, leads!inner(id, phone, name, stage)')
      .eq('sent', false)
      .lte('due_at', now)
      .limit(20);
    if (error) throw error;

    for (const f of due || []) {
      const phone = f.leads?.phone;
      if (!phone) continue;

      let body = '';
      if (f.kind === 'quote_d1') {
        body = `Just checking in—would you like to grab a spot? We have morning (8–12) and early afternoon (12–3) arrivals.`;
      }
      if (!body) continue;

      await tw.messages.create({ from: process.env.TWILIO_FROM_NUMBER, to: phone, body });
      await supa.from('messages').insert({
        lead_id: f.lead_id, direction: 'outbound', body, channel: 'sms'
      });
      await supa.from('followups').update({ sent: true }).eq('id', f.id);
    }

    return res.status(200).json({ ok:true, processed:(due||[]).length });
  } catch (e) {
    console.error('cron-followups error:', e);
    return res.status(200).json({ ok:false, error:String(e.message||e) });
  }
}
