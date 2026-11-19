// Tablette pas encore reliée : le serveur la prévient quand son code change, au lieu qu'elle le relise sans arrêt
// (toutes les 4 s : données de la carte SIM et lectures pour rien sur une tablette qui attend allumée ; Tanguy, 19/11).
//
//   pairings/{code}.push   jeton de réveil de la tablette, écrit par elle à la création de son code (Sync.newPairing).
//   message                { type: 'jumelage', id: code }, « data » en priorité haute (Push.java : relecture tout de suite).
//
//   à la création du code  toujours un message : il prouve à la tablette que les réveils lui arrivent ; elle ne
//                          ralentit sa relecture qu'après l'avoir reçu (Sync.delaiJumelage). Envoyé après le
//                          jumelage automatique : une tablette déjà attendue par sa famille y entre aussitôt.
//   à la modification      seulement si ce que la tablette attend a changé : le statut (famille prête, annulé…)
//                          ou un nouvel ordre « carte SIM » de l'admin. Jamais pour ce qu'elle écrit elle-même (simTest).
//
// Sans jeton (anciennes versions, services Google absents) : rien à envoyer, la tablette relit comme avant.

const admin = require('firebase-admin');

const jeton = (p) => (p && typeof p.push === 'string' && p.push.length > 0 && p.push.length <= 4096 ? p.push : null);
const idOrdre = (p) => (p && p.ordre && p.ordre.id) || null;

// Faut-il prévenir la tablette de cette modification de son code ? (pure, testée)
function doitPrevenir(avant, apres) {
  if (!jeton(apres)) return false;
  if (!avant) return true;
  return (avant.status || null) !== (apres.status || null) || idOrdre(avant) !== idOrdre(apres);
}

// Envoie le réveil à la tablette du code. Renvoie true si le message est parti. Ne lève jamais : un réveil perdu
// ne doit pas faire échouer le jumelage (la tablette garde sa relecture de secours).
// `messagerie` : admin.messaging() (remplaçable dans les essais).
async function prevenir(code, p, { messagerie = () => admin.messaging(), logger = console } = {}) {
  const token = jeton(p);
  if (!token) return false;
  try {
    await messagerie().send({
      token,
      data: { type: 'jumelage', id: String(code) },
      android: { priority: 'high', ttl: 60_000, collapseKey: 'jumelage' },
    });
    return true;
  } catch (e) {
    logger.warn(`Jumelage : réveil non envoyé pour le code ${code}`, e && (e.code || e.message));
    return false;
  }
}

module.exports = { doitPrevenir, prevenir };
