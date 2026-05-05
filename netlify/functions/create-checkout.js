const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

  const lineItems = items.map(function(item) {
    return {
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          description: [
            item.date ? '📅 ' + item.date : null,
            item.time ? '🕐 ' + item.time : null,
            item.group ? '👥 ' + item.group + ' people' : null,
            item.priceLabel || null
          ].filter(Boolean).join('  ·  ')
        },
        unit_amount: Math.round(item.price * 100)
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
        dates: items.map(function(i) { return i.date || ''; }).join(' | ')
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
