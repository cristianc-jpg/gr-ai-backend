// api/lead-media.js
import { createClient } from '@supabase/supabase-js';
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');
  try {
    const lead_id = (req.query.lead_id || '').toString();
    const phone   = (req.query.phone   || '').toString();

    // Resolve lead_id from phone if needed
    let lid = lead_id;
    if (!lid && phone) {
      const { data: led, error } = await supa
        .from('leads')
        .select('id')
        .eq('phone', phone)
        .maybeSingle();
      if (error) throw error;
      lid = led?.id || '';
    }
    if (!lid) return res.status(400).json({ ok:false, error:'missing lead_id or phone' });

    // Pull all message media for that lead
    const { data: msgs, error: merr } = await supa
      .from('messages')
      .select('id, created_at, media_urls')
      .eq('lead_id', lid)
      .not('media_urls','is', null)
      .order('created_at', { ascending: true })
      .limit(500);
    if (merr) throw merr;

    // Flatten with timestamps
    const items = [];
    for (const m of (msgs || [])) {
      const arr = Array.isArray(m.media_urls) ? m.media_urls : [];
      for (const url of arr) items.push({ url, created_at: m.created_at, message_id: m.id });
    }
    // Oldest -> newest
    items.sort((a,b) => new Date(a.created_at) - new Date(b.created_at));

    return res.status(200).json({ ok:true, lead_id: lid, count: items.length, items });
  } catch (e) {
    console.error('lead-media error:', e);
    return res.status(500).json({ ok:false, error: String(e.message || e) });
  }
}
