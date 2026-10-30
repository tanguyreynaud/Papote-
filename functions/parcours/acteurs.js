// Ce que font les personnes et les appareils du parcours client, joué contre la simulation :
// Tanguy dans l'admin, le client sur le site vitrine, la tablette, les proches dans l'appli famille.
// Chaque geste reprend les appels et écritures du vrai code (web/js/admin.js, famille.js, la tablette).

const s = require('./simulation');
const { createHash, randomBytes } = require('node:crypto');

const RELAIS = {
  relais: 'FR-012345', rnom: 'Tabac de la Place', radr: '1 place de la Mairie', rcp: '07310',
  rville: 'SAINT MARTIN DE VALAMAS', rpays: 'FR', rdest: 'Paul Martin',
  // Adresse du proche, couverture 4G vérifiée par commander (très bonne ici, carte ARCEP 2026_T2).
  padr: '2 place de l\'Église 07310 Saint-Martin-de-Valamas', plat: '44.9369', plon: '4.3683',
};

// ---------- Tanguy : stock et admin ----------

const TANGUY = { uid: 'tanguy-admin', email: 'tanguy@mapapote.fr', prenom: 'Tanguy', admin: true };
let numero = 0;

// Tablette installée par installer-tablette.ps1 : fiche « Préparée » avec son n° T-…, n° de série Android,
// et clé App Check reliée au compte de la tablette (cle-tablette.js puis jetonAppCheck).
async function tablettePreparee() {
  numero += 1;
  const serie = `SERIE${String(numero).padStart(4, '0')}${randomBytes(2).toString('hex')}`;
  const t = {
    serie,
    tabletUid: `tablette-${serie}`,
    callsUid: `appels-${serie}`,
    ref: `T-${String(numero).padStart(3, '0')}`,
  };
  const fiche = await s.db.collection('stock').add({
    ref: t.ref, serieAndroid: serie, numero: serie, modele: 'Blackview Tab 60 Pro', etat: 'preparee', commande: null,
    prixAchat: 12000, acheteeLe: s.Timestamp.now(), preparee: Date.now(), fournisseur: 'Cdiscount',
    historique: [{ le: Date.now(), etat: 'preparee', par: 'installation' }], creeLe: s.FieldValue.serverTimestamp(),
  });
  t.fiche = fiche.id;
  const cle = randomBytes(32).toString('base64url');
  await s.db.doc(`clesTablettes/${createHash('sha256').update(cle).digest('hex')}`).set({
    serie, tabletUid: t.tabletUid, creeLe: s.FieldValue.serverTimestamp(),
  });
  return t;
}

// Carte SIM Lyca reliée à la tablette dans Stock, Cartes SIM : obligatoire avant le premier envoi (offre tout compris).
async function simSurTablette(tablette) {
  numero += 1;
  const { id } = await s.appeler('gestionSim', { action: 'ajouter', champs: {
    statut: 'active', operateur: 'Lyca', numero: `07 45 ${String(numero).padStart(2, '0')} 77 17`, prix: 499, tablette: tablette.fiche,
  } }, TANGUY);
  return id;
}

// « Préparer l'envoi » dans l'admin (web/js/admin.js, etapesEnvoi), étape par étape, puis « Colis déposé ».
async function preparerEtEnvoyer(commande, tablette, suivi = '12345678') {
  await s.appeler('gestionStock', { action: 'modifier', id: tablette.fiche, champs: { commande } }, TANGUY);
  if (!(await s.lire(`stock/${tablette.fiche}`)).simId) await simSurTablette(tablette);
  const faits = {};
  for (const cle of ['tablette', 'carton', 'enceinte-choix', 'fermer', 'feutre', 'etiquette']) {
    faits[cle] = Date.now();
    await s.appeler('gestionParcours', {
      type: 'envoi', commande, preparation: { etape: Object.keys(faits).length, faits, tablette: tablette.fiche, enceinte: 'non', suivi },
    }, TANGUY);
  }
  await s.appeler('tabletteEnvoyee', { commande, suivi }, TANGUY);
  await s.appeler('gestionStock', { action: 'modifier', id: tablette.fiche, champs: { etat: 'envoyee', commande } }, TANGUY);
  await s.calme();
}

// ---------- Le client sur le site vitrine ----------

// commande.html → « Payer » : la fonction commander ouvre la page Stripe. Renvoie l'id de la session.
async function commanderSurLeSite({ formule = 'sim', email, accord = true, essai = true } = {}) {
  const r = await s.requete('commander', {
    query: { formule, tablette: 'incluse', ...RELAIS, ...(email ? { email } : {}), ...(accord ? { accord: '1' } : {}), ...(essai ? { essai: '' } : {}) },
  });
  if (r.statut !== 303 || !/checkout\.stripe\.test\/cs_/.test(r.redirection || '')) {
    throw new Error(`commander n'a pas ouvert le paiement : ${r.statut} ${r.redirection || r.texte}`);
  }
  return r.redirection.split('/').pop();
}

// Commande + paiement : renvoie { session, abonnement } (abonnement = id de la commande).
async function commanderEtPayer({ email, nom = 'Paul Martin', formule = 'sim', sepaEnAttente = false } = {}) {
  const session = await commanderSurLeSite({ formule, email });
  const { abonnement } = s.stripe.payerSession(session, { email, nom, sepaEnAttente });
  await s.calme();
  return { session, abonnement };
}

// ---------- La tablette ----------

// La tablette affiche son QR code (écran Bienvenue) : pairings/{code} « waiting ».
async function afficherCode(t) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const code = Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
  await s.db.doc(`pairings/${code}`).set({
    status: 'waiting', tabletUid: t.tabletUid, callsUid: t.callsUid, name: 'Tablette', serie: t.serie,
    expiresAt: s.Timestamp.fromMillis(Date.now() + 20 * 60 * 1000), createdAt: s.FieldValue.serverTimestamp(),
  });
  t.code = code;
  await s.calme();
  return code;
}

// Pairing « confirmed » : la tablette entre dans la famille avec ses deux comptes (Sync.java).
async function entrerDansLaFamille(t) {
  const p = await s.lire(`pairings/${t.code}`);
  if (!p || p.status !== 'confirmed' || !p.fid) throw new Error(`La tablette n'est pas confirmée (${p && p.status})`);
  t.fid = p.fid;
  for (const uid of [t.tabletUid, t.callsUid]) {
    await s.db.doc(`families/${p.fid}/members/${uid}`).create({
      name: 'Tablette', role: 'tablette', pairing: t.code, canCall: true, joinedAt: s.FieldValue.serverTimestamp(),
    });
  }
  await s.calme();
  return p.fid;
}

// La tablette appelle (bouton d'un proche, ou SOS : toute la famille). Renvoie l'id de l'appel.
async function appelerDepuisLaTablette(t, { vers = null, sos = 0 } = {}) {
  const ref = s.db.collection(`families/${t.fid}/calls`).doc();
  await ref.set({
    callerUid: t.callsUid, callerName: 'Mamie Emma', calleeUid: sos ? null : vers ? vers.uid : null,
    calleeName: sos ? (sos === 2 ? 'SOS 2' : 'SOS') : vers ? vers.prenom : null,
    state: 'ringing', offer: null, answer: null, createdAt: s.FieldValue.serverTimestamp(), endedAt: null,
  });
  await s.calme();
  return ref.id;
}

// ---------- Les proches dans l'appli famille ----------

// Installation complète depuis le téléphone (famille.js) : scan, prénom, nom, photo, son, « C'est parfait ».
async function installer(proche, t, { nom = 'Mamie Emma' } = {}) {
  const r = await s.appeler('reserverTablette', { code: t.code, prenom: proche.prenom }, proche);
  if (r.etat !== 'reserve') throw new Error(`Réservation refusée : ${JSON.stringify(r)}`);
  await s.appeler('nommerFamille', { reveil: true }, proche);
  const { fid } = await s.appeler('nommerFamille', { code: t.code, nom }, proche);
  await s.calme();
  await entrerDansLaFamille(t);
  await envoyer(proche, fid, 'photo');
  // Test du son : commande lue par la tablette, puis réglages enregistrés sur la famille.
  await s.db.collection(`families/${fid}/commands`).add({
    type: 'son', quoi: 'sonnerie', volume: 100, target: t.callsUid, createdBy: proche.uid,
    createdAt: s.FieldValue.serverTimestamp(), state: 'pending',
  });
  await s.db.doc(`families/${fid}`).update({ volume: 80, volumeSonnerie: 100, rev: s.FieldValue.increment(1) });
  await s.appeler('finirInstallation', { fid }, proche);
  await s.calme();
  return fid;
}

// Un envoi depuis l'appli : photo, message ou vidéo (fichier dans families/{fid}/media/).
async function envoyer(proche, fid, type, texte = null) {
  const id = s.db.collection('x').doc().id;
  const fichier = type === 'message' ? {} : { storagePath: `families/${fid}/media/${id}.${type === 'video' ? 'mp4' : 'jpg'}` };
  const ref = await s.db.collection(`families/${fid}/posts`).add({
    type, authorUid: proche.uid, authorName: proche.prenom, createdAt: s.FieldValue.serverTimestamp(),
    text: texte || (type === 'message' ? 'Bisous de Lyon !' : ''), seenAt: null, hearts: 0, ...fichier,
  });
  await s.calme();
  return ref.id;
}

// Un proche rejoint la famille avec le code famille (entrée directe, comme une invitation acceptée).
async function rejoindre(proche, fid, { attente = false } = {}) {
  const fam = await s.lire(`families/${fid}`);
  await s.db.doc(`families/${fid}/members/${proche.uid}`).set({
    name: proche.prenom, role: 'famille', code: fam.code, joinedAt: s.FieldValue.serverTimestamp(),
    uid: proche.uid, email: proche.email, status: attente ? 'pending' : 'active', canCall: true,
  });
}

module.exports = {
  RELAIS, TANGUY, tablettePreparee, simSurTablette, preparerEtEnvoyer, commanderSurLeSite, commanderEtPayer,
  afficherCode, entrerDansLaFamille, appelerDepuisLaTablette, installer, envoyer, rejoindre,
};
