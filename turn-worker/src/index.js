// Identifiants TURN Cloudflare pour les appels vidéo de Papote.
// La clé TURN reste ici (secret du Worker) ; les apps reçoivent des identifiants
// valables quelques heures, et seulement si elles sont connectées à Firebase.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const PROJECT = 'papote-famille';
const GOOGLE_KEYS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);
const TTL_SECONDS = 4 * 3600; // assez pour un long appel

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return json({ error: 'method' }, 405);

    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    try {
      await jwtVerify(token, GOOGLE_KEYS, {
        issuer: `https://securetoken.google.com/${PROJECT}`,
        audience: PROJECT,
      });
    } catch (e) {
      return json({ error: 'auth' }, 401);
    }

    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      },
    );
    if (!res.ok) return json({ error: 'turn', status: res.status }, 502);
    const data = await res.json();
    const servers = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    // Le port 53 est souvent bloqué et ralentit Chrome : on le retire.
    const iceServers = servers.map((s) => ({
      ...s,
      urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),
    }));
    return json(iceServers);
  },
};
