// lib/brand.js
export const STAGES = ['cold','qualifying','awaiting_owner_quote','quote_sent','closed_won','closed_lost'];

// Hard cap + phrase guard to keep voice tight.
const FORBIDDEN = [
  /our team will be more than happy/gi,
  /kindly/gi,
  /at your earliest convenience/gi,
  /dear customer/gi,
  /we appreciate your interest/gi
];
const REPLACEMENTS = [
  [/we appreciate your interest/gi, 'thanks for reaching out'],
  [/kindly/gi, 'please']
];

export function lintCopy(s) {
  let out = (s || '').trim();

  // replacements
  for (const [pat, sub] of REPLACEMENTS) out = out.replace(pat, sub);

  // kill forbidden phrases
  for (const pat of FORBIDDEN) out = out.replace(pat, '');

  // normalize whitespace, cap length (SMS-friendly)
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > 600) out = out.slice(0, 597) + '…';
  return out;
}

// Minimal template engine: {{var}} replacement
function render(tpl, vars = {}) {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    return (v === undefined || v === null) ? '' : String(v);
  });
}

// Brand-approved templates by (stage, intent)
const TPL = {
  // GENERAL / TOP OF FUNNEL
  'cold:ask_photos': `Hi! Fastest way to get your Garage Raid estimate—please text a few photos of the garage.`,

  'qualifying:ask_photos': `Got it. A couple photos of your garage is the fastest way to get a precise time estimate.`,

  // WHEN PHOTOS ARRIVE
  'awaiting_owner_quote:ack_photos': `Got your photos—thank you. Our team will review them and text your time estimate shortly.`,

  // QUOTE SENT → NURTURE
  'quote_sent:nudge_hold_window': `Quick check-in—would you like to hold a morning or early afternoon arrival? If you want date options, just say “options”.`,

  // OPTIONS ASK
  'any:options_info': `We can hold a morning or early afternoon arrival. Do you have 2–3 days that work best? I can check openings.`,

  // PRICE QUESTIONS
  'any:price_explain': `We price by on-site hours for a two-person team. Photos help us quote precisely and avoid surprises. Two wide photos of the garage is perfect.`,

  // EPOXY
  'any:epoxy_qual': `Happy to quote epoxy. What’s the square footage? Two wide photos of the space help. Close-ups aren’t needed now—we’ll inspect if you like the estimate.`,

  // SMALLTALK / THANKS
  'any:thanks': `You’re welcome! If you want date options, just say “options”.`,

  // FALLBACK
  'any:fallback': `Noted. Two wide photos of your garage is the fastest way to get a precise time estimate.`
};

// Routing helper
export function pickTemplate(stage, intent) {
  const key1 = `${stage}:${intent}`;
  const key2 = `any:${intent}`;
  if (TPL[key1]) return TPL[key1];
  if (TPL[key2]) return TPL[key2];
  return TPL['any:fallback'];
}

export function compose(stage, intent, vars = {}) {
  const tpl = pickTemplate(stage, intent);
  const body = render(tpl, vars);
  return lintCopy(body);
}
