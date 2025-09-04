// api/messages.js
import { createClient } from '@supabase/supabase-js';
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  try {
    const { lead_id } = req.query;
    if (!lead_id) return res.status(400).json({ ok: false, error: 'Missing lead_id' });

    const { data: msgs, error } = await supa
      .from('messages')
      .select('id, direction, body, created_at')
      .eq('lead_id', lead_id)
      .order('created_at', { ascending: true })
      .limit(1000);
    if (error) throw error;

    return res.status(200).json({ ok: true, messages: msgs });
  } catch (e) {
    console.error('messages error', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
