// api/leads.js
import { createClient } from '@supabase/supabase-js';
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  try {
    // Get leads ordered by updated_at desc
    const { data: leads, error } = await supa
      .from('leads')
      .select('id, phone, name, status, updated_at')
      .order('updated_at', { ascending: false })
      .limit(200);
    if (error) throw error;

    // For each lead, get last message
    const results = [];
    for (const lead of leads) {
      const { data: msgs, error: mErr } = await supa
        .from('messages')
        .select('body, direction, created_at')
        .eq('lead_id', lead.id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (mErr) throw mErr;

      const last = msgs?.[0] || null;
      results.push({
        id: lead.id,
        phone: lead.phone,
        name: lead.name,
        status: lead.status,
        last_message: last?.body || '',
        last_direction: last?.direction || '',
        last_time: last?.created_at || lead.updated_at
      });
    }

    return res.status(200).json({ ok: true, leads: results });
  } catch (e) {
    console.error('leads error', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
