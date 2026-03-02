// Cloudflare Pages Function: /api/backup
// POST: Save learning progress (sessions + history) to KV
// GET: Restore learning progress from KV

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { sessions, history } = body;

    if (!Array.isArray(sessions) || !Array.isArray(history)) {
      return json({ ok: false, error: 'sessions and history must be arrays' }, 400);
    }

    const backup = {
      sessions,
      history,
      savedAt: new Date().toISOString(),
      sessionCount: sessions.length,
      historyCount: history.length,
    };

    // Store backup (90 day TTL)
    await context.env.AI900_KV.put('user_backup', JSON.stringify(backup), {
      expirationTtl: 86400 * 90,
    });

    // Signal for daemon: new data available
    await context.env.AI900_KV.put('last_backup_at', backup.savedAt);

    // Trigger trainer via Cloudflare Tunnel (fire-and-forget, non-blocking)
    const tunnelUrl = await context.env.AI900_KV.get('trainer_tunnel_url');
    if (tunnelUrl) {
      context.waitUntil(
        fetch(`${tunnelUrl}/trigger`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'session_complete', savedAt: backup.savedAt }),
        }).catch(() => {}) // Silent fail if trainer is offline
      );
    }

    return json({
      ok: true,
      savedAt: backup.savedAt,
      sessionCount: backup.sessionCount,
      historyCount: backup.historyCount,
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

export async function onRequestGet(context) {
  try {
    const raw = await context.env.AI900_KV.get('user_backup');
    if (!raw) {
      return json({ ok: true, found: false });
    }
    const backup = JSON.parse(raw);
    return json({
      ok: true,
      found: true,
      savedAt: backup.savedAt,
      sessions: backup.sessions,
      history: backup.history,
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
