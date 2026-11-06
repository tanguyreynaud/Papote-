// Famille préparée dès la commande (Tanguy, 29/10 puis 05/11) : offre unique tout compris, la tablette part
// déjà reliée à sa famille.
//
//   creer            paiement reçu d'une commande du site : la famille est créée tout de suite, avec la commande,
//                    et celui qui a payé y est invité (e-mail de confirmation). Plus de recherche de la famille
//                    par l'e-mail du client : un ancien client qui recommande avait sa commande reliée à son
//                    ancienne famille (audit A14-1).
//   jumeler          la tablette affiche son code (pairings/{code} « waiting ») : si c'est la tablette reliée à
//                    une commande envoyée dont la famille est préparée, le serveur confirme lui-même le jumelage.
//                    La tablette entre dans sa famille sans que personne ne scanne (Sync.java : « confirmed »).
//                    Le QR code ne sert plus qu'aux anciennes commandes et aux tablettes sans commande.
//   proprietaire     le premier proche qui entre dans une famille préparée sans responsable (celui qui a payé,
//                    par son invitation, ou avec le code famille de l'e-mail) en devient le responsable.
//   nommer           « Comment appelez-vous la personne ? » dans l'appli, la première fois.
//
// families/{fid}.installation = { etape: 'fini', preparee: true, commande } ; nomAChoisir: true tant que
// la famille porte le nom d'attente. La tablette ne montre donc jamais les écrans d'installation.

const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { regles: installation } = require('./installation');

// Tablette perdue ou hors service : jamais plus jumelée (même liste que gestion.js).
const ETATS_BLOQUES = ['perdue', 'hors-service'];
// Nom d'attente, jusqu'à ce que le responsable donne le vrai dans l'appli.
const NOM_D_ATTENTE = 'Votre proche';
// Délai laissé à la tablette pour écrire ses fiches membres (même valeur que installation.js).
const ENTREE_TABLETTE_MS = 20 * 60 * 1000;

// Commande du site qui reçoit une famille préparée (pure, testée) : ni abonnement pris dans l'appli
// (famille déjà connue), ni reprise, ni commande annulée, et pas déjà reliée.
function prepareePour(commande, meta = {}) {
  if (!commande || commande.fid) return false;
  if (meta.fid || meta.dejaInstallee === '1' || meta.reprise === '1') return false;
  if (commande.offerte || commande.expedition === 'annulee') return false;
  return true;
}

// La tablette de cette commande est-elle chez sa famille ? Famille préparée : la commande a son fid dès le
// paiement, c'est l'entrée de la tablette qui compte (tabletteRelieeLe). Avant : la commande reliée (pure, testée).
function tabletteDansLaFamille(commande) {
  if (!commande) return false;
  return commande.famillePreparee ? !!commande.tabletteRelieeLe : !!commande.fid;
}

// Que faire du code qu'une tablette vient d'afficher (pure, testée).
// fiche : sa fiche stock (ou null) ; commande : la commande de la fiche ; famille : la famille de la commande.
// → { etat: 'jumeler', fid } ou { etat: <raison de ne rien faire> }.
function decisionJumelage({ fiche, commande, famille }) {
  if (!fiche) return { etat: 'inconnue' };
  if (ETATS_BLOQUES.includes(fiche.etat)) return { etat: 'bloquee' };
  if (!fiche.commande || !commande) return { etat: 'sans-commande' };
  if (!commande.fid || !famille) return { etat: 'sans-famille' };
  if (!(famille.installation && famille.installation.preparee)) return { etat: 'pas-preparee' };
  // Pas avant le départ du colis : une tablette allumée chez Tanguy pendant la préparation reste hors famille.
  if (commande.expedition !== 'envoyee') return { etat: 'pas-envoyee' };
  if (fiche.fid && fiche.fid !== commande.fid) return { etat: 'autre-famille' };
  return { etat: 'jumeler', fid: commande.fid };
}

// La fiche stock de la tablette qui a écrit ce jumelage : par son compte, ou par son n° de série prouvé.
// Le n° de série est écrit par la tablette elle-même dans pairings/ : n'importe quel compte pourrait y mettre
// celui d'une tablette livrée et récupérer la famille. On ne le croit que si la clé App Check posée à
// l'installation de CE n° de série est reliée au même compte (appcheck.js, jetonAppCheck).
async function ficheDeLaTablette(db, p, logger) {
  const par = async (champ, valeur) => (valeur
    ? (await db.collection('stock').where(champ, '==', valeur).limit(1).get()).docs[0] || null : null);
  const connue = await par('tabletUid', p.tabletUid);
  if (connue || !p.serie) return connue;
  if (!(await serieProuvee(db, p.serie, p.tabletUid))) {
    if (logger) logger.warn(`Jumelage : n° de série ${p.serie} non prouvé pour le compte ${p.tabletUid || '?'}, ignoré.`);
    return null;
  }
  return par('serieAndroid', p.serie);
}

async function serieProuvee(db, serie, tabletUid) {
  if (!tabletUid) return false;
  const cles = await db.collection('clesTablettes').where('serie', '==', serie).get();
  return cles.docs.some((d) => d.get('tabletUid') === tabletUid);
}

// deps : { db, logger, villeAvecCoordonnees? }
function brancher({ db, logger, villeAvecCoordonnees = installation.villeAvecCoordonnees }) {
  // Famille créée au paiement, dans la même transaction que la commande qui la reçoit : un message Stripe
  // reçu deux fois ne crée jamais deux familles. Renvoie le fid (le même au deuxième passage), ou null.
  async function creer(commandeRef, meta = {}) {
    const avant = (await commandeRef.get()).data();
    if (!prepareePour(avant, meta)) return (avant && avant.fid) || null;
    const ville = await villeAvecCoordonnees(installation.villeDuRelais(avant), avant.livraison && avant.livraison.cp);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(commandeRef);
      const c = snap.data();
      if (!prepareePour(c, meta)) return (c && c.fid) || null;
      let invite = installation.codeAuHasard();
      for (let i = 0; i < 5 && (await tx.get(db.doc(`invites/${invite}`))).exists; i++) invite = installation.codeAuHasard();
      const famille = db.collection('families').doc();
      const email = c.email ? String(c.email).toLowerCase() : null;
      tx.set(famille, {
        name: NOM_D_ATTENTE, nomAChoisir: true, code: invite, createdBy: null, createdAt: FieldValue.serverTimestamp(),
        proprietaireEmail: email, options: installation.OPTIONS_PAR_DEFAUT, volumeSonnerie: 100, rev: 1,
        // Remplacé tout de suite par l'abonnement de la commande (appliquer, juste après).
        abonnement: { statut: 'installation', majLe: FieldValue.serverTimestamp() },
        ...(ville ? { meteoVille: ville } : {}),
        installation: { etape: 'fini', preparee: true, commande: commandeRef.id, debut: FieldValue.serverTimestamp() },
      });
      tx.set(db.doc(`invites/${invite}`), { fid: famille.id, createdBy: null });
      // Celui qui a payé entre directement (appli : « Mes invitations »), sans attendre qu'on l'accepte.
      if (email) {
        tx.set(famille.collection('invitations').doc(email), {
          email, fid: famille.id, familyName: NOM_D_ATTENTE, invitedBy: 'Papote', preparee: true,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(commandeRef, { fid: famille.id, famillePreparee: true });
      return famille.id;
    });
  }

  // Nouveau code affiché par une tablette : jumelage confirmé par le serveur si elle part vers une famille préparée.
  async function jumeler(ref, p) {
    if (!p || p.status !== 'waiting') return { etat: 'ignore' };
    const fiche = await ficheDeLaTablette(db, p, logger);
    const t = fiche ? fiche.data() : null;
    const commande = t && t.commande ? (await db.doc(`commandes/${t.commande}`).get()).data() || null : null;
    const famille = commande && commande.fid ? (await db.doc(`families/${commande.fid}`).get()).data() || null : null;
    const d = decisionJumelage({ fiche: t, commande, famille });
    if (d.etat !== 'jumeler') {
      if (d.etat === 'bloquee') logger.warn(`Jumelage ${ref.id} : tablette ${t.ref || fiche.id} ${t.etat}, pas de famille.`);
      return d;
    }
    const fait = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.get('status') !== 'waiting') return false;
      tx.update(ref, {
        status: 'confirmed', fid: d.fid, auto: true,
        // Nom d'attente : la tablette garde son nom « Tablette » plutôt que « Votre proche ».
        familyName: famille.nomAChoisir ? '' : (famille.name || ''), claimedName: '',
        reservedAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + ENTREE_TABLETTE_MS),
      });
      // Plus de rappel « votre tablette vous attend » (rappelsJumelage) : elle est dans sa famille.
      tx.update(db.doc(`commandes/${t.commande}`), { tabletteRelieeLe: FieldValue.serverTimestamp() });
      return true;
    });
    if (fait) logger.info(`Jumelage ${ref.id} : tablette ${t.ref || fiche.id} entrée seule dans la famille ${d.fid}.`);
    return fait ? d : { etat: 'deja-pris' };
  }

  // Le premier proche qui entre dans une famille préparée sans responsable en devient le responsable :
  // celui qui a payé (invitation), ou celui à qui il a passé le code famille de l'e-mail (fiche « pending »,
  // acceptée d'office : il n'y a encore personne pour l'accepter). Renvoie true si ce membre est devenu responsable.
  async function proprietaire(fid, uid) {
    const famRef = db.doc(`families/${fid}`);
    const membreRef = famRef.collection('members').doc(uid);
    return db.runTransaction(async (tx) => {
      const [fam, membre] = await Promise.all([tx.get(famRef), tx.get(membreRef)]);
      if (!fam.exists || !membre.exists || fam.get('createdBy')) return false;
      if (!(fam.get('installation') || {}).preparee || membre.get('role') !== 'famille') return false;
      tx.update(famRef, { createdBy: uid, rev: FieldValue.increment(1) });
      if (fam.get('code')) tx.set(db.doc(`invites/${fam.get('code')}`), { createdBy: uid }, { merge: true });
      if (membre.get('status') === 'pending') tx.update(membreRef, { status: 'active' });
      return true;
    });
  }

  // « Comment appelez-vous la personne ? » : le responsable donne le nom de la famille préparée.
  // La fiche de la tablette (déjà entrée sous le nom « Tablette ») prend aussi ce nom, comme à l'installation.
  async function nommer(fid, uid, saisie) {
    const nom = typeof saisie === 'string' ? saisie.replace(/\s+/g, ' ').trim() : '';
    if (!nom || nom.length > 40) throw new HttpsError('invalid-argument', 'Indiquez comment vous appelez la personne (40 caractères au plus).');
    const famRef = db.doc(`families/${fid}`);
    const fam = (await famRef.get()).data();
    if (!fam) throw new HttpsError('not-found', 'Famille introuvable.');
    if (fam.createdBy !== uid && !(fam.admins || []).includes(uid)) {
      throw new HttpsError('permission-denied', 'Réservé aux responsables de la famille.');
    }
    const tablettes = await famRef.collection('members').where('role', '==', 'tablette').get();
    const lot = db.batch();
    lot.update(famRef, { name: nom, nomAChoisir: FieldValue.delete(), rev: FieldValue.increment(1) });
    tablettes.docs.forEach((d) => lot.update(d.ref, { name: nom }));
    await lot.commit();
    return { ok: true };
  }

  // Secours : tablette pas reconnue (n° de série non prouvé, donc pas de jumelage tout seul) scannée par le
  // responsable d'une famille préparée encore sans tablette. Elle entre dans cette famille plutôt que d'en
  // créer une deuxième à côté de la commande. Une seule famille possible, sinon l'installation habituelle.
  async function familleDuScan(uid, p) {
    if (!p || p.status !== 'waiting') return null;
    if (await ficheDeLaTablette(db, p, null)) return null; // tablette du stock : jumeler() s'en occupe
    const familles = await db.collection('families').where('createdBy', '==', uid).where('installation.preparee', '==', true).get();
    const libres = [];
    for (const f of familles.docs) {
      const tablettes = await f.ref.collection('members').where('role', '==', 'tablette').limit(1).get();
      if (tablettes.empty) libres.push(f);
    }
    if (libres.length !== 1) return null;
    const f = libres[0];
    return { fid: f.id, nom: f.get('nomAChoisir') ? '' : (f.get('name') || ''), commande: (f.get('installation') || {}).commande || null };
  }

  // Fiche de la tablette écrite après le nom : jumelée quand la famille portait encore le nom d'attente, elle
  // s'appelle « Tablette » (Sync.java) alors que nommer() est déjà passé. Elle prend le nom de la famille.
  async function nomDeLaTablette(fid, uid) {
    const famRef = db.doc(`families/${fid}`);
    const membreRef = famRef.collection('members').doc(uid);
    return db.runTransaction(async (tx) => {
      const [fam, membre] = await Promise.all([tx.get(famRef), tx.get(membreRef)]);
      if (!fam.exists || !membre.exists || membre.get('role') !== 'tablette') return false;
      if (!(fam.get('installation') || {}).preparee || fam.get('nomAChoisir') || !fam.get('name')) return false;
      if (membre.get('name') === fam.get('name')) return false;
      tx.update(membreRef, { name: fam.get('name') });
      return true;
    });
  }

  return { creer, jumeler, proprietaire, nommer, familleDuScan, nomDeLaTablette };
}

module.exports = {
  brancher, ficheDeLaTablette, serieProuvee,
  regles: { prepareePour, tabletteDansLaFamille, decisionJumelage, ETATS_BLOQUES, NOM_D_ATTENTE },
};
