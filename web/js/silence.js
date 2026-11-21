// Silence toléré avant de dire « la tablette ne répond plus » : même règle que le serveur (functions/alertes.js,
// etatAlerte). Le jour, la tablette se signale toutes les 30 min : 1 h 10. Pendant la veille de la famille
// (families/{fid}.veille, 23 h-5 h par défaut), toutes les 2 h pour ménager la carte SIM (Tanguy, 21/11) : 3 h, et
// encore 30 min après le réveil, le temps du premier tour du matin. Heure de Paris, comme le serveur.
export const SILENCE_JOUR_MS = 70 * 60_000;
export const SILENCE_NUIT_MS = 3 * 3600_000;
const GRACE_MATIN_MS = 30 * 60_000;

function minutesParis(ms) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(ms)).split(':').map(Number);
  return h * 60 + m;
}

// Réglage borné comme le serveur (veille.js, veilleSure) : coucher 19 h-23 h 30, réveil 5 h-10 h, défaut 23 h-5 h.
function bornesVeille(v) {
  const lire = (h, m, defaut) => (Number.isInteger(h) && h >= 0 && h <= 23 ? h * 60 + (m === 30 ? 30 : 0) : defaut);
  const borner = (t, min, max) => Math.min(max, Math.max(min, t));
  const o = v && typeof v === 'object' ? v : {};
  return {
    active: o.active !== false,
    de: borner(lire(o.de, o.deMin, 23 * 60), 19 * 60, 23 * 60 + 30),
    a: borner(lire(o.a, o.aMin, 5 * 60), 5 * 60, 10 * 60),
  };
}

export function enVeilleParis(veille, ms) {
  const v = bornesVeille(veille);
  if (!v.active) return false;
  const t = minutesParis(ms);
  if (v.de < v.a) return t >= v.de && t < v.a;
  if (v.de > v.a) return t >= v.de || t < v.a;
  return false;
}

export function silenceTolereMs(veille, maintenant = Date.now()) {
  return enVeilleParis(veille, maintenant) || enVeilleParis(veille, maintenant - GRACE_MATIN_MS)
    ? SILENCE_NUIT_MS : SILENCE_JOUR_MS;
}
