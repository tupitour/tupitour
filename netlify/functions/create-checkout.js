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
const MULTI_DAY_TOURS = {
  'City Tour Rio \u2014 3 days': 3,
  'City Tour Rio \u2014 5 days': 5
};

// Every booking in the site goes through the calendar, so an item is always
// either the deposit (USD 30 x days) or the full amount (price x days x 0.9).
// The undiscounted base price is not offered by any path and is rejected.
function allowedPrices(name) {
  const base = TOUR_PRICES[name];
  if (typeof base !== 'number') return null;
  const days = MULTI_DAY_TOURS[name] || 1;
  return { deposit: 30 * days, full: Math.round(base * days * 0.9) };
}

function validateItems(items) {
  for (const item of items) {
    if (!item || typeof item.name !== 'string') return 'Invalid item';
    const allowed = allowedPrices(item.name);
    if (!allowed) return 'Unknown tour';
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

// Block the booked dates in Supabase after the Stripe session is created.
async function blockDateInSupabase(date, tourName, guestName) {
  if (!date || date === 'Flexible dates (TBC)') return;
  const dates = date.split(', ');
  for (const d of dates) {
    const clean = d.trim();
    if (!clean.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
    try {
      await fetch(SUPABASE_URL + '/rest/v1/blocked_dates', {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          date: clean,
          note: tourName + (guestName ? ' — ' + guestName : ''),
          source: 'stripe'
        })
      });
    } catch(e) {
      console.error('Supabase block error:', e.message);
    }
  }
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

  // The rate is fetched on the server. brlRate from the browser is ignored.
  const rate = await getServerRate();

  // Return URLs are built on the server (the browser can no longer choose them).
  // The Spanish site returns to /es/, everything else to the home page.
  const returnBase = 'https://tupitour.com' + (lang === 'es' ? '/es/' : '/');

  const lineItems = items.map(function(item) {
    // item.price is always in USD (as stored in the cart).
    // Convert to BRL, round to 2 decimal places, then to centavos (integer).
    const brlAmount = Math.round(item.price * rate * 100); // centavos

    return {
      price_data: {
        currency: 'brl',
        product_data: {
          name: item.name,
          description: [
            item.date ? '📅 ' + item.date : null,
            item.time ? '🕐 ' + item.time : null,
            item.group ? '👥 ' + item.group + ' people' : null,
            item.priceLabel || null,
            'USD ' + item.price + ' · Rate: 1 USD = R$ ' + rate.toFixed(2)
          ].filter(Boolean).join('  ·  ')
        },
        unit_amount: brlAmount
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
    itemMeta['item_' + (idx + 1)] = metaText(JSON.stringify({ n: i.name, d: i.date || '', t: i.time || '', g: i.group || '', p: i.paymentType || '', u: i.price, l: i.priceLabel || '', pd: taken }));
  });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: guestEmail || undefined,
      metadata: Object.assign({}, itemMeta, {
        item_count: String(items.length),
        guest_name: guestName || '',
        guest_email: guestEmail || '',
        tours: items.map(function(i) { return i.name; }).join(', '),
        dates: items.map(function(i) { return i.date || ''; }).join(' | '),
        usd_rate: String(rate),
        // Keys the confirmation emails read (stripe-webhook.js).
        tour_name: metaText(items.map(function(i) { return i.name; }).join(', ')),
        tour_date: metaText(items.map(function(i) { return i.date || ''; }).join(' | ')),
        group_size: metaText(items.map(function(i) { return i.group || ''; }).join(' | ')),
        payment_type: metaText(items.map(function(i) { return i.paymentType || ''; }).join(', '))
      }),
      success_url: returnBase + '?payment=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: returnBase + '?payment=cancelled',
    });

    for (const item of items) {
      if (item.date && item.date !== 'Flexible dates (TBC)') {
        await blockDateInSupabase(item.date, item.name, guestName);
      }
    }

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

exports._test = { validateItems, allowedPrices };
