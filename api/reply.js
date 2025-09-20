// api/reply.js
import { createClient } from '@supabase/supabase-js';
import Twilio from 'twilio';

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Normalize to E.164 (+1XXXXXXXXXX). Adjust if you serve other countries.
function normE164(s) {
  const digits = String(s || '').replace(/\D/g, '');
  if (!digits) return '';
  const d10 = digits.length === 11 && digits.startsWith('1') ? digits
           : digits.length === 10 ? '1' + digits
           : digits;
  return `+${d10}`;
}

// Simple detector for “quote-like” messages (2–8 hours)
function detectQuotedHours(text) {
  const t = (text || '').toLowerCase();
  const m = t.match(/\b([2-8])\s*(?:-|to\s*)?[2-8]?\s*(?:h|hr|hrs|hour|hours)?\b/);
  if (m && m[1]) return parseInt(m[1], 10);
  return null;
}

// Long customer quote template
function buildCustomerQuote(hours) {
  const subtotal = (139 * hours) + 49;
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const toRaw = (req.body?.to || '').toString();
    let body = (req.body?.body || '').toString();
    const to = normE164(toRaw);

    if (!to || !body) {
      return res.status(400).json({ ok: false, error: 'Missing "to" or "body"' });
    }

    // Upsert lead by phone
    const { data: leadRow, error: upsertErr } = await supa
      .from('leads')
      .upsert({ phone: to }, { onConflict: 'phone' })
      .select()
      .single();
    if (upsertErr) throw upsertErr;

    // If message is ONLY an hour hint, auto-expand to full template
    const hoursQuoted = detectQuotedHours(body);
    const bareHoursPattern = /^\s*[~≈]?\s*[2-8]\s*(h|hr|hrs|hour|hours)?\s*$/i;
    if (hoursQuoted && bareHoursPattern.test(body)) {
      body = buildCustomerQuote(hoursQuoted);
    }

    // Send SMS via Twilio
    const msg = await client.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to,
      body
    });

    // Store outbound message
    const { error: msgErr } = await supa.from('messages').insert({
      lead_id: leadRow.id,
      direction: 'outbound',
      body,
      channel: 'sms',
      twilio_message_id: msg.sid
    });
    if (msgErr) throw msgErr;

    // Stage updates
    const updates = {};
    if (!leadRow.stage || leadRow.stage === 'cold') {
      updates.stage = 'qualifying';
    }
    if (hoursQuoted && hoursQuoted >= 2 && hoursQuoted <= 8) {
      updates.stage = 'quote_sent';
      try {
        const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await supa.from('followups').insert({
          lead_id: leadRow.id,
          due_at: dueAt,
          kind: 'quote_d1'
        });
      } catch (e) {
        console.warn('followup schedule skipped:', e?.message || e);
      }
    }
    if (Object.keys(updates).length > 0) {
      await supa.from('leads').update(updates).eq('id', leadRow.id);
    }

    return res.status(200).json({ ok: true, sid: msg.sid, quoted_hours: hoursQuoted || null });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
