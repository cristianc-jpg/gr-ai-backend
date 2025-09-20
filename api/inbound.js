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

// ---------- templates (guardrails) ----------
const TEMPLATES = {
  photos: "Thank you! We have your photos. The team will review them and text your estimate shortly.",
  estimate: "The fastest way is to send a couple photos of your garage. That lets us give you an exact time estimate for your Garage Raid.",
  options: "We typically start at 9:00 AM, but we may have afternoon slots as well. What works best for you?",
  pricing: "Our Garage Raid service is $139 per hour for a team of two raiders, plus a one-time $49 fuel fee. Once we see your garage photos, we can give you an accurate time estimate.",
  faq: "Yes! We can install ceiling racks, shelves, or even coat your floor with epoxy. Every Garage Raid includes deep cleaning, organizing, and donation drop-off."
};

// ---------- long customer quote template ----------
function buildCustomerQuote(hours) {
  const subtotal = (139 * hours) + 49; // fuel fee
  const hLabel = `hour${hours > 1 ? 's' : ''}`;
  return (
`Hi,

Cristian here with Garage Raiders, thanks for the photos.

Here’s your custom estimate:
• ${hours} ${hLabel} — $${subtotal} + tax
\t($139/hr x ${hours} ${hLabel} + $49 fuel)
• You only pay for the time used, down to the minute.

Included:
• Full sort, categorization & organization
• Deep cleaning of the entire space
• Heavy-duty trash bags
• Free donation drop-off to any organization

Optional Add-On:
• Trash haul-away — $249 flat rate (up to 12 cubic yards)
\tNote: We cannot remove paint, chemicals, TVs, microwaves, or freon appliances.

Storage Upgrades:
Explore ceiling racks, shelving, and premium storage solutions:
https://www.garageraiders.com/category/all-products

Helpful Links:
• Strategy: https://www.garageraiders.com/strategy

• Reviews: https://www.garageraiders.com/reviews

• Pay Online or Book with Klarna/Affirm: https://www.garageraiders.com/Raid${hours}Hours

If you have any questions or you're ready to book, just text or call me directly.

Cristian
Garage Raiders`
  );
}

// ---------- simple intent detector ----------
function detectIntent(body, hasPhotos) {
  const text = (body || "").toLowerCase();
  if (hasPhotos) return "photos";
  if (/\b(estimate|quote|get started|how long|time|duration)\b/.test(text)) return "estimate";
  if (/\b(option|available|schedule|day|time|date|appointment|book|slot)\b/.test(text)) return "options";
  if (/\b(price|cost|how much|rate|charge|fee)\b/.test(text)) return "pricing";
  if (/\b(rack|shelf|epoxy|paint|organize|organization|clean|sorting|box|boxes|storage|donation|trash|junk)\b/.test(text)) return "faq";
  return null;
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

// Parse owner command like "6" or "6 +13465551234"
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
    const body = (p.Body || '').toString();
    const sid  = (p.MessageSid || '').toString();
    const numMedia = parseInt(p.NumMedia || '0', 10) || 0;

    if (!isValidTwilio(req, p)) return res.status(403).json({ ok: false, error: 'Invalid Twilio signature' });
    if (!from) return res.status(200).json({ ok: false, error: 'Missing From' });

    // ---------- OWNER CONTROL (quote via hours 2–8) ----------
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

      // Use your long template
      const quoteText = buildCustomerQuote(hours);

      const sentQuote = await twilioClient.messages.create({
        from: process.env.TWILIO_FROM_NUMBER, to: target.phone, body: quoteText
      });
      await supa.from('messages').insert({
        lead_id: target.id, direction:'outbound', body:quoteText, channel:'sms', twilio_message_id: sentQuote.sid
      });
      await supa.from('leads').update({ stage:'quote_sent' }).eq('id', target.id);
      try {
        // Optional: schedule a D+1 follow-up (if you have followups table/cron)
        await supa.from('followups').insert({
          lead_id: target.id,
          due_at: new Date(Date.now() + 24*60*60*1000).toISOString(),
          kind: 'quote_d1'
        });
      } catch(_) {}

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

    // Upsert lead
    const { data: lead } = await supa
      .from('leads')
      .upsert({ phone: from },{onConflict:'phone'})
      .select()
      .single();

    const leadId = lead.id;
    const existingStage = lead.stage || null;

    // Upload photos to private storage; collect Storage KEYS (paths)
    let mediaPaths = [];
    if (hasPhotos) {
      for (let i=0;i<mediaUrls.length;i++) {
        try {
          const { nodeBuf, contentType } = await fetchTwilioMedia(mediaUrls[i]);
          const ext = extFromContentType(contentType);
          const key = readableKey(from, i, ext);
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

    // 1) Log inbound (so UI sees it)
    await supa.from('messages').insert({
      lead_id: leadId,
      direction: 'inbound',
      body: body || (hasPhotos ? '[Photo(s) received]' : ''),
      channel: 'sms',
      twilio_message_id: sid || null,
      media_paths: mediaPaths.length ? mediaPaths : null
    });

    // 2) Owner alert on photos (tokenized gallery link)
    if (hasPhotos) {
      if (!isAtOrAfterQuote(existingStage) && existingStage!=='awaiting_owner_quote') {
        await supa.from('leads').update({ stage:'awaiting_owner_quote' }).eq('id', leadId);
      }

      if (process.env.OWNER_CELL && process.env.TWILIO_FROM_NUMBER) {
        let galleryUrlText = '';
        try {
          const crypto = await import('crypto');
          const token = crypto.randomBytes(16).toString('hex');
          const expiryDays = +(process.env.GALLERY_TOKEN_DAYS || 7);
          const expiresAt = new Date(Date.now() + expiryDays*24*60*60*1000).toISOString();

          await supa.from('gallery_tokens').insert({ lead_id: leadId, token, expires_at: expiresAt });

          const base = process.env.PUBLIC_BASE_URL || 'https://gr-ai-backend.vercel.app';
          const galleryUrl = `${base}/photos.html?token=${encodeURIComponent(token)}`;
          galleryUrlText = `\n${galleryUrl}\n(Expires in ${expiryDays} day${expiryDays>1?'s':''})`;
        } catch (e) {
          console.warn('gallery token create failed:', e?.message || e);
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

    // 3) Template guardrail after logging inbound
    const intent = detectIntent(body, hasPhotos);
    if (intent && TEMPLATES[intent]) {
      const replyText = TEMPLATES[intent];
      const sent = await twilioClient.messages.create({
        from: process.env.TWILIO_FROM_NUMBER,
        to: from,
        body: replyText
      });

      await supa.from('messages').insert({
        lead_id: leadId,
        direction:'outbound',
        body: replyText,
        channel:'sms',
        twilio_message_id: sent.sid,
        metadata: { source: "template", intent }
      });

      await supa.from('leads').update({
        last_intent: intent,
        stage: hasPhotos
          ? 'awaiting_owner_quote'
          : (existingStage === 'cold' ? 'qualifying' : existingStage)
      }).eq('id', leadId);

      return res.status(200).json({ ok:true, leadId, handledBy:"template", intent });
    }

    // 4) Fallback to OpenAI assistant
    let threadId = lead.thread_id;
    if (!threadId) {
      const created = await openai('/threads',{ method:'POST', body: JSON.stringify({}) });
      threadId = created.id;
      await supa.from('leads').update({ thread_id: threadId }).eq('id', leadId);
    }
    if (body || hasPhotos) {
      await openai(`/threads/${threadId}/messages`,{
        method:'POST',
        body: JSON.stringify({ role:'user', content: body || 'Sent photos of the garage.' })
      });
    }
    const run = await openai(`/threads/${threadId}/runs`,{
      method:'POST',
      body: JSON.stringify({
        assistant_id: process.env.OPENAI_ASSISTANT_ID,
        metadata: { phone: from, stage: hasPhotos ? 'awaiting_owner_quote' : (existingStage || 'qualifying') }
      })
    });

    // Quick poll
    let status = run; const deadline = Date.now() + 10000;
    while (['queued','in_progress','cancelling'].includes(status.status)) {
      if (Date.now() > deadline) break;
      await new Promise(r => setTimeout(r, 800));
      status = await openai(`/threads/${threadId}/runs/${run.id}`, { method:'GET' });
      if (status.status === 'requires_action' && status.required_action?.submit_tool_outputs) {
        const calls = status.required_action.submit_tool_outputs.tool_calls || [];
        const tool_outputs = calls.map(c => ({ tool_call_id: c.id, output: JSON.stringify({ ok:true }) }));
        await openai(`/threads/${threadId}/runs/${run.id}/submit_tool_outputs`, {
          method:'POST', body: JSON.stringify({ tool_outputs })
        });
      }
    }

    const list = await openai(`/threads/${threadId}/messages?order=desc&limit=1`, { method:'GET' });
    const last = list.data?.[0];
    let reply =
      last?.content?.[0]?.text?.value ||
      (hasPhotos
        ? 'Got your photos—thank you. The owner will review and text your estimate shortly.'
        : 'Hi—this is Garage Raiders. Two wide photos of your garage is the fastest way to get a precise estimate.');
    reply = reply.replace(/【\d+:\d+†.*?†.*?】/g,'').replace(/\[\d+\]/g,'').replace(/\(source.*?\)/gi,'');

    const sent = await twilioClient.messages.create({
      from: process.env.TWILIO_FROM_NUMBER, to: from, body: reply
    });
    await supa.from('messages').insert({
      lead_id: leadId, direction:'outbound', body: reply, channel:'sms', twilio_message_id: sent.sid
    });

    return res.status(200).json({ ok:true, leadId, threadId, runId: run.id });
  } catch(e) {
    console.error('Inbound error:', e);
    return res.status(200).json({ ok:false, error: String(e.message || e) });
  }
}
