// api/lead-media.js
import { createClient } from '@supabase/supabase-js';

const supa = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    const token = (req.query.token || '').toString().trim();
    if (!token) {
      return res.status(400).json({ ok: false, error: 'Missing token' });
    }

    // Look up token record
    const { data: tokenRow, error: tokenErr } = await supa
      .from('gallery_tokens')
      .select('id, lead_id, expires_at')
      .eq('token', token)
      .maybeSingle();

    if (tokenErr) throw tokenErr;
    if (!tokenRow) {
      return res.status(403).json({ ok: false, error: 'Invalid token' });
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      return res.status(403).json({ ok: false, error: 'Expired token' });
    }

    // Get lead’s photos
    const { data: msgs, error: msgErr } = await supa
      .from('messages')
      .select('media_paths')
      .eq('lead_id', tokenRow.lead_id)
      .not('media_paths', 'is', null);

    if (msgErr) throw msgErr;

    const bucket = process.env.INBOUND_BUCKET || 'inbound-mms';
    const paths = msgs.flatMap(m => m.media_paths || []);

    // Generate signed URLs for each file
    const signedUrls = [];
    for (const path of paths) {
      const { data, error } = await supa
        .storage
        .from(bucket)
        .createSignedUrl(path, 60 * 60); // 1 hour expiry
      if (error) continue;
      signedUrls.push(data.signedUrl);
    }

    return res.status(200).json({ ok: true, files: signedUrls });
  } catch (e) {
    console.error('lead-media error:', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
