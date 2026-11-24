const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Read-only. Returns only the payment state of a Checkout Session so the site
// can show a result after the customer comes back from Stripe.
exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  const id = (event.queryStringParameters || {}).session_id || '';
  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(id)) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Invalid session' }) };
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(id);
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ status: session.status, payment_status: session.payment_status })
    };
  } catch (err) {
    console.error('Stripe retrieve error:', err.message);
    return { statusCode: 404, headers: headers, body: JSON.stringify({ error: 'Not found' }) };
  }
};
