// Cloudflare Pages Function: /api/generate-request
// App POSTs here when unseen question ratio drops below threshold.
// Stores a generation task in KV for Claude Code to pick up.

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { unseenRatio, totalQuestions, uniqueSeen, needed, weakness, domains } = body;

    // Validate input
    if (typeof unseenRatio !== 'number' || typeof needed !== 'number' || needed < 1) {
      return json({ ok: false, error: 'Invalid request' }, 400);
    }

    // Check if there's already a pending request (prevent duplicate generation)
    const pending = await context.env.AI900_KV.get('gen_request_pending');
    if (pending) {
      const req = JSON.parse(pending);
      const age = Date.now() - new Date(req.createdAt).getTime();
      // If pending request is less than 1 hour old, skip
      if (age < 3600000) {
        return json({ ok: true, status: 'already_pending', existingRequest: req.id });
      }
      // Stale request, allow overwrite
    }

    const requestId = `gen_${Date.now()}`;
    const request = {
      id: requestId,
      status: 'pending',
      createdAt: new Date().toISOString(),
      unseenRatio,
      totalQuestions,
      uniqueSeen,
      needed: Math.min(needed, 50), // Cap at 50 per batch
      weakness: weakness || null,
      domains: domains || ['Workloads', 'ML', 'CV', 'NLP', 'GenAI'],
    };

    // Store as pending
    await context.env.AI900_KV.put('gen_request_pending', JSON.stringify(request), {
      expirationTtl: 86400, // Expires in 24h if never picked up
    });

    // Also store in history
    await context.env.AI900_KV.put(`gen_request_${requestId}`, JSON.stringify(request), {
      expirationTtl: 86400 * 7,
    });

    return json({ ok: true, status: 'queued', requestId });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// GET: Check if there's a pending generation request (for Claude Code polling)
export async function onRequestGet(context) {
  try {
    const pending = await context.env.AI900_KV.get('gen_request_pending');
    if (!pending) {
      return json({ ok: true, pending: false });
    }
    return json({ ok: true, pending: true, request: JSON.parse(pending) });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// DELETE: Mark request as fulfilled (called by generation script after completion)
export async function onRequestDelete(context) {
  try {
    const pending = await context.env.AI900_KV.get('gen_request_pending');
    if (pending) {
      const req = JSON.parse(pending);
      req.status = 'fulfilled';
      req.fulfilledAt = new Date().toISOString();
      await context.env.AI900_KV.put(`gen_request_${req.id}`, JSON.stringify(req), {
        expirationTtl: 86400 * 7,
      });
    }
    await context.env.AI900_KV.delete('gen_request_pending');
    return json({ ok: true, status: 'cleared' });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
