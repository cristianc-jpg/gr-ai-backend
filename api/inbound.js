// api/inbound.js
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { parse as parseQuery } from 'querystring';

// NEW: brand-controlled replies and NLU-only classifier
import { compose } from '../lib/brand.js';
import { classifyMessage } from '../lib/nlu.js';

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ---------- helpers ----------
async function readRawBody(req) {
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

// Validate Twilio signature (production)
function isValidTwilio(req, paramsObj) {
  const sig = req.headers['x-twilio-signature'];
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sig || !token) return true; // dev mode
  const url = `https://${req.headers.host}/api/inbound`;
  return twilio.validateRequest(token, sig, url, paramsObj);
}

function normE164(s) {
  const digits = String(s || '').replace(/\D/g, '');
  if (!digits) return '';
  const d10 = digits.length === 11 && digits.startsWith('1')
    ? digits
    : (digits.length === 10 ? '1' + digits : digits);
  return `+${d10}`;
}

// Parse owner command like "6" or "6 +13465551234"
function detectOwnerHoursAndPhone(text) {
  const t = String(text || '').trim();
  const hm = t.match(/\b([2-8])\b/);
  const hours = hm ? parseInt(hm[1], 10) : null;
  const pm = t.match(/(\+?1?\D?\d{3}\D?\d{3}\D?\d{4})/);
  const phone = pm ? normE164(pm[1]) : null;
  return { hours, phone };
}

// Helper: determine if stage is already at/after quote
function isAtOrAfterQuote(stage) {
  return stage === 'quote_sent' || stage === 'closed_won' || stage === 'closed_lost';
}

// ---------- Twilio media fetch + upload helpers ----------
async function fetchTwilioMedia(url) {
  const auth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');
  const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) throw new Error(`media fetch ${r.status}`);
  const contentType = r.headers.get('content-type') || 'application/octet-stream';
  const buf = await r.arrayBuffer();
  return { nodeBuf: Buffer.from(new Uint8Array(buf)), contentType };
}

function extFromContentType(ct) {
  const map = { 'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif' };
  return map[ct] || 'bin';
}

function readableKey(fromE164, i, ext) {
  // phone folder (no '+'), date folder, timestamp-based filename
  const phoneSafe = String(fromE164 || '').replace('+','');
  const d = new Date();
  const dateFolder = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return `${phoneSafe}/${dateFolder}/${d.getTime()}_${i}.${ext}`;
}

// ---------- main ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  try {
    const raw = await readRawBody(req);
    const p = typeof raw === 'string' && raw.length ? parseQuery(raw) : (req.body || {});
    const from = normE164((p.From || '').toString().replace(/^whatsapp:/, ''));
    const to   = normE164((p.To   || '').toString().replace(/^whatsapp:/, ''));
    const body = (p.Body || '').toString();
    const sid  = (p.MessageSid || '').toString();
    const numMedia = parseInt(p.NumMedia || '0', 10) || 0;

    if (!isValidTwilio(req, p)) return res.status(403).json({ ok: false, error: 'Invalid Twilio signature' });
    if (!from) return res.status(200).json({ ok: false, error: 'Missing From' });

    // ---------- OWNER CONTROL ----------
    const ownerCell = process.env.OWNER_CELL ? normE164(process.env.OWNER_CELL) : '';
    if (ownerCell && from === ownerCell) {
      const { hours, phone: explicitPhone } = detectOwnerHoursAndPhone(body);
      if (!hours || hours < 2 || hours > 8) {
        await twilioClient.messages.create({
          from: process.env.TWILIO_FROM_NUMBER,
          to: from,
          body: 'Reply with 2–8 to send the hour estimate. To target a specific number, use "6 +13465551234".'
        });
        return res.status(200).json({ ok: true, owner_hint: true });
      }
      let target = null;
      if (explicitPhone) {
        const { data } = await supa
          .from('leads')
          .select('id,phone,name')
          .eq('phone', explicitPhone)
          .maybeSingle();
        target = data || null;
      } else {
        const { data } = await supa
          .from('leads')
          .select('id,phone,name')
          .eq('stage','awaiting_owner_quote')
          .order('updated_at',{ascending:false})
          .limit(1);
        target = data?.[0] || null;
      }
      if (!target) {
        await twilioClient.messages.create({
          from: process.env.TWILIO_FROM_NUMBER,
          to: from,
          body: 'No lead found.'
        });
        return res.status(200).json({ ok:false });
      }
      const quoteText =
        `Here’s your time estimate for the Garage Raid: ~${hours} hour${hours>1?'s':''} on site for a two-person team.\n\n` +
        `What day works best? Morning (8–12) or Afternoon (12–3).`;
      const sentQuote = await twilioClient.messages.create({
        from: process.env.TWILIO_FROM_NUMBER, to: target.phone, body: quoteText
      });
      await supa.from('messages').insert({
        lead_id: target.id, direction:'outbound', body:quoteText, channel:'sms', twilio_message_id: sentQuote.sid
      });
      await supa.from('leads').update({ stage:'quote_sent' }).eq('id', target.id);

      // Best-effort D+1 followup row (if you created the table)
      try {
        await supa.from('followups').insert({
          lead_id: target.id,
          due_at: new Date(Date.now() + 24*60*60*1000).toISOString(),
          kind: 'quote_d1'
        });
      } catch (_) {}

      await twilioClient.messages.create({
        from: process.env.TWILIO_FROM_NUMBER, to: from,
        body:`Sent ${hours}h estimate to ${target.name||target.phone}.`
      });
      return res.status(200).json({ ok:true });
    }

    // ---------- CUSTOMER INBOUND ----------
    const mediaUrls = [];
    for (let i=0;i<numMedia;i++) {
      const url = p[`MediaUrl${i}`];
      if (url) mediaUrls.push(String(url));
    }
    const hasPhotos = mediaUrls.length>0;

    const { data: lead } = await supa
      .from('leads')
      .upsert({ phone: from },{onConflict:'phone'})
      .select()
      .single();

    const leadId = lead.id;
    const existingStage = lead.stage || null;

    // Upload photos to private storage; collect storage object KEYS (paths)
    let mediaPaths = [];
    if (hasPhotos) {
      for (let i=0;i<mediaUrls.length;i++) {
        try {
          const { nodeBuf, contentType } = await fetchTwilioMedia(mediaUrls[i]);
          const ext = extFromContentType(contentType);
          const key = readableKey(from, i, ext);     // e.g. 1737.../2025-09-18/<ts>_0.jpg
          const up = await supa.storage
            .from(process.env.INBOUND_BUCKET || 'inbound-mms')
            .upload(key, nodeBuf, { contentType, upsert:false });
          if (up.error) throw up.error;
          mediaPaths.push(key);
        } catch(e) {
          console.warn('MMS upload warn:', e?.message || e);
        }
      }
    }

    // Store inbound message (note: using media_paths, not public links)
    await supa.from('messages').insert({
      lead_id: leadId,
      direction: 'inbound',
      body: body || (hasPhotos ? '[Photo(s) received]' : ''),
      channel: 'sms',
      twilio_message_id: sid || null,
      media_paths: mediaPaths.length ? mediaPaths : null
    });

    // Stage updates
    if (hasPhotos) {
      if (!isAtOrAfterQuote(existingStage) && existingStage!=='awaiting_owner_quote') {
        await supa.from('leads').update({ stage:'awaiting_owner_quote' }).eq('id', leadId);
      }

      // ---- Secure owner alert: create/reuse token & send single gallery link ----
      if (process.env.OWNER_CELL && process.env.TWILIO_FROM_NUMBER) {
        let galleryUrlText = '';
        try {
          // Try to reuse a valid, unexpired token first
          const { data: tokRows } = await supa
            .from('gallery_tokens')
            .select('token, expires_at')
            .eq('lead_id', leadId)
            .gt('expires_at', new Date().toISOString())
            .order('expires_at', { ascending: false })
            .limit(1);

          let token;
          if (tokRows && tokRows.length) {
            token = tokRows[0].token;
          } else {
            const crypto = await import('crypto');
            token = crypto.randomBytes(16).toString('hex');
            const expiryDays = +(process.env.GALLERY_TOKEN_DAYS || 7);
            const expiresAt = new Date(Date.now() + expiryDays*24*60*60*1000).toISOString();
            await supa.from('gallery_tokens').insert({ lead_id: leadId, token, expires_at: expiresAt });
          }

          const base = process.env.PUBLIC_BASE_URL || 'https://gr-ai-backend.vercel.app';
          const galleryUrl = `${base}/photos.html?token=${encodeURIComponent(token)}`;
          const expiryDays = +(process.env.GALLERY_TOKEN_DAYS || 7);
          galleryUrlText = `\n${galleryUrl}\n(Expires in ${expiryDays} day${expiryDays>1?'s':''})`;
        } catch (e) {
          console.warn('gallery token create/reuse failed:', e?.message || e);
          galleryUrlText = '';
        }

        const alertText =
          `Photos in from ${from} (${mediaPaths.length}).${galleryUrlText}\n` +
          `Reply 2–8 to set hours.`;

        try {
          await twilioClient.messages.create({
            from: process.env.TWILIO_FROM_NUMBER,
            to: process.env.OWNER_CELL,
            body: alertText
          });
        } catch (e) {
          console.warn('owner alert send failed:', e?.message || e);
        }
      }
    } else {
      if (!existingStage || existingStage === 'cold') {
        await supa.from('leads').update({ stage:'qualifying' }).eq('id', leadId);
      }
    }

    // ---------- “options” ping to owner (soft signal) ----------
    const saidOptions = /\boptions?\b/i.test(body || '');
    if (saidOptions && process.env.OWNER_CELL && process.env.TWILIO_FROM_NUMBER) {
      try {
        await twilioClient.messages.create({
          from: process.env.TWILIO_FROM_NUMBER,
          to: process.env.OWNER_CELL,
          body: `Lead ${from} asked for scheduling options. You can follow up or ask me to propose dates.`
        });
      } catch (_) {}
    }

    // ---------- BRAND-CONTROLLED REPLY (classifier → template) ----------
    // Decide the current stage for routing
    const stage = hasPhotos ? 'awaiting_owner_quote' : (existingStage || 'qualifying');

    // If photos arrived, we short-circuit to ack_photos without classifying
    let intent = hasPhotos ? 'ack_photos' : null;

    if (!intent) {
      try {
        const cls = await classifyMessage({ text: body, stage });
        intent = cls.intent || 'unknown';
      } catch (_) {
        intent = 'unknown';
      }
    }

    // Compose brand-approved copy
    const reply = compose(stage, intent, {
      // vars you might want to inject later
    });

    // Send reply via Twilio + log
    const sent = await twilioClient.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to: from,
      body: reply
    });

    await supa.from('messages').insert({
      lead_id: leadId,
      direction: 'outbound',
      body: reply,
      channel: 'sms',
      twilio_message_id: sent.sid
    });

    return res.status(200).json({ ok:true, leadId });
  } catch(e) {
    console.error('Inbound error:', e);
    // Return 200 so Twilio doesn’t hammer retries
    return res.status(200).json({ ok:false, error: String(e.message || e) });
  }
}
