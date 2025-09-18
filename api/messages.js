// api/messages.js
import { createClient } from '@supabase/supabase-js';

const supa = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  try {
    const { lead_id } = req.query;
    if (!lead_id) {
      return res.status(400).json({ ok: false, error: 'Missing lead_id' });
    }

    // 1) Fetch messages (now including media_paths)
    const { data: msgs, error: mErr } = await supa
      .from('messages')
      .select('id, direction, body, media_paths, created_at')
      .eq('lead_id', lead_id)
      .order('created_at', { ascending: true })
      .limit(1000);

    if (mErr) throw mErr;

    // 2) Ensure there is a valid gallery token for this lead (for the UI link)
    let galleryToken = null;
    try {
      // try to reuse a valid, unexpired token
      const { data: tokRows, error: tErr } = await supa
        .from('gallery_tokens')
        .select('token, expires_at')
        .eq('lead_id', lead_id)
        .gt('expires_at', new Date().toISOString())
        .order('expires_at', { ascending: false })
        .limit(1);

      if (tErr) throw tErr;

      if (tokRows && tokRows.length) {
        galleryToken = tokRows[0].token;
      } else {
        // create a new token
        const crypto = await import('crypto');
        const token = crypto.randomBytes(16).toString('hex');
        const days = +(process.env.GALLERY_TOKEN_DAYS || 7);
        const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

        const { error: insErr } = await supa
          .from('gallery_tokens')
          .insert({ lead_id, token, expires_at: expiresAt });

        if (insErr) {
          console.warn('gallery token insert failed:', insErr.message || insErr);
        } else {
          galleryToken = token;
        }
      }
    } catch (e) {
      console.warn('gallery token ensure failed:', e?.message || e);
    }

    return res.status(200).json({ ok: true, messages: msgs, gallery_token: galleryToken });
  } catch (e) {
    console.error('messages error', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
