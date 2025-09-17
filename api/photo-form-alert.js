// api/photo-form-alert.js
import { createClient } from '@supabase/supabase-js';
import Twilio from 'twilio';

const supa  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilio = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// simple shared-secret check so only Supabase can call this
function authOK(req) {
  const hdr = req.headers['authorization'] || '';
  return hdr === `Bearer ${process.env.PHOTO_ALERT_TOKEN}`;
}

// format helper
function safe(s) { return (s || '').toString().trim(); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  try {
    if (!authOK(req)) return res.status(401).json({ ok:false, error:'unauthorized' });

    const { id, first_name, last_name, email, phone, comments, file_urls, created_date } = req.body || {};

    // Build a short, scannable alert
    const name  = [safe(first_name), safe(last_name)].filter(Boolean).join(' ') || 'New lead';
    const pics  = Array.isArray(file_urls) ? file_urls.length : 0;
    const note  = safe(comments) || '';
    const when  = created_date || new Date().toISOString();

    const lines = [
      `📸 Photo Quote Form`,
      `${name} ${phone ? '· ' + phone : ''}`,
      `${email ? email + ' · ' : ''}${new Date(when).toLocaleString()}`,
      pics ? `${pics} photo${pics > 1 ? 's' : ''}` : 'no photos',
      note ? `“${note.slice(0,120)}${note.length>120?'…':''}”` : ''
    ].filter(Boolean);

    // Send SMS to your Wix/owner alert number
    await twilio.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,          // your Twilio number
      to: process.env.WIX_ALERT_NUMBER || process.env.OWNER_CELL || '+17373771036',
      body: lines.join('\n')
    });

    return res.status(200).json({ ok:true });
  } catch (e) {
    console.error('photo-form-alert error', e);
    return res.status(500).json({ ok:false, error:String(e.message || e) });
  }
}
