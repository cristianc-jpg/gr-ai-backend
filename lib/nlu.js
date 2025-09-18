// lib/nlu.js
const OA_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  'Content-Type': 'application/json',
  'OpenAI-Beta': 'assistants=v2'
};

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

// Returns { intent, slots } with a small, closed set of intents.
export async function classifyMessage({ text, stage }) {
  const sys = `
You are a classifier. Output STRICT JSON with keys "intent" and "slots".
Allowed intents:
- ask_photos
- ack_photos
- options
- price_question
- epoxy
- thanks
- smalltalk
- unsubscribe
- unknown

Rules:
- If message includes new photos, prefer "ack_photos".
- If user asks for scheduling options, intent="options".
- If asking about price/cost, intent="price_question".
- If epoxy mentioned, intent="epoxy".
- If says thanks, intent="thanks".
- If "stop", "unsubscribe", "remove me", intent="unsubscribe".
- Else "unknown".
No commentary. JSON only.`;

  const user = `Stage: ${stage || 'unknown'}\nMessage: ${text || ''}`;

  // Use Responses API style with JSON bias; or a minimal Assistant run.
  // We'll use Responses Completions style for brevity:
  const completion = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { ...OA_HEADERS },
    body: JSON.stringify({
      model: process.env.OPENAI_CLASSIFIER_MODEL || 'gpt-4o-mini',
      input: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      // Nudge to JSON
      response_format: { type: 'json_object' },
    })
  }).then(r => r.json());

  let parsed = { intent: 'unknown', slots: {} };
  try {
    const raw = completion.output_text || completion.choices?.[0]?.message?.content || '';
    parsed = JSON.parse(raw);
  } catch (_) { /* ignore */ }

  if (!parsed || typeof parsed.intent !== 'string') {
    parsed = { intent: 'unknown', slots: {} };
  }
  return parsed;
}
