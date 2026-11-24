const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Server-side price check. Same rule as the site (index.html and es/index.html):
// fixed USD price per tour; a calendar booking is a deposit (USD 30 x days)
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

function allowedPrices(name) {
  const base = TOUR_PRICES[name];
  if (typeof base !== 'number') return null;
  const days = MULTI_DAY_TOURS[name] || 1;
  return [base, 30 * days, Math.round(base * days * 0.9)];
}

function validateItems(items) {
  for (const item of items) {
    if (!item || typeof item.name !== 'string') return 'Invalid item';
    const allowed = allowedPrices(item.name);
    if (!allowed) return 'Unknown tour';
    if (typeof item.price !== 'number' || allowed.indexOf(item.price) === -1) return 'Invalid price';
  }
  return null;
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

  const { items, guestName, guestEmail, successUrl, cancelUrl } = body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No items in cart' }) };
  }

  const priceError = validateItems(items);
  if (priceError) {
    return { statusCode: 400, body: JSON.stringify({ error: priceError }) };
  }

  // The rate is fetched on the server. brlRate from the browser is ignored.
  const rate = await getServerRate();

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

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: guestEmail || undefined,
      metadata: {
        guest_name: guestName || '',
        guest_email: guestEmail || '',
        tours: items.map(function(i) { return i.name; }).join(', '),
        dates: items.map(function(i) { return i.date || ''; }).join(' | '),
        usd_rate: String(rate)
      },
      success_url: successUrl || 'https://www.tupitour.com/?payment=success',
      cancel_url: cancelUrl || 'https://www.tupitour.com/?payment=cancelled',
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
