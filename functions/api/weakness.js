// Cloudflare Pages Function: POST /api/weakness
// Receives weakness data from app, stores in KV
export async function onRequestPost(context) {
  try {
    const data = await context.request.json();
    // Store with timestamp as key
    const key = `weakness_${Date.now()}`;
    await context.env.AI900_KV.put(key, JSON.stringify(data), { expirationTtl: 86400 * 30 }); // 30 days
    // Also overwrite 'latest' key
    await context.env.AI900_KV.put('weakness_latest', JSON.stringify({ ...data, storedAt: new Date().toISOString() }));
    return new Response(JSON.stringify({ ok: true, key }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// GET /api/weakness - retrieve latest weakness data
export async function onRequestGet(context) {
  try {
    const data = await context.env.AI900_KV.get('weakness_latest');
    if (!data) {
      return new Response(JSON.stringify({ ok: true, data: null }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    return new Response(JSON.stringify({ ok: true, data: JSON.parse(data) }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
