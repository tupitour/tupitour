// netlify/functions/stripe-webhook.js
// Stripe webhook — processa checkout.session.completed
// Envia recibo HTML ao cliente (via Resend) + notificação ao Flávio

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

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

// One block per tour: what was chosen, what Stripe charged for that line.
// The balance amount is not shown: the site states it is due on the day and
// the order does not store a balance figure.
function buildItemRows(items, lines, currency) {
  return items.map(function(it, idx) {
    const line = lines && lines[idx];
    const charged = line && typeof line.amount_total === 'number'
      ? currency + ' ' + (line.amount_total / 100).toFixed(2)
      : 'not available';
    const status = '';
    const rows = [
      ['Date', it.d || 'To be confirmed'],
      it.pd && it.pd.length ? ['Partner guide', 'Tupi Tour may assign a partner guide for ' + esc(it.pd.join(', ')) + '. We will confirm who will lead your tour.'] : null,
      it.t ? ['Time', it.t] : null,
      it.g ? ['Group size', it.g] : null,
      it.lp ? ['Tour price', 'USD ' + esc(it.lp)] : null,
      it.p === 'full'
        ? [it.lp ? 'Applied to tour price (full payment)' : 'Amount paid', 'USD ' + esc(it.u) + (it.lp ? ' (10% discount applied)' : '')]
        : (it.p === 'deposit' ? ['Deposit applied toward tour price', 'USD ' + esc(it.u)] : ['Amount', 'USD ' + esc(it.u)]),
      it.p === 'deposit' ? ['Balance', 'Due on the day of the tour'] : null,
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Booking Confirmed — Tupi Tour</title>
</head>
<body style="margin:0;padding:0;background:#F8F7F4;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8F7F4;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0"
               style="background:#FFFFFF;border-radius:4px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.07);">

          <!-- Header bar -->
          <tr>
            <td height="4"
                style="background:linear-gradient(90deg,#1B7A3E 0%,#1B7A3E 40%,#F5C518 40%,#F5C518 70%,#1B2F6E 70%,#1B2F6E 100%);"></td>
          </tr>

          <!-- Logo / brand -->
          <tr>
            <td align="center" style="padding:32px 40px 20px;">
              <img src="https://www.tupitour.com/imgs/logo.png"
                   alt="Tupi Tour" width="140"
                   style="display:block;height:auto;border:0;">
            </td>
          </tr>

          <!-- Status badge -->
          <tr>
            <td align="center" style="padding:0 40px 24px;">
              <span style="display:inline-block;background:#1B7A3E;color:#FFFFFF;font-size:13px;font-weight:600;
                           letter-spacing:0.06em;text-transform:uppercase;padding:6px 20px;border-radius:2px;">
                ✓ Booking Confirmed
              </span>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:0 40px 24px;">
              <p style="font-size:15px;color:#333333;margin:0;">
                Hi <strong>${name}</strong>,
              </p>
              <p style="font-size:15px;color:#555555;margin:12px 0 0;line-height:1.6;">
                Your booking is confirmed. Tupi Tour will be in touch within 24 hours to finalise details
                and answer any questions you may have. We can't wait to show you Brazil.
              </p>
            </td>
          </tr>

          <!-- Booking summary table -->
          <tr>
            <td style="padding:0 40px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0"
                     style="border:1px solid #E5E3DE;border-radius:2px;overflow:hidden;">
                <tr style="background:#F8F7F4;">
                  <td colspan="2"
                      style="padding:12px 16px;font-size:11px;font-weight:600;letter-spacing:0.08em;
                             text-transform:uppercase;color:#AAAAAA;">
                    Booking Summary
                  </td>
                </tr>
                ${items.length ? buildItemRows(items, lines, currency) : `                <tr style="border-top:1px solid #E5E3DE;">
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
                <tr style="border-top:1px solid #E5E3DE;background:#FAFAF8;">
                  <td style="padding:12px 16px;font-size:13px;color:#555555;">${items.length ? 'Total paid' : 'Amount paid'}</td>
                  <td style="padding:12px 16px;font-size:15px;font-weight:700;color:#1B7A3E;">
                    ${currency} ${amount}
                    ${items.length ? '<div style="font-size:11px;font-weight:400;color:#777777;margin-top:4px;">Cart price: USD ' + items.reduce(function(s, x) { return s + (Number(x.u) || 0); }, 0) + (pres ? '. Total includes the currency conversion applied by Stripe at checkout.' : '') + '</div>' : ''}
                  </td>
                </tr>
                <tr style="border-top:1px solid #E5E3DE;">
                  <td style="padding:12px 16px;font-size:11px;color:#AAAAAA;">Reference</td>
                  <td style="padding:12px 16px;font-size:11px;color:#AAAAAA;word-break:break-all;">${sessionId}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Next steps -->
          <tr>
            <td style="padding:0 40px 32px;">
              <p style="font-size:13px;font-weight:600;color:#111111;margin:0 0 8px;
                        letter-spacing:0.05em;text-transform:uppercase;">What happens next</p>
              <ul style="margin:0;padding-left:20px;color:#555555;font-size:14px;line-height:1.8;">
                <li>Tupi Tour will email you within <strong>24 hours</strong> to confirm all details.</li>
                <li>You can also reach us directly on
                    <a href="https://wa.me/5521988042225" style="color:#1B7A3E;text-decoration:none;">WhatsApp</a>.
                </li>
                <li>Please keep this email as your receipt.</li>
              </ul>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:0 40px;">
              <hr style="border:none;border-top:1px solid #E5E3DE;margin:0;">
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding:24px 40px 32px;">
              <p style="font-size:12px;color:#AAAAAA;margin:0;">
                Tupi Tour · Rio de Janeiro, Brazil ·
                <a href="https://www.tupitour.com" style="color:#AAAAAA;">tupitour.com</a>
              </p>
              <p style="font-size:12px;color:#AAAAAA;margin:6px 0 0;">
                Questions? Reply to this email or message us on
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
function buildAdminNotificationHtml(session, lines) {
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
${items.length ? `      <tr><td colspan="2" style="padding:0;"><table cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #E5E3DE;">${buildItemRows(items, lines, currency)}</table></td></tr>
      <tr><td style="color:#888;">Total paid</td><td><strong style="color:#1B7A3E;">${pres ? pres.presentment_currency.toUpperCase() + ' ' + (pres.presentment_amount / 100).toFixed(2) : currency + ' ' + amount}</strong>${pres ? '<div style="font-size:11px;color:#777;">Settled by Stripe: ' + currency + ' ' + amount + '. Cart price: USD ' + items.reduce(function(t, x) { return t + (Number(x.u) || 0); }, 0) + '.</div>' : ''}</td></tr>
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

  const session = stripeEvent.data.object;
  const clientEmail = session.customer_details?.email;
  const clientName  = session.customer_details?.name || 'Valued Guest';
  const tourName    = session.metadata?.tour_name || session.metadata?.tours || 'Tupi Tour Experience';

  const errors = [];

  // Stripe's own per-line amounts (same order as the cart items).
  let lines = [];
  try {
    const li = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
    lines = li.data || [];
  } catch (err) {
    console.error('Line items error:', err.message);
  }

  // Resend's SDK returns { data, error } and does not throw on a rejected send, so check .error.
  // Order matters for retries: the customer receipt goes first. If it fails we answer 500 BEFORE
  // sending the admin notice, so Stripe's retry cannot duplicate any email that already went out.
  // If only the admin notice fails we answer 200 (a retry would resend the receipt) and report it.
  async function send(payload) {
    try {
      const r = await resend.emails.send(payload);
      if (r && r.error) return { ok: false, why: r.error.message || r.error.name || 'send_rejected' };
      return { ok: true, id: r && r.data && r.data.id };
    } catch (err) {
      return { ok: false, why: err && err.message ? err.message : 'send_threw' };
    }
  }

  // 1. Recibo ao cliente
  if (clientEmail) {
    const r1 = await send({
      from: `Tupi Tour <${FROM_EMAIL}>`,
      to:   clientEmail,
      replyTo: ADMIN_EMAIL,
      subject: `Booking Confirmed — ${tourName}`,
      html: buildClientReceiptHtml(session, lines),
    });
    if (!r1.ok) {
      console.error('Client receipt not sent:', r1.why);
      return { statusCode: 500, body: JSON.stringify({ received: true, session_id: session.id, errors: ['client_receipt_failed'], retry: true }) };
    }
  }

  // 2. Notificação ao Flávio
  const r2 = await send({
    from: `Tupi Tour Bookings <${FROM_EMAIL}>`,
    to:   ADMIN_EMAIL,
    replyTo: clientEmail || ADMIN_EMAIL,
    subject: `🎉 New booking: ${tourName} — ${clientName}`,
    html: buildAdminNotificationHtml(session, lines),
  });
  if (!r2.ok) {
    console.error('Admin notification not sent:', r2.why);
    errors.push('admin_notification_failed');
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      received: true,
      session_id: session.id,
      errors: errors.length ? errors : undefined,
    }),
  };
};
