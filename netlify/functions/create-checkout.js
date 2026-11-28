const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Server-side price check. Same rule as the site (index.html and es/index.html):
// fixed USD price per tour; a booking is a deposit (USD 30 x days)
// or the full amount with 10% off (price x days x 0.9, rounded).
// Keep this table in sync with the `tours` object in index.html.
const TOUR_PRICES = {
  'Sunrise Tour': 180,
  'Airport Arrival Tour': 380,
  'Airport Departure Tour': 380,
  'City Tour Rio': 280,
  'City Tour Rio \u2014 3 days': 260,
  'City Tour Rio \u2014 5 days': 250,
  'Tijuca Forest': 230,
  'Coast to Coast': 280,
  'Food Tour Rio': 200,
  'Pantanal Carioca': 150,
  'Pequena \u00c1frica': 230,
  'Favela Tour \u2014 Rocinha': 230,
  'Rafting': 250,
  'Petr\u00f3polis': 380
};
// Per-group price list of the site's tour panel (1 to 4 people). The deposit stays USD 30 x days;
// the full payment keeps the 10% discount on the price of the chosen group size.
const GROUP_PRICES = {
  'Pantanal Carioca': { 1: 150, 2: 180, 3: 190, 4: 200 },
  'Rafting': { 1: 250, 2: 270, 3: 410, 4: 430 }
};
// Tour price for the group size of an item (null when the tour has a per-group list and the size is not 1 to 4).
function basePriceFor(name, group) {
  const list = GROUP_PRICES[name];
  if (!list) return TOUR_PRICES[name];
  const n = /^[1-4]$/.test(String(group)) ? Number(group) : 0;
  return n ? list[n] : null;
}
const MULTI_DAY_TOURS = {
  'City Tour Rio \u2014 3 days': 3,
  'City Tour Rio \u2014 5 days': 5
};

// Every booking in the site goes through the calendar, so an item is always
// either the deposit (USD 30 x days) or the full amount (price x days x 0.9).
// The undiscounted base price is not offered by any path and is rejected.
function allowedPrices(name, group) {
  const base = basePriceFor(name, group);
  if (typeof base !== 'number') return null;
  const days = MULTI_DAY_TOURS[name] || 1;
  return { deposit: 30 * days, full: Math.round(base * days * 0.9) };
}

// Age ranges: travelers under 21 and over 60. Optional only for older cached pages that do not send them;
// when sent, both must be whole numbers from 0 up to the group size, and together no more than the group size.
function validateAges(item) {
  const hasU = item.under21 !== undefined && item.under21 !== null;
  const hasO = item.over60 !== undefined && item.over60 !== null;
  if (!hasU && !hasO) return null;
  if (!hasU || !hasO) return 'Invalid age ranges';
  const g = /^[1-4]$/.test(String(item.group)) ? Number(item.group) : 0;
  if (!g || !Number.isInteger(item.under21) || !Number.isInteger(item.over60)) return 'Invalid age ranges';
  if (item.under21 < 0 || item.over60 < 0 || item.under21 + item.over60 > g) return 'Invalid age ranges';
  return null;
}

function validateItems(items) {
  for (const item of items) {
    if (!item || typeof item.name !== 'string') return 'Invalid item';
    const ageError = validateAges(item);
    if (ageError) return ageError;
    if (typeof TOUR_PRICES[item.name] !== 'number') return 'Unknown tour';
    const allowed = allowedPrices(item.name, item.group);
    if (!allowed) return 'Invalid group size';
    if (typeof item.price !== 'number' || !isFinite(item.price)) return 'Invalid price';
    if (item.paymentType === 'deposit') {
      if (item.price !== allowed.deposit) return 'Invalid price';
    } else if (item.paymentType === 'full') {
      if (item.price !== allowed.full) return 'Invalid price';
    } else if (item.paymentType === undefined || item.paymentType === '') {
      // Older cached pages do not send paymentType: accept either offered amount.
      if (item.price !== allowed.deposit && item.price !== allowed.full) return 'Invalid price';
    } else {
      return 'Invalid price';
    }
  }
  return null;
}

// Stripe metadata values are limited to 500 characters.
function metaText(v) {
  v = String(v == null ? '' : v);
  return v.length > 500 ? v.slice(0, 497) + '...' : v;
}

// USD to BRL rate fetched on the server (same source the site uses).
// Falls back to the same conservative 6.0 the site uses if the lookup fails.
async function getServerRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    if (data && data.rates && typeof data.rates.BRL === 'number' && data.rates.BRL > 1) return data.rates.BRL;
  } catch (e) {
    console.error('FX fetch error:', e.message);
  }
  return 6.0;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { items, guestName, guestEmail, lang } = body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No items in cart' }) };
  }

  if (items.length > 30) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Too many items' }) };
  }

  const priceError = validateItems(items);
  if (priceError) {
    return { statusCode: 400, body: JSON.stringify({ error: priceError }) };
  }


  // Return URLs are built on the server (the browser can no longer choose them).
  // The Spanish site returns to /es/, everything else to the home page.
  // Netlify deploy previews of this site return to the preview itself so a test payment can be checked end to end.
  // Any other host (production, custom domain, direct calls) returns to production.
  const reqHost = String((event.headers && (event.headers['x-forwarded-host'] || event.headers.host)) || '').toLowerCase();
  const siteBase = /^deploy-preview-\d+--tupitour\.netlify\.app$/.test(reqHost) ? 'https://' + reqHost : 'https://tupitour.com';
  const returnBase = siteBase + (lang === 'es' ? '/es/' : '/');

  const lineItems = items.map(function(item) {
    // item.price is always in USD (as stored in the cart). The checkout is charged in USD exactly
    // as advertised on the site (no BRL step, so no double conversion). Stripe settles to the BRL balance.
    const usdCents = Math.round(item.price * 100);
    // Checkout text in the site language (Spanish texts are a draft for the owner's review).
    const es = lang === 'es';
    const people = String(item.group) === '1' ? (es ? 'persona' : 'person') : (es ? 'personas' : 'people');
    const payLabel = item.paymentType === 'deposit'
      ? (es ? 'Reserva \u2014 anticipo de USD ' + item.price + ' (saldo el d\u00eda del tour)' : 'Reserve \u2014 USD ' + item.price + ' deposit (balance due on the day)')
      : (item.paymentType === 'full'
        ? (es ? 'Pago completo \u2014 USD ' + item.price + ' (10 % de descuento aplicado)' : 'Pay in full \u2014 USD ' + item.price + ' (10% discount applied)')
        : (item.priceLabel || null));

    return {
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          description: [
            item.date ? '📅 ' + item.date : null,
            item.time ? '🕐 ' + item.time : null,
            item.group ? '👥 ' + item.group + ' ' + people : null,
            payLabel
          ].filter(Boolean).join('  ·  ')
        },
        unit_amount: usdCents
      },
      quantity: 1
    };
  });

  // One metadata key per cart item, saved at checkout time (read by stripe-webhook.js).
  // Dates that already have a block or hold in blocked_dates. The row's source is not
  // interpreted (a hold is not treated as a paid booking); the flag only drives the partner-guide notice.
  let blockedSet = null;
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/blocked_dates?select=date', {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY }
    });
    if (r.ok) blockedSet = new Set((await r.json()).map(function(x) { return x.date; }));
  } catch (e) { console.error('Blocked lookup error:', e.message); }

  const itemMeta = {};
  items.forEach(function(i, idx) {
    const taken = blockedSet && i.date && i.date !== 'Flexible dates (TBC)'
      ? i.date.split(',').map(function(s) { return s.trim(); }).filter(function(d) { return blockedSet.has(d); })
      : [];
    itemMeta['item_' + (idx + 1)] = metaText(JSON.stringify({ n: i.name, d: i.date || '', t: i.time || '', g: i.group || '', p: i.paymentType || '', u: i.price, l: i.priceLabel || '', pd: taken, lp: (basePriceFor(i.name, i.group) || 0) * (MULTI_DAY_TOURS[i.name] || 1), a21: Number.isInteger(i.under21) ? i.under21 : null, a60: Number.isInteger(i.over60) ? i.over60 : null }));
  });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      // Hosted checkout page in the language chosen on the site.
      locale: lang === 'es' ? 'es' : 'en',
      // The price is already in the advertised currency: no local-currency conversion on top.
      adaptive_pricing: { enabled: false },
      customer_email: guestEmail || undefined,
      metadata: Object.assign({}, itemMeta, {
        item_count: String(items.length),
        guest_name: guestName || '',
        guest_email: guestEmail || '',
        // Site language of the order (the confirmation email follows it).
        lang: lang === 'es' ? 'es' : 'en',
        tours: items.map(function(i) { return i.name; }).join(', '),
        dates: items.map(function(i) { return i.date || ''; }).join(' | '),
        // Keys the confirmation emails read (stripe-webhook.js).
        tour_name: metaText(items.map(function(i) { return i.name; }).join(', ')),
        tour_date: metaText(items.map(function(i) { return i.date || ''; }).join(' | ')),
        group_size: metaText(items.map(function(i) { return i.group || ''; }).join(' | ')),
        payment_type: metaText(items.map(function(i) { return i.paymentType || ''; }).join(', '))
      }),
      success_url: returnBase + '?payment=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: returnBase + '?payment=cancelled',
    });

    // Dates are blocked by stripe-webhook.js only after the payment is confirmed (not here, before paying).

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url })
    };
  } catch(err) {
    console.error('Stripe error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};

exports._test = { validateItems, validateAges, allowedPrices, basePriceFor };
