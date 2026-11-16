// Garde-fou des outils qui vident ou réécrivent la base (audit sauvegardes du 12/11, N4) : repartir-des-tests et
// migrer-europe refusent de tourner dès qu'une commande payée avec la clé réelle de Stripe existe (vrais clients).
// Le webhook note livemode: true sur chaque commande payée en clé réelle (functions/index.js, paiementTermine).
// Une seule requête, au plus 5 documents lus.

async function commandesReelles(db, max = 5) {
  const snap = await db.collection('commandes').where('livemode', '==', true).limit(max).get();
  return snap.docs;
}

// true (et le message d'arrêt affiché) si l'outil doit s'arrêter.
async function refuserSiCommandesReelles(db, outil) {
  const docs = await commandesReelles(db);
  if (!docs.length) return false;
  const base = db.databaseId || '(default)';
  console.error(`\nARRÊT : ${outil} refuse de tourner. La base « ${base} » contient ${docs.length === 5 ? 'au moins 5' : docs.length} commande(s) payée(s) avec la clé réelle de Stripe (de vrais clients) :`);
  for (const d of docs) console.error(`  ${d.get('code') || d.id} · ${d.get('nom') || d.get('email') || '?'} · ${d.get('expedition') || '?'}`);
  console.error('Cet outil efface ou réécrit la base : il ne sert qu\'avant la première vente. Rien n\'a été changé.');
  return true;
}

module.exports = { commandesReelles, refuserSiCommandesReelles };
