const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabase(method, path, body) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=minimal' : ''
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (method === 'DELETE' || (method === 'POST' && res.status === 201)) return { ok: true };
  const text = await res.text();
  try { return JSON.parse(text); } catch(e) { return text; }
}

exports.handler = async function(event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // GET — public, no auth needed
  if (event.httpMethod === 'GET') {
    const data = await supabase('GET', 'blocked_dates?select=date,note,source&order=date.asc');
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  }

  // POST and DELETE require admin key
  const adminKey = event.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (event.httpMethod === 'POST') {
    const body = JSON.parse(event.body);
    await supabase('POST', 'blocked_dates', {
      date: body.date,
      note: body.note || null,
      source: body.source || 'manual'
    });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod === 'DELETE') {
    const body = JSON.parse(event.body);
    await supabase('DELETE', 'blocked_dates?date=eq.' + body.date);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
