// Cloudflare Pages Function: /api/status
// Ultra-lightweight endpoint for daemon polling.
// Returns only timestamps (few bytes) so daemon knows if work is needed.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export async function onRequestGet(context) {
  try {
    const [lastBackup, lastAnalyzed] = await Promise.all([
      context.env.AI900_KV.get('last_backup_at'),
      context.env.AI900_KV.get('last_analyzed_at'),
    ]);
    return json({
      lastBackupAt: lastBackup || null,
      lastAnalyzedAt: lastAnalyzed || null,
      needsAnalysis: lastBackup && (!lastAnalyzed || lastBackup > lastAnalyzed),
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// PUT: Trainer stores tunnel URL or marks analysis done
export async function onRequestPut(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    if (body.tunnelUrl) {
      await context.env.AI900_KV.put('trainer_tunnel_url', body.tunnelUrl);
    }
    await context.env.AI900_KV.put('last_analyzed_at', new Date().toISOString());
    return json({ ok: true });
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
