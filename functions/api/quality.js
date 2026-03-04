// Cloudflare Pages Function: /api/quality
// GET: Retrieve quality metadata
// PUT: Trainer uploads updated quality metadata

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestGet(context) {
  try {
    const raw = await context.env.AI900_KV.get('quality_metadata');
    if (!raw) return json({ ok: true, quality: null });
    return json({ ok: true, quality: JSON.parse(raw) });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const body = await context.request.json();
    if (!body || body.schema !== 'quality-metadata-v1') {
      return json({ ok: false, error: 'Invalid quality metadata schema' }, 400);
    }

    await context.env.AI900_KV.put('quality_metadata', JSON.stringify(body), {
      expirationTtl: 86400 * 365,
    });

    return json({ ok: true, updatedAt: body.updatedAt });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}
