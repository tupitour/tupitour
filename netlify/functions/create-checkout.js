const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { items, guestName, guestEmail, successUrl, cancelUrl } = body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No items in cart' }) };
  }

  // Build Stripe line_items from cart
  const lineItems = items.map(function (item) {
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
        unit_amount: Math.round(item.price * 100) // Stripe uses cents
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
        tours: items.map(function (i) { return i.name; }).join(', ')
      },
      success_url: successUrl || 'https://www.tupitour.com/?payment=success',
      cancel_url: cancelUrl || 'https://www.tupitour.com/?payment=cancelled',
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url })
    };
  } catch (err) {
    console.error('Stripe error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
