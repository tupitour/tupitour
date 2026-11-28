// netlify/functions/stripe-webhook.js
// Stripe webhook — processa checkout.session.completed
// Envia recibo HTML ao cliente (via Resend) + notificação ao Flávio

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);


const ADMIN_EMAIL = 'flavio@tupitour.com';
const FROM_EMAIL  = 'noreply@tupitour.com'; // domínio verificado no Resend

// ── HTML do recibo enviado ao cliente ──────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Items saved by create-checkout.js at checkout time (item_1 .. item_N).
function readItems(session) {
  const md = session.metadata || {};
  const n = parseInt(md.item_count, 10);
  if (!n) return [];
  const items = [];
  for (let i = 1; i <= n; i++) {
    try { items.push(JSON.parse(md['item_' + i])); } catch (e) { return []; }
  }
  return items;
}


// Receipt language: the site language saved by create-checkout.js in the session metadata (lang). Anything but "es" is English.
// Spanish texts are a draft for the owner's review.
const TX = {
  es: {
    'Booking Confirmed': 'Reserva confirmada',
    'Hi': 'Hola',
    'intro': 'Tu reserva est\u00e1 confirmada. Tupi Tour se pondr\u00e1 en contacto contigo en un plazo de 24 horas para ultimar los detalles y resolver cualquier duda. Estamos deseando mostrarte Brasil.',
    'Booking Summary': 'Resumen de la reserva',
    'Date': 'Fecha', 'To be confirmed': 'Por confirmar', 'Time': 'Hora', 'Group size': 'Tama\u00f1o del grupo',
    'Partner guide': 'Gu\u00eda asociado',
    'partner': function(d) { return 'Tupi Tour podr\u00e1 asignar un gu\u00eda asociado para ' + d + '. Te confirmaremos qui\u00e9n dirigir\u00e1 tu tour.'; },
    'Tour price': 'Precio del tour',
    'Full-payment discount (10%)': 'Descuento por pago completo (10%)',
    'Paid in full': 'Pagado completo', 'Amount paid': 'Importe pagado', 'Deposit paid': 'Anticipo pagado',
    'Remaining, due on the day of the tour': 'Pendiente, a pagar el d\u00eda del tour',
    'Amount': 'Importe', 'Order total': 'Total del pedido', 'Paid': 'Pagado', 'Status': 'Estado',
    'Reference': 'Referencia', 'What happens next': 'Pr\u00f3ximos pasos',
    'next1': 'Tupi Tour te escribir\u00e1 en un plazo de <strong>24 horas</strong> para confirmar todos los detalles.',
    'next2': 'Tambi\u00e9n puedes escribirnos directamente por',
    'next3': 'Conserva este correo como comprobante.',
    'Questions?': '\u00bfPreguntas? Responde a este correo o escr\u00edbenos por'
  }
};
function tr(lang, k, a) {
  const d = TX[lang];
  const v = d && d[k];
  if (v === undefined) return null;
  return typeof v === 'function' ? v(a) : v;
}
function langOf(session) { return session && session.metadata && session.metadata.lang === 'es' ? 'es' : 'en'; }

// One block per tour: what was chosen, what Stripe charged for that line.
// The balance amount is not shown: the site states it is due on the day and
// the order does not store a balance figure.
function usd(n) { return 'USD ' + (Number(n) || 0).toFixed(2); }

// Order figures in USD from the stored items: total = tour price for deposits, discounted price for full payments.
function orderFigures(items) {
  let total = 0, paid = 0;
  items.forEach(function(it) {
    const u = Number(it.u) || 0, lp = Number(it.lp) || 0;
    paid += u;
    total += it.p === 'deposit' && lp ? lp : u;
  });
  return { total: total, paid: paid, remaining: Math.max(0, total - paid) };
}

function totalsRows(items, session, extra, lang) {
  const T = function(k) { return tr(lang, k) || k; };
  const f = orderFigures(items);
  const row = function(l, v, strong) { return '<tr style="border-top:1px solid #E5E3DE;"><td style="padding:12px 16px;font-size:13px;color:#555555;">' + l + '</td><td style="padding:12px 16px;font-size:' + (strong ? '15px;font-weight:700;color:#1B7A3E' : '14px;color:#111111') + ';">' + v + '</td></tr>'; };
  return row(T('Order total'), usd(f.total)) + row(T('Paid'), usd(f.paid)) + (f.remaining > 0 ? row(T('Remaining, due on the day of the tour'), usd(f.remaining), true) : row(T('Status'), T('Paid in full'), true)) + (extra || '');
}

function buildItemRows(items, lines, currency, lang, internal) {
  const T = function(k) { return tr(lang, k) || k; };
  return items.map(function(it, idx) {
    const line = lines && lines[idx];
    const charged = line && typeof line.amount_total === 'number'
      ? currency + ' ' + (line.amount_total / 100).toFixed(2)
      : 'not available';
    const status = '';
    const rows = [
      [T('Date'), it.d || T('To be confirmed')],
      it.pd && it.pd.length ? [T('Partner guide'), lang === 'es' ? tr(lang, 'partner', esc(it.pd.join(', '))) : 'Tupi Tour may assign a partner guide for ' + esc(it.pd.join(', ')) + '. We will confirm who will lead your tour.'] : null,
      it.t ? [T('Time'), it.t] : null,
      it.g ? [T('Group size'), it.g] : null,
      internal ? ['Travelers under 21', (it.a21 === null || it.a21 === undefined) ? 'not provided' : String(it.a21)] : null,
      internal ? ['Travelers over 60', (it.a60 === null || it.a60 === undefined) ? 'not provided' : String(it.a60)] : null,
      it.lp ? [T('Tour price'), usd(it.lp)] : null,
      it.p === 'full' && it.lp && Number(it.lp) > Number(it.u) ? [T('Full-payment discount (10%)'), '\u2212' + usd(Number(it.lp) - Number(it.u))] : null,
      it.p === 'full' ? [it.lp ? T('Paid in full') : T('Amount paid'), usd(it.u)] : null,
      it.p === 'deposit' ? [T('Deposit paid'), usd(it.u)] : null,
      it.p === 'deposit' && it.lp ? [T('Remaining, due on the day of the tour'), usd(Number(it.lp) - Number(it.u))] : null,
      it.p !== 'full' && it.p !== 'deposit' ? [T('Amount'), usd(it.u)] : null,
      status ? ['Status', status] : null
    ].filter(Boolean);
    return '<tr style="border-top:1px solid #E5E3DE;background:#F8F7F4;"><td colspan="2" style="padding:12px 16px;font-size:14px;color:#111111;font-weight:600;">' + esc(it.n) + '</td></tr>' +
      rows.map(function(r) {
        return '<tr style="border-top:1px solid #E5E3DE;"><td style="padding:8px 16px;font-size:13px;color:#555555;width:40%;">' + r[0] + '</td><td style="padding:8px 16px;font-size:13px;color:#111111;">' + r[1] + '</td></tr>';
      }).join('');
  }).join('');
}

function buildClientReceiptHtml(session, lines) {
  const items = readItems(session);
  const name     = session.customer_details?.name   || 'Valued Guest';
  const email    = session.customer_details?.email  || '';
  // With Adaptive Pricing the session keeps the settlement currency; presentment_details holds
  // what the customer was shown and charged at checkout (Stripe API 2025-03-31 and later).
  const pres     = session.presentment_details && typeof session.presentment_details.presentment_amount === 'number' ? session.presentment_details : null;
  const amount   = (((pres ? pres.presentment_amount : session.amount_total) || 0) / 100).toFixed(2);
  const currency = (pres ? pres.presentment_currency : (session.currency || 'usd')).toUpperCase();
  const tourName = session.metadata?.tour_name || session.metadata?.tours || 'Tupi Tour Experience';
  const tourDate = session.metadata?.tour_date  || session.metadata?.dates || 'To be confirmed';
  const payTypes = String(session.metadata?.payment_type || '').split(',').map(function(t) { return t.trim(); }).filter(Boolean);
  const payType  = !payTypes.length
    ? 'Not specified'
    : (payTypes.every(function(t) { return t === 'deposit'; })
      ? 'Deposit (balance due on the day)'
      : (payTypes.every(function(t) { return t === 'full'; })
        ? 'Full payment'
        : 'Deposit for some tours, full payment for others'));
  const groupSize = String(session.metadata?.group_size || 'Not specified');
  const sessionId = session.id;
  const lang = langOf(session);
  const T = function(k) { return tr(lang, k) || k; };

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${T('Booking Confirmed')} — Tupi Tour</title>
</head>
<body style="margin:0;padding:0;background:#F8F7F4;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8F7F4;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0"
               style="max-width:600px;background:#FFFFFF;border-radius:4px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.07);">

          <!-- Header bar -->
          <tr>
            <td height="4"
                style="background:linear-gradient(90deg,#1B7A3E 0%,#1B7A3E 40%,#F5C518 40%,#F5C518 70%,#1B2F6E 70%,#1B2F6E 100%);"></td>
          </tr>

          <!-- Logo / brand -->
          <tr>
            <td align="center" style="padding:32px 24px 20px;">
              <img src="https://www.tupitour.com/imgs/logo.png"
                   alt="Tupi Tour" width="140"
                   style="display:block;height:auto;border:0;">
            </td>
          </tr>

          <!-- Status badge -->
          <tr>
            <td align="center" style="padding:0 24px 24px;">
              <span style="display:inline-block;background:#1B7A3E;color:#FFFFFF;font-size:13px;font-weight:600;
                           letter-spacing:0.06em;text-transform:uppercase;padding:6px 20px;border-radius:2px;">
                ✓ ${T('Booking Confirmed')}
              </span>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:0 24px 24px;">
              <p style="font-size:15px;color:#333333;margin:0;">
                ${T('Hi')} <strong>${name}</strong>,
              </p>
              <p style="font-size:15px;color:#555555;margin:12px 0 0;line-height:1.6;">
                ${tr(lang, 'intro') || "Your booking is confirmed. Tupi Tour will be in touch within 24 hours to finalise details and answer any questions you may have. We can't wait to show you Brazil."}
              </p>
            </td>
          </tr>

          <!-- Booking summary table -->
          <tr>
            <td style="padding:0 24px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0"
                     style="border:1px solid #E5E3DE;border-radius:2px;overflow:hidden;">
                <tr style="background:#F8F7F4;">
                  <td colspan="2"
                      style="padding:12px 16px;font-size:11px;font-weight:600;letter-spacing:0.08em;
                             text-transform:uppercase;color:#AAAAAA;">
                    ${T('Booking Summary')}
                  </td>
                </tr>
                ${items.length ? buildItemRows(items, lines, currency, lang) : `                <tr style="border-top:1px solid #E5E3DE;">
                  <td style="padding:12px 16px;font-size:13px;color:#555555;width:40%;">Tour / Experience</td>
                  <td style="padding:12px 16px;font-size:13px;color:#111111;font-weight:500;">${tourName}</td>
                </tr>
                <tr style="border-top:1px solid #E5E3DE;background:#FAFAF8;">
                  <td style="padding:12px 16px;font-size:13px;color:#555555;">Date</td>
                  <td style="padding:12px 16px;font-size:13px;color:#111111;">${tourDate}</td>
                </tr>
                <tr style="border-top:1px solid #E5E3DE;">
                  <td style="padding:12px 16px;font-size:13px;color:#555555;">Group size</td>
                  <td style="padding:12px 16px;font-size:13px;color:#111111;">${groupSize}</td>
                </tr>
                <tr style="border-top:1px solid #E5E3DE;">
                  <td style="padding:12px 16px;font-size:13px;color:#555555;">Payment type</td>
                  <td style="padding:12px 16px;font-size:13px;color:#111111;">${payType}</td>
                </tr>
`}
${items.length && String(session.currency).toLowerCase() === 'usd' ? totalsRows(items, session, '', lang) : `                <tr style="border-top:1px solid #E5E3DE;background:#FAFAF8;">
                  <td style="padding:12px 16px;font-size:13px;color:#555555;">${items.length ? 'Total paid' : 'Amount paid'}</td>
                  <td style="padding:12px 16px;font-size:15px;font-weight:700;color:#1B7A3E;">
                    ${currency} ${amount}
                    ${items.length ? '<div style="font-size:11px;font-weight:400;color:#777777;margin-top:4px;">Cart price: USD ' + items.reduce(function(s, x) { return s + (Number(x.u) || 0); }, 0) + (pres ? '. Total includes the currency conversion applied by Stripe at checkout.' : '') + '</div>' : ''}
                  </td>
                </tr>
`}
                <tr style="border-top:1px solid #E5E3DE;">
                  <td style="padding:12px 16px;font-size:11px;color:#AAAAAA;">${T('Reference')}</td>
                  <td style="padding:12px 16px;font-size:11px;color:#AAAAAA;word-break:break-all;">${sessionId}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Next steps -->
          <tr>
            <td style="padding:0 24px 32px;">
              <p style="font-size:13px;font-weight:600;color:#111111;margin:0 0 8px;
                        letter-spacing:0.05em;text-transform:uppercase;">${T('What happens next')}</p>
              <ul style="margin:0;padding-left:20px;color:#555555;font-size:14px;line-height:1.8;">
                <li>${tr(lang, 'next1') || 'Tupi Tour will email you within <strong>24 hours</strong> to confirm all details.'}</li>
                <li>${tr(lang, 'next2') || 'You can also reach us directly on'}
                    <a href="https://wa.me/5521988042225" style="color:#1B7A3E;text-decoration:none;">WhatsApp</a>.
                </li>
                <li>${tr(lang, 'next3') || 'Please keep this email as your receipt.'}</li>
              </ul>
              ${lang === 'en' ? `<p style="margin:16px 0 0;color:#555555;font-size:13px;line-height:1.6;"><strong>Right of withdrawal.</strong> Under article 49 of the Brazilian Consumer Defense Code (Law No. 8,078/1990), you may withdraw from this contract within 7 days from signing it or from receiving the service. To exercise this right, reply to this email or message us on WhatsApp. Our Terms of Use are at the bottom of <a href="https://tupitour.com/" style="color:#1B7A3E;text-decoration:none;">https://tupitour.com/</a></p>` : ''}
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:0 24px;">
              <hr style="border:none;border-top:1px solid #E5E3DE;margin:0;">
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding:24px 24px 32px;">
              <p style="font-size:12px;color:#AAAAAA;margin:0;">
                Tupi Tour · Rio de Janeiro, Brazil ·
                <a href="https://www.tupitour.com" style="color:#AAAAAA;">tupitour.com</a>
              </p>
              <p style="font-size:12px;color:#AAAAAA;margin:6px 0 0;">
                ${tr(lang, 'Questions?') || 'Questions? Reply to this email or message us on'}
                <a href="https://wa.me/5521988042225" style="color:#AAAAAA;">WhatsApp</a>.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Email de notificação para o Flávio ─────────────────────────────────────
function buildAdminNotificationHtml(session, lines, bt) {
  const items = readItems(session);
  const pres = session.presentment_details && typeof session.presentment_details.presentment_amount === 'number' ? session.presentment_details : null;
  const clientName  = session.customer_details?.name  || 'Unknown';
  const clientEmail = session.customer_details?.email || 'Unknown';
  const amount      = ((session.amount_total || 0) / 100).toFixed(2);
  const currency    = (session.currency || 'usd').toUpperCase();
  const tourName    = session.metadata?.tour_name    || session.metadata?.tours || 'N/A';
  const tourDate    = session.metadata?.tour_date    || session.metadata?.dates || 'N/A';
  const groupSize   = session.metadata?.group_size   || 'N/A';
  const payType     = session.metadata?.payment_type || 'N/A';
  const sessionId   = session.id;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>New Booking — Tupi Tour</title></head>
<body style="font-family:Arial,sans-serif;padding:24px;background:#f4f4f4;">
  <div style="max-width:540px;background:#fff;padding:24px;border-radius:4px;border-left:4px solid #1B7A3E;">
    <h2 style="color:#1B7A3E;margin:0 0 16px;">🎉 New Booking Received</h2>
    <table cellpadding="6" cellspacing="0" style="width:100%;font-size:14px;color:#333;">
      <tr><td style="color:#888;width:35%;">Client</td><td><strong>${clientName}</strong></td></tr>
      <tr><td style="color:#888;">Email</td><td><a href="mailto:${clientEmail}">${clientEmail}</a></td></tr>
${items.length ? `      <tr><td colspan="2" style="padding:0;"><table cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #E5E3DE;">${buildItemRows(items, lines, currency, undefined, true)}</table></td></tr>
${String(session.currency).toLowerCase() === 'usd' ? '<tr><td colspan="2" style="padding:0;"><table cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #E5E3DE;">' + totalsRows(items, session, bt && typeof bt.amount === 'number' ? '<tr style="border-top:1px solid #E5E3DE;"><td style="padding:12px 16px;font-size:13px;color:#555555;">Settled in BRL</td><td style="padding:12px 16px;font-size:14px;color:#111111;">R$ ' + (bt.amount / 100).toFixed(2) + (bt.exchange_rate ? '<div style="font-size:11px;color:#777777;">USD 1 = R$ ' + Number(bt.exchange_rate).toFixed(4) + ' on the day of payment, before Stripe fees</div>' : '') + '</td></tr>' : '<tr style="border-top:1px solid #E5E3DE;"><td style="padding:12px 16px;font-size:13px;color:#555555;">Settled in BRL</td><td style="padding:12px 16px;font-size:13px;color:#777777;">Not available yet</td></tr>') + '</table></td></tr>' : `      <tr><td style="color:#888;">Total paid</td><td><strong style="color:#1B7A3E;">${pres ? pres.presentment_currency.toUpperCase() + ' ' + (pres.presentment_amount / 100).toFixed(2) : currency + ' ' + amount}</strong>${pres ? '<div style="font-size:11px;color:#777;">Settled by Stripe: ' + currency + ' ' + amount + '. Cart price: USD ' + items.reduce(function(t, x) { return t + (Number(x.u) || 0); }, 0) + '.</div>' : ''}</td></tr>
`}
` : `      <tr><td style="color:#888;">Tour</td><td>${tourName}</td></tr>
      <tr><td style="color:#888;">Date</td><td>${tourDate}</td></tr>
      <tr><td style="color:#888;">Group size</td><td>${groupSize}</td></tr>
      <tr><td style="color:#888;">Payment</td><td>${payType}</td></tr>
      <tr><td style="color:#888;">Amount</td><td><strong style="color:#1B7A3E;">${currency} ${amount}</strong></td></tr>
`}      <tr><td style="color:#888;font-size:11px;">Stripe session</td><td style="font-size:11px;word-break:break-all;">${sessionId}</td></tr>
    </table>
    <p style="margin-top:16px;font-size:13px;color:#555;">
      Reply directly to this email to contact the client.
    </p>
  </div>
</body>
</html>`;
}

// ── Handler principal ──────────────────────────────────────────────────────
// Durable once-per-(session,kind) send guard. Store = atomic row ops (Supabase REST in production).
// Guarantee: never sends a second time after a confirmed send; never sends without a stored claim.
// NOT exactly-once: see LIMITS in the report.
const LEASE_MS = 2 * 60 * 1000;          // an attempt older than this is presumed dead
const IDEM_MS  = 23 * 60 * 60 * 1000;    // stay 1 h inside Resend's 24 h idempotency window

// store.insert(row)            -> true if inserted, false if the key exists (atomic, unique key)
// store.get(sid, kind)         -> row | null
// store.cas(sid, kind, where, set) -> true if exactly one row matched `where` and was updated
async function sendOnce(store, kind, sid, transport, now = Date.now()) {
  let claimedHere = false;
  const t = new Date(now).toISOString();
  try {
    if (await store.insert({ session_id: sid, kind, status: 'claimed', first_claim: t, claimed_at: t, attempts: 1 })) {
      claimedHere = true;
    } else {
      const row = await store.get(sid, kind);
      if (!row) return { action: 'retry', why: 'row_vanished' };
      if (row.status === 'sent') return { action: 'skip', why: 'already_sent' };
      if (row.status === 'review') return { action: 'skip', why: 'needs_review' };
      const age = now - Date.parse(row.first_claim);
      const lease = now - Date.parse(row.claimed_at);
      if (row.status === 'failed') {
        // definite earlier failure: nothing was sent. Safe to retry; also safe after 24 h.
        claimedHere = await store.cas(sid, kind, { status: 'failed', attempts: row.attempts },
          { status: 'claimed', claimed_at: t, attempts: row.attempts + 1 });
        if (!claimedHere) return { action: 'retry', why: 'lost_reclaim_race' };
      } else { // claimed: another worker is running, or died, or its outcome is unknown
        if (lease < LEASE_MS) return { action: 'retry', why: 'in_flight' };
        if (age >= IDEM_MS) {
          // outcome unknown and Resend can no longer dedupe: refuse to risk a duplicate.
          await store.cas(sid, kind, { status: 'claimed', claimed_at: row.claimed_at }, { status: 'review', note: 'unknown outcome after 24h' });
          return { action: 'skip', why: 'unknown_outcome_after_24h' };
        }
        // unknown outcome, still inside the window: same Idempotency-Key makes the resend safe
        claimedHere = await store.cas(sid, kind, { status: 'claimed', claimed_at: row.claimed_at },
          { claimed_at: t, attempts: row.attempts + 1 });
        if (!claimedHere) return { action: 'retry', why: 'lost_reclaim_race' };
      }
    }
  } catch (e) { return { action: 'retry', why: 'store_error_nothing_sent:' + String(e && e.message || e).slice(0, 80) }; }   // fail closed

  let res;
  try { res = await transport.send(kind + '/' + sid); } catch (e) { res = { unknown: true }; }
  if (res.unknown) return { action: 'retry', why: 'send_outcome_unknown' };       // row stays claimed
  try {
    if (res.ok) await store.cas(sid, kind, { status: 'claimed' }, { status: 'sent', resend_id: res.id });
    else await store.cas(sid, kind, { status: 'claimed' }, { status: 'failed', note: res.why });
  } catch (e) { return { action: res.ok ? 'sent_unmarked' : 'retry', why: 'mark_failed', id: res.id }; }
  return res.ok ? { action: 'sent', id: res.id } : { action: 'retry', why: res.why };
}

// Supabase REST adapter (PostgREST). Atomicity comes from the table primary key (insert) and from
// filtered PATCH (compare-and-set): the filter and the update are one SQL statement.
function supabaseStore(env, fetchImpl) {
  const f = fetchImpl || fetch;
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1/email_sends';
  const key = env.SUPABASE_SERVICE_KEY;
  if (!env.SUPABASE_URL || !key) { return { async insert() { throw new Error('store_not_configured'); }, async get() { throw new Error('store_not_configured'); }, async cas() { throw new Error('store_not_configured'); } }; }
  const H = (extra) => Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, extra || {});
  async function call(url, init) {
    const res = await f(url, Object.assign({ signal: AbortSignal.timeout(5000) }, init));
    if (!res.ok) throw new Error('store_http_' + res.status);
    return res.json();
  }
  const q = (o) => Object.keys(o).map((k) => k + '=eq.' + encodeURIComponent(o[k])).join('&');
  return {
    async insert(row) {
      const out = await call(base + '?on_conflict=session_id,kind', { method: 'POST', headers: H({ Prefer: 'resolution=ignore-duplicates,return=representation' }), body: JSON.stringify(row) });
      return Array.isArray(out) && out.length === 1;
    },
    async get(sid, kind) {
      const out = await call(base + '?select=*&' + q({ session_id: sid, kind }), { method: 'GET', headers: H() });
      return Array.isArray(out) && out[0] ? out[0] : null;
    },
    async cas(sid, kind, where, set) {
      const out = await call(base + '?' + q(Object.assign({ session_id: sid, kind }, where)), { method: 'PATCH', headers: H({ Prefer: 'return=representation' }), body: JSON.stringify(set) });
      return Array.isArray(out) && out.length === 1;
    },
  };
}

function withHoldWarning(html, hold) {
  if (!hold || !hold.failed.length) return html;
  const warn = '<div style="background:#fff3cd;border:1px solid #e0a800;padding:10px 14px;margin:0 0 12px;font:14px Arial,sans-serif;color:#5c4400"><strong>Date block NOT recorded</strong> for ' + esc(hold.failed.join(', ')) + '. Automatic retry is pending; if it is not resolved, check blocked_dates and add the date by hand.</div>';
  return /<body[^>]*>/i.test(html) ? html.replace(/(<body[^>]*>)/i, '$1' + warn) : warn + html;
}

// Date hold, written only after a confirmed payment. One row per booked day in public.blocked_dates
// (UNIQUE(date)): an already blocked day is not an error and never stops the sale (it stays informational,
// as the partner-guide notice). Idempotent, so a Stripe retry can repeat it safely.
// Result: { done: [dates newly blocked], already: [dates that were already blocked], failed: [dates not recorded] }.
async function writeHolds(items, session, clientName, env, fetchImpl) {
  const f = fetchImpl || fetch;
  const out = { done: [], already: [], failed: [] };
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1/blocked_dates?on_conflict=date';
  const key = env.SUPABASE_SERVICE_KEY;
  const seen = {};
  for (const it of (items || [])) {
    const raw = it && typeof it.d === 'string' ? it.d : '';
    if (!raw || raw === 'Flexible dates (TBC)') continue;
    for (const part of raw.split(',')) {
      const d = part.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || seen[d]) continue;
      seen[d] = true;
      try {
        if (!env.SUPABASE_URL || !key) throw new Error('store_not_configured');
        const res = await f(base, {
          method: 'POST',
          headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
          body: JSON.stringify({ date: d, note: String(it.n || 'Tour') + ' \u2014 ' + clientName + ' \u2014 ' + session.id, source: 'stripe' }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error('hold_http_' + res.status);
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length >= 1) out.done.push(d); else out.already.push(d);
      } catch (e) {
        out.failed.push(d);
        console.error('HOLD_WRITE_FAILED date=' + d + ' session=' + session.id + ' why=' + String(e && e.message || e).slice(0, 60));
      }
    }
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe signature error:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // Processa apenas checkout.session.completed
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: JSON.stringify({ received: true, ignored: stripeEvent.type }) };
  }

  // Live-mail switch (fail closed). A live-mode event is only processed when LIVE_EMAIL_ENABLED is
  // exactly "1". The variable is meant to exist only in the Production deploy context; anywhere it is
  // absent (previews, branch deploys, agent runners) a live event sends nothing and answers 500, so it
  // is visible in Stripe and retried. Sandbox events never need it (they stay behind TEST_ONLY_RECIPIENT).
  const isLive = stripeEvent.livemode === true;
  if (isLive && process.env.LIVE_EMAIL_ENABLED !== '1') {
    console.error('Live event but LIVE_EMAIL_ENABLED is not 1; nothing sent');
    return { statusCode: 500, body: JSON.stringify({ received: false, error: 'live_email_disabled' }) };
  }

  const session = stripeEvent.data.object;
  // A completed session that is not paid yet (asynchronous method) sends no confirmation and blocks no date.
  if (session.payment_status !== 'paid') {
    console.log('checkout.session.completed not paid yet (' + session.payment_status + '): no email, no hold, session=' + session.id);
    return { statusCode: 200, body: JSON.stringify({ received: true, session_id: session.id, ignored: 'payment_not_paid', payment_status: session.payment_status || null }) };
  }
  const clientEmail = session.customer_details?.email;
  const clientName  = session.customer_details?.name || 'Valued Guest';
  const tourName    = session.metadata?.tour_name || session.metadata?.tours || 'Tupi Tour Experience';

  const errors = [];
  const details = {};

  // What Stripe settled in BRL for this payment (read only): amount and the rate of the day of payment.
  let bt = null;
  try {
    if (session.payment_intent) {
      const pi = await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge.balance_transaction'] });
      const t = pi && pi.latest_charge && pi.latest_charge.balance_transaction;
      if (t && typeof t === 'object' && String(t.currency).toLowerCase() === 'brl') bt = { amount: t.amount, exchange_rate: t.exchange_rate };
    }
  } catch (err) { console.error('Balance transaction lookup error:', err.message); }

  // Stripe's own per-line amounts (same order as the cart items).
  let lines = [];
  try {
    const li = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
    lines = li.data || [];
  } catch (err) {
    console.error('Line items error:', err.message);
  }

  // Sending goes straight to Resend's HTTP API, once per (checkout session, email kind), guarded by the
  // table public.email_sends (see sendOnce). Resend's 24 h Idempotency-Key is kept as a second layer.
  // Guarantees: no second send after a recorded send; no send without a stored claim; no send when the
  // store is unreachable (answers 500, Stripe retries). Not exactly-once: if the outcome of a send is
  // unknown and more than 23 h pass, nothing is resent and the row becomes 'review' (answers 500 and
  // logs EMAIL_NEEDS_REVIEW; query public.email_sends_attention). A missing email is never silent.
  // Test-mode guard (fail closed). Stripe's signed event says livemode=false for sandbox events
  // In test mode an email goes out only if
  // its recipient is EXACTLY one of the addresses in TEST_ONLY_RECIPIENT (comma separated); a
  // missing or empty list blocks every send. Live events in production are not affected.
  const testMode = !isLive;
  const allowed = String(process.env.TEST_ONLY_RECIPIENT || '').split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
  const skipped = [];
  // In test mode the order itself must come from an allowed address, so an old sandbox order
  // (other customer address) triggers no email at all, not even the admin notice.
  const orderAllowed = !testMode || (typeof clientEmail === 'string' && clientEmail === clientEmail.trim() && allowed.indexOf(clientEmail.toLowerCase()) !== -1);
  const emailStore = supabaseStore(process.env);
  async function send(kind, payload) {
    if (testMode && !orderAllowed || testMode && !(typeof payload.to === 'string' && allowed.indexOf(payload.to.trim().toLowerCase()) !== -1 && payload.to === payload.to.trim())) {
      skipped.push(kind);
      console.log('Test mode: ' + kind + ' email not sent (recipient not in TEST_ONLY_RECIPIENT)');
      return { ok: true, skipped: true };
    }
    // Sandbox events use ONLY RESEND_API_KEY_TEST (never the production key). Missing = nothing sent.
    const apiKey = testMode ? process.env.RESEND_API_KEY_TEST : process.env.RESEND_API_KEY;
    if (testMode && !apiKey) {
      skipped.push(kind);
      console.log('Test mode: ' + kind + ' email not sent (RESEND_API_KEY_TEST not set)');
      return { ok: true, skipped: true };
    }
    // Durable once-per-(session,kind) guard (table public.email_sends). A definite provider rejection
    // (HTTP 4xx except 409) marks the attempt failed; anything unclear (network error, 5xx, 409, timeout)
    // leaves the claim open, and the guard decides what is safe on the next Stripe retry.
    const transport = { send: async function (idemKey) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
        body: JSON.stringify({ from: payload.from, to: payload.to, reply_to: payload.replyTo, subject: (testMode ? '[TESTE] ' : '') + payload.subject, html: payload.html }),
        signal: AbortSignal.timeout(8000),
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (res.ok) return { ok: true, id: data && data.id };
      if (res.status >= 400 && res.status < 500 && res.status !== 409) return { ok: false, why: (data && (data.message || data.name)) || ('http_' + res.status) };
      return { unknown: true };
    } };
    const out = await sendOnce(emailStore, kind, session.id, transport);
    if (out.action === 'sent' || out.action === 'skip' && out.why === 'already_sent') return { ok: true, id: out.id, already: out.why === 'already_sent' };
    if (out.action === 'skip') { console.error('EMAIL_NEEDS_REVIEW kind=' + kind + ' session=' + session.id + ' why=' + out.why); return { ok: false, why: 'needs_review' }; }
    if (out.action === 'sent_unmarked') { console.error('EMAIL_SENT_UNMARKED kind=' + kind + ' session=' + session.id); return { ok: false, why: 'sent_unmarked' }; }
    return { ok: false, why: out.why };
  }

  // 0. Date hold (only for a paid order; in test mode only for an allowed order). Before the emails, so the
  // admin notice can say when it failed. A failure never blocks the emails; it makes the answer 500 at the end,
  // so Stripe retries the event: the retry repeats only the hold (emails are guarded by sendOnce).
  let hold = { done: [], already: [], failed: [] };
  if (orderAllowed) hold = await writeHolds(readItems(session), session, clientName, process.env);
  else console.log('Test mode: date hold not written (order not from an allowed address)');

  // 1. Recibo ao cliente
  if (clientEmail) {
    const r1 = await send('receipt', {
      from: `Tupi Tour <${FROM_EMAIL}>`,
      to:   clientEmail,
      replyTo: ADMIN_EMAIL,
      subject: (langOf(session) === 'es' ? 'Reserva confirmada' : 'Booking Confirmed') + ` — ${tourName}`,
      html: buildClientReceiptHtml(session, lines),
    });
    if (!r1.ok) {
      console.error('Client receipt not sent:', r1.why);
      errors.push('client_receipt_failed'); details.receipt = r1.why;
    }
  }

  // 2. Notificação ao Flávio (also tried when the receipt failed, so one failure does not hide the order)
  const r2 = await send('admin', {
    from: `Tupi Tour Bookings <${FROM_EMAIL}>`,
    to:   ADMIN_EMAIL,
    replyTo: clientEmail || ADMIN_EMAIL,
    subject: `🎉 New booking: ${tourName} — ${clientName}`,
    html: withHoldWarning(buildAdminNotificationHtml(session, lines, bt), hold),
  });
  if (!r2.ok) {
    console.error('Admin notification not sent:', r2.why);
    errors.push('admin_notification_failed'); details.admin = r2.why;
  }

  if (hold.failed.length) { errors.push('hold_write_failed'); details.hold = hold.failed.join(','); }
  if (errors.length) {
    return { statusCode: 500, body: JSON.stringify({ received: true, session_id: session.id, errors: errors, details: details, retry: true, skipped: skipped.length ? skipped : undefined }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      received: true,
      session_id: session.id,
      hold: { blocked: hold.done, already_blocked: hold.already },
      errors: errors.length ? errors : undefined,
      skipped: skipped.length ? 'not_allowlisted:' + skipped.join(',') : undefined,
    }),
  };
};


exports._test = { writeHolds, withHoldWarning };
