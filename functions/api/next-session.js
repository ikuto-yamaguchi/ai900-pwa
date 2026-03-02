// Cloudflare Pages Function: /api/next-session
// Sonnet tutor writes optimized question sets; app reads on session start.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// PUT: Sonnet tutor writes curated session
export async function onRequestPut(context) {
  try {
    const session = await context.request.json();
    session.updatedAt = new Date().toISOString();
    session.consumed = false;
    await context.env.AI900_KV.put('next_session', JSON.stringify(session));
    return json({ ok: true, updatedAt: session.updatedAt, questionCount: (session.questions || []).length });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// GET: App reads curated session
export async function onRequestGet(context) {
  try {
    const raw = await context.env.AI900_KV.get('next_session');
    if (!raw) return json({ ok: true, session: null });
    const session = JSON.parse(raw);
    return json({ ok: true, session });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// POST: App marks session as consumed (so tutor prepares next one)
export async function onRequestPost(context) {
  try {
    const raw = await context.env.AI900_KV.get('next_session');
    if (raw) {
      const session = JSON.parse(raw);
      session.consumed = true;
      session.consumedAt = new Date().toISOString();
      await context.env.AI900_KV.put('next_session', JSON.stringify(session));
    }
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
