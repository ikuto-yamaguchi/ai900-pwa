// Cloudflare Pages Function: /api/strategy
// Opus coach writes learning strategy; app and Sonnet tutor read it.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// PUT: Coach writes strategy
export async function onRequestPut(context) {
  try {
    const strategy = await context.request.json();
    strategy.updatedAt = new Date().toISOString();
    await context.env.AI900_KV.put('coach_strategy', JSON.stringify(strategy));

    // Also archive for history
    await context.env.AI900_KV.put(
      `coach_strategy_${Date.now()}`,
      JSON.stringify(strategy),
      { expirationTtl: 86400 * 30 }
    );

    return json({ ok: true, updatedAt: strategy.updatedAt });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// GET: App/Sonnet reads strategy
export async function onRequestGet(context) {
  try {
    const raw = await context.env.AI900_KV.get('coach_strategy');
    if (!raw) return json({ ok: true, strategy: null });
    return json({ ok: true, strategy: JSON.parse(raw) });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
