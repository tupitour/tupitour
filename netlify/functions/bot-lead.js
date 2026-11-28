// Receives a visitor summary from the Tupi Tour chat assistant (Botpress) and emails it to Flavio.
// Server to server only. Fixed recipient and sender, Resend key stays in Netlify env, never in the bot.
// Caps and dedupe live in public.email_sends (atomic insert on the primary key), not in function memory.
const crypto = require('crypto');

const TO = 'flavio@tupitour.com';
const FROM = 'Tupi Tour Assistant <noreply@tupitour.com>';
const KIND = 'botlead';
const DAILY_CAP = 20;
const MAX = { name: 80, email: 120, summary: 1500, lang: 20 };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

function testPedido(s) { let t = String(s).replace(/^\[TESTE\]\s*/i, '').trim(); if (!/Sem pre\u00e7os\.?$/i.test(t)) t = t.replace(/\.$/, '') + '. Sem pre\u00e7os.'; return t; }

function secretOk(given, expected) {
  if (!expected || expected.length < 24 || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function store(env, f) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1/bot_lead_sends';
  const key = env.SUPABASE_SERVICE_KEY;
  const H = (x) => Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, x || {});
  const call = async (url, init) => { const r = await f(url, Object.assign({ signal: AbortSignal.timeout(5000) }, init)); if (!r.ok) throw new Error('store_http_' + r.status); return r.json(); };
  const q = (o) => Object.keys(o).map((k) => k + '=eq.' + encodeURIComponent(o[k])).join('&');
  return {
    async insert(row) { const o = await call(base + '?on_conflict=session_id,kind', { method: 'POST', headers: H({ Prefer: 'resolution=ignore-duplicates,return=representation' }), body: JSON.stringify(row) }); return Array.isArray(o) && o.length === 1; },
    async get(sid) { const o = await call(base + '?select=*&' + q({ session_id: sid, kind: KIND }), { method: 'GET', headers: H() }); return Array.isArray(o) && o[0] ? o[0] : null; },
    async cas(sid, where, set) { const o = await call(base + '?' + q(Object.assign({ session_id: sid, kind: KIND }, where)), { method: 'PATCH', headers: H({ Prefer: 'return=representation' }), body: JSON.stringify(set) }); return Array.isArray(o) && o.length === 1; },
  };
}

// Claim one row; true only for the caller that owns it. A row left 'failed' (nothing was sent) can be reclaimed.
async function claim(st, sid, now) {
  const t = new Date(now).toISOString();
  if (await st.insert({ session_id: sid, kind: KIND, status: 'claimed', first_claim: t, claimed_at: t, attempts: 1 })) return true;
  const row = await st.get(sid);
  if (row && row.status === 'failed') return st.cas(sid, { status: 'failed', attempts: row.attempts }, { status: 'claimed', claimed_at: t, attempts: row.attempts + 1 });
  return false;
}

async function handle(event, env, f, now) {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method' });
  const hdr = event.headers || {};
  const given = hdr['x-tupi-bot-secret'] || hdr['X-Tupi-Bot-Secret'];
  if (!secretOk(given, env.BOT_LEAD_SECRET)) return json(401, { ok: false, error: 'unauthorized' });
  if (!env.RESEND_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return json(503, { ok: false, error: 'not_configured' });
  if (String(event.body || '').length > 8000) return json(413, { ok: false, error: 'too_large' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'bad_json' }); }
  if (b.consent !== true && b.consent !== 'true') return json(400, { ok: false, error: 'consent_required' });
  const name = clean(b.name, MAX.name), email = clean(b.email, MAX.email).toLowerCase(), summary = clean(b.summary, MAX.summary), lang = clean(b.language, MAX.lang);
  if (name.length < 2 || summary.length < 20 || !/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/.test(email)) return json(400, { ok: false, error: 'invalid_fields' });

  const st = store(env, f);
  const day = new Date(now).toISOString().slice(0, 10);
  const who = crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);
  const dupSid = 'lead-em-' + who + '-' + day;
  const claimed = [];
  try {
    if (!(await claim(st, dupSid, now))) return json(429, { ok: false, error: 'duplicate_today' });
    claimed.push(dupSid);
    let slot = null;
    for (let i = 1; i <= DAILY_CAP; i++) { const sid = 'lead-day-' + day + '-' + i; if (await claim(st, sid, now)) { slot = sid; claimed.push(sid); break; } }
    if (!slot) { await release(st, claimed, 'cap'); return json(429, { ok: false, error: 'daily_cap' }); }
  } catch (e) { console.log('bot-lead store error: ' + String(e && e.message).slice(0, 60)); await release(st, claimed, 'store_error'); return json(503, { ok: false, error: 'store_error' }); }

  const test = /^\[TESTE\]/i.test(summary) && /@example\.com$/.test(email);
  const html = test
    ? '<div style="font:15px Arial,sans-serif"><p>Este \u00e9 um teste do assistente do site, n\u00e3o \u00e9 um cliente real.</p><p>Nome: ' + esc(name) + '<br>E-mail fict\u00edcio: ' + esc(email) + '<br>Idioma: ' + esc(/^(pt|portugu[e\u00ea]s)$/i.test(lang) ? 'portugu\u00eas' : (lang || '?')) + '<br>Pedido fict\u00edcio: ' + esc(testPedido(summary)) + '</p><p>N\u00e3o precisa responder a esse e-mail.</p></div>'
    : '<div style="font:15px Arial,sans-serif"><p>Novo contato pelo assistente do site.</p><p><b>Nome:</b> ' + esc(name) + '<br><b>E-mail:</b> ' + esc(email) + '<br><b>Idioma:</b> ' + esc(lang || '?') + '</p><p><b>Resumo:</b><br>' + esc(summary).replace(/\n/g, '<br>') + '</p><p style="color:#777">O visitante concordou em enviar estes dados a voc\u00ea. Responda a ele pelo e-mail acima (reply-to).</p></div>';
  const payload = { from: FROM, to: [TO], subject: (test ? '[TESTE] ' : '') + 'Novo contato do assistente Tupi Tour', html };
  if (!test) payload.reply_to = email;
  let ok = false, ambiguous = false;
  try {
    const r = await f('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(8000), headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': dupSid }, body: JSON.stringify(payload) });
    ok = r.ok;
  } catch (e) { ambiguous = true; }   // timeout or network drop: the provider may have sent it
  if (ambiguous) {
    // Keep the rows claimed (nothing is released), so no retry can send a duplicate. Needs a human look.
    for (const sid of claimed) { try { await st.cas(sid, { status: 'claimed' }, { status: 'review', note: 'unknown outcome' }); } catch (e) { /* stays claimed */ } }
    return json(502, { ok: false, error: 'unknown_outcome' });
  }
  if (!ok) { await release(st, claimed, 'send_failed'); return json(502, { ok: false, error: 'send_failed' }); }
  for (const sid of claimed) { try { await st.cas(sid, { status: 'claimed' }, { status: 'sent' }); } catch (e) { /* row stays claimed: still counts, no duplicate */ } }
  return json(200, { ok: true });
}

// Nothing was sent: give the attempts back so failures never consume the cap or block a retry.
async function release(st, sids, why) {
  for (const sid of sids) { try { await st.cas(sid, { status: 'claimed' }, { status: 'failed', note: why }); } catch (e) { /* best effort */ } }
}

exports.handler = async (event) => handle(event, process.env, fetch, Date.now());
exports._handle = handle;
