// api/inbound.js
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { parse as parseQuery } from 'querystring';

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const OA_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  'Content-Type': 'application/json',
  'OpenAI-Beta': 'assistants=v2',
};

// ---------- templates ----------
const TEMPLATES = {
  photos: "Got your photos, thank you. The team will review and text your estimate shortly.",
  estimate: "The fastest way is to send a couple photos of your garage. That lets us give you an exact time estimate for your Garage Raid.",
  options: "We typically start at 9:00 AM, but we may have afternoon slots as well. What works best for you?",
  pricing: "Our Garage Raid service is $139 per hour for a team of two raiders, plus a one-time $49 fuel fee. Once we see your garage photos, we can give you an accurate time estimate.",
  faq: "Yes! We can install ceiling racks, shelves, or even coat your floor with epoxy. Every Garage Raid includes deep cleaning, organizing, and donation drop-off."
};

// ---------- intent detector ----------
function detectIntent(body, hasPhotos) {
  const text = (body || "").toLowerCase();

  if (hasPhotos) return "photos";

  // Estimate intent
  if (/\b(estimate|quote|get started|how long|time|duration)\b/.test(text)) return "estimate";

  // Scheduling intent
  if (/\b(option|available|schedule|day|time|date|appointment|book|slot)\b/.test(text)) return "options";

  // Pricing intent
  if (/\b(price|cost|how much|rate|charge|fee)\b/.test(text)) return "pricing";

  // FAQ intent
  if (/\b(rack|shelf|epoxy|paint|organize|clean|storage)\b/.test(text)) return "faq";

  return null; // fallback → OpenAI assistant
}

// ---------- helpers ----------
async function readRawBody(req) {
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

async function openai(path, options = {}) {
  const res = await fetch(`https://api.openai.com/v1${path}`, {
    ...options,
    headers: { ...OA_HEADERS, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

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
    : digits.length === 10 ? '1' + digits : digits;
  return `+${d10}`;
}

function detectOwnerHoursAndPhone(text) {
  const t = String(text || '').trim();
  const hm = t.match(/\b([2-8])\b/);
  const hours = hm ? parseInt(hm[1], 10) : null;
  const pm = t.match(/(\+?1?\D?\d{3}\D?\d{3}\D?\d{4})/);
  const phone = pm ? normE164(pm[1]) : null;
  return { hours, phone };
}

function isAtOrAfterQuote(stage) {
  return stage === 'quote_sent' || stage === 'closed_won' || stage === 'closed_lost';
}

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
      // ... (owner quote logic unchanged) ...
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

    // --- NEW: template guardrails ---
    const intent = detectIntent(body, hasPhotos);
    if (intent && TEMPLATES[intent]) {
      const reply = TEMPLATES[intent];
      const sent = await twilioClient.messages.create({
        from: process.env.TWILIO_FROM_NUMBER,
        to: from,
        body: reply
      });
      await supa.from('messages').insert({
        lead_id: leadId,
        direction:'outbound',
        body: reply,
        channel:'sms',
        twilio_message_id: sent.sid,
        metadata: { source: "template", intent }
      });
      return res.status(200).json({ ok:true, leadId, handledBy:"template", intent });
    }

    // --- fallback → assistant logic ---
    await supa.from('messages').insert({
      lead_id: leadId,
      direction: 'inbound',
      body: body || (hasPhotos ? '[Photo(s) received]' : ''),
      channel: 'sms',
      twilio_message_id: sid || null
    });

    // ... (OpenAI thread + run unchanged) ...
  } catch(e) {
    console.error('Inbound error:', e);
    return res.status(200).json({ ok:false, error: String(e.message || e) });
  }
}
