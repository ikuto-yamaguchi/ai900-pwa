// Cloudflare Pages Function: /api/flags
// POST: Submit user flags for questions
// GET: Retrieve pending flags (for trainer)
// DELETE: Clear processed flags

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
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { flags } = body;

    if (!Array.isArray(flags) || flags.length === 0) {
      return json({ ok: false, error: 'flags must be a non-empty array' }, 400);
    }

    const raw = await context.env.AI900_KV.get('user_flags');
    const existing = raw ? JSON.parse(raw) : [];
    const merged = [...existing, ...flags];

    await context.env.AI900_KV.put('user_flags', JSON.stringify(merged), {
      expirationTtl: 86400 * 90,
    });

    return json({ ok: true, count: merged.length });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

export async function onRequestGet(context) {
  try {
    const raw = await context.env.AI900_KV.get('user_flags');
    const flags = raw ? JSON.parse(raw) : [];
    return json({ ok: true, flags });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    await context.env.AI900_KV.delete('user_flags');
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}
