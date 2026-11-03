// Installation d'une nouvelle tablette depuis le téléphone du premier proche (parcours du 21/10).
//
//   reserverTablette   appel depuis l'appli famille : le proche scanne le code affiché par la tablette ;
//                      la tablette lui est réservée (transaction : un seul gagnant, sans minuterie).
//   nommerFamille      appel depuis l'appli famille : « Comment l'appelez-vous ? » crée la famille,
//                      avec les options par défaut et la ville du point relais pour la météo.
//   finirInstallation  appel depuis l'appli famille : « C'est parfait » ; les proches qui ont scanné
//                      pendant l'installation reçoivent une invitation par e-mail.
//
// pairings/{code} : 'waiting' (écrit par la tablette) → 'reserved' (claimedBy, claimedName) →
// 'confirmed' (fid, familyName) ; la tablette entre alors dans la famille sans rien demander.
// 'cancelled' : la tablette a touché « Recommencer avec un autre téléphone ».
// Interface avec la tablette : /mnt/project-files/notes/interface-installation.md.

const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// Délai laissé à la tablette pour écrire ses fiches membres après la confirmation (règle Firestore).
const ENTREE_TABLETTE_MS = 20 * 60 * 1000;
// Proches gardés en attente d'invitation pendant une installation.
const ATTENTE_MAX = 10;
const ETAPES = ['photo', 'son', 'options', 'fini'];
// Installation pas finie 30 minutes après le scan : le prochain proche qui scanne la reprend (Tanguy, 21/10).
const REPRISE_MS = 30 * 60 * 1000;
// Fin d'installation sans commande reliée : tolérance avant la pause (abonnement.js, B3).
const { TOLERANCE_INSTALLATION_MS: TOLERANCE_MS } = require('./abonnement');

// Options montrées déjà réglées dans le récapitulatif (document du parcours, 21/10).
const OPTIONS_PAR_DEFAUT = Object.freeze({
  sos: true, lecture: true, rappelsAccueil: true, meteo: true, radio: { active: false },
});
const VOLUME_SONNERIE = 100;

const ms = (v) => (v == null ? null : typeof v === 'number' ? v : v.toMillis ? v.toMillis() : null);

function normaliserCode(saisie) {
  const c = String(saisie || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{8}$/.test(c) ? c : null;
}

function texteCourt(v, max = 40) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t && t.length <= max ? t : null;
}

// Que faire quand un compte scanne le code d'une tablette (pure, testée).
// p : pairing (ou null) ; uid : le compte qui scanne ; maintenant : ms ; finie : installation de la famille finie.
// → { etat: 'reserver' | 'reprendre' | 'reprise' | 'occupe' | 'inconnu' | 'expire', par?, fid? }
function decisionScan(p, uid, maintenant, finie = false) {
  if (!p) return { etat: 'inconnu' };
  const moi = p.claimedBy === uid;
  if (p.status === 'waiting') {
    return (ms(p.expiresAt) || 0) > maintenant ? { etat: 'reserver' } : { etat: 'expire' };
  }
  if (p.status === 'reserved' || p.status === 'confirmed') {
    if (moi) return { etat: 'reprendre', fid: p.fid || null };
    const depuis = ms(p.reservedAt);
    if (!finie && depuis != null && maintenant - depuis >= REPRISE_MS) return { etat: 'reprise', fid: p.fid || null };
    return { etat: 'occupe', par: p.claimedName || null };
  }
  // claimed (ancien parcours), cancelled, refused : la tablette affichera un nouveau code.
  return { etat: 'expire' };
}

// Ville de la météo depuis le point relais de la commande : { nom } ou null.
function villeDuRelais(commande) {
  // « LYON 06 » ou « VALENCE CEDEX 9 » : la météo cherche la ville seule.
  const brute = commande && commande.livraison && texteCourt(commande.livraison.ville, 80);
  const ville = brute && brute.replace(/(\s+cedex)?(\s+\d+)?$/i, '').trim();
  if (!ville) return null;
  // Mondial Relay écrit les villes en majuscules : « SAINT MARTIN DE VALAMAS » → « Saint Martin De Valamas ».
  const nom = ville === ville.toUpperCase()
    ? ville.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, sep, l) => sep + l.toUpperCase())
    : ville;
  return { nom };
}

// Coordonnées de la commune du point relais (geo.api.gouv.fr, par code postal), pour une météo juste
// même quand plusieurs communes portent le même nom. Sans réponse : le nom seul (la tablette cherche).
async function villeAvecCoordonnees(ville, cp, chercher = fetch) {
  if (!ville || !/^\d{5}$/.test(String(cp || ''))) return ville;
  const simple = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  try {
    const r = await chercher(`https://geo.api.gouv.fr/communes?codePostal=${cp}&fields=nom,centre&format=json`,
      { signal: AbortSignal.timeout(2500) });
    const communes = (await r.json()).filter((c) => c.centre && c.centre.coordinates);
    const c = communes.find((x) => simple(x.nom) === simple(ville.nom)) || (communes.length === 1 ? communes[0] : null);
    if (!c) return ville;
    const [lon, lat] = c.centre.coordinates;
    return { nom: c.nom.slice(0, 80), lat, lon };
  } catch (e) {
    return ville;
  }
}

function codeAuHasard() {
  const bytes = require('node:crypto').randomBytes(8);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

// deps : { db, compteVerifie, envoyerMail, mail, appli, logger, stockage, relierParEmail, prevenirPapote, notifier }
function brancher(deps) {
  const { db, compteVerifie, envoyerMail, mail, appli, logger, stockage, relierParEmail, prevenirPapote, notifier } = deps;

  async function reserverTablette(request) {
    const { uid, email } = compteVerifie(request);
    const code = normaliserCode(request.data && request.data.code);
    const prenom = texteCourt(request.data && request.data.prenom);
    if (!code) throw new HttpsError('invalid-argument', 'Le code de la tablette a 8 caractères.');
    if (!prenom) throw new HttpsError('invalid-argument', 'Votre prénom est demandé.');
    const ref = db.doc(`pairings/${code}`);
    const r = await reserver(ref, { uid, email, prenom });
    // Installation reprise : le premier proche est prévenu sur son téléphone (B2).
    if (r.reprise && r.fid && notifier) {
      await notifier(r.fid, [r.reprise], {
        type: 'alerte', titre: `${prenom} a repris l'installation`, fid: r.fid,
        texte: `L'installation de la tablette${r.nomFamille ? ` de ${r.nomFamille}` : ''} continue sur son téléphone. Vous restez responsable de la famille.`,
      }).catch((e) => logger.error(`Installation ${code} : premier proche non prévenu`, e.message));
    }
    return { etat: r.etat, ...(r.fid !== undefined ? { fid: r.fid } : {}), ...(r.par !== undefined ? { par: r.par } : {}) };
  }

  async function reserver(ref, { uid, email, prenom }) {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const p = snap.exists ? snap.data() : null;
      const famRef = p && p.fid ? db.doc(`families/${p.fid}`) : null;
      const fam = famRef ? (await tx.get(famRef)).data() : null;
      const finie = !!(famRef && (!fam || !fam.installation || fam.installation.etape === 'fini'));
      const d = decisionScan(p, uid, Date.now(), finie);
      if (d.etat === 'reprise') {
        // Le premier proche s'est arrêté en route : ce compte reprend, rien n'est effacé. Le premier reste
        // responsable de la famille et en est prévenu (B2, Tanguy 2026-10-27) : il garde la main sur l'abonnement.
        tx.update(ref, {
          claimedBy: uid, claimedName: prenom, claimedEmail: email, reservedAt: FieldValue.serverTimestamp(),
          attente: (p.attente || []).filter((a) => a.uid !== uid),
        });
        if (famRef) {
          const admins = (fam && fam.admins) || [];
          tx.update(famRef, {
            createdBy: uid, rev: FieldValue.increment(1),
            ...(p.claimedBy && !admins.includes(p.claimedBy) && admins.length < 10 ? { admins: [...admins, p.claimedBy] } : {}),
          });
          tx.set(famRef.collection('members').doc(uid), {
            name: prenom, role: 'famille', code: fam.code || null, joinedAt: FieldValue.serverTimestamp(),
            uid, email, status: 'active', canCall: true,
          }, { merge: true });
        }
        logger.info(`Installation ${ref.id} reprise par ${uid} (avant : ${p.claimedBy})`);
        return { etat: 'reserve', fid: d.fid, reprise: p.claimedBy || null, nomFamille: (fam && fam.name) || null };
      }
      if (d.etat === 'reserver') {
        tx.update(ref, {
          status: 'reserved', claimedBy: uid, claimedName: prenom, claimedEmail: email,
          reservedAt: FieldValue.serverTimestamp(),
        });
        return { etat: 'reserve' };
      }
      if (d.etat === 'reprendre') return { etat: 'reserve', fid: d.fid };
      if (d.etat === 'occupe') {
        // Gardé pour l'inviter à la fin de l'installation.
        const attente = (p.attente || []).filter((a) => a.uid !== uid);
        if (attente.length < ATTENTE_MAX) tx.update(ref, { attente: [...attente, { uid, email, prenom }] });
        return { etat: 'occupe', par: d.par };
      }
      return { etat: d.etat };
    });
  }

  // Commande de la tablette (reconnue à son compte ou à son n° de série), pour la ville de la météo.
  async function commandeDeLaTablette(p) {
    const par = async (champ, valeur) => (valeur
      ? (await db.collection('stock').where(champ, '==', valeur).limit(1).get()).docs[0] || null : null);
    const fiche = (await par('tabletUid', p.tabletUid)) || (await par('serieAndroid', p.serie));
    const id = fiche && fiche.get('commande');
    return id ? (await db.doc(`commandes/${id}`).get()).data() || null : null;
  }

  async function nommerFamille(request) {
    const { uid, email } = compteVerifie(request);
    // Appel à vide pendant que le proche tape le nom : le serveur est démarré pour le vrai appel.
    if (request.data && request.data.reveil) return { ok: true };
    const code = normaliserCode(request.data && request.data.code);
    const nom = texteCourt(request.data && request.data.nom);
    if (!code) throw new HttpsError('invalid-argument', 'Code de tablette manquant.');
    if (!nom) throw new HttpsError('invalid-argument', 'Indiquez comment vous appelez la personne (40 caractères au plus).');
    const ref = db.doc(`pairings/${code}`);
    const avant = (await ref.get()).data();
    if (!avant || avant.claimedBy !== uid || !['reserved', 'confirmed'].includes(avant.status)) {
      throw new HttpsError('failed-precondition', "Cette tablette n'est plus réservée pour vous. Scannez à nouveau son code.");
    }
    const commande = await commandeDeLaTablette(avant).catch((e) => {
      logger.warn(`Installation ${code} : commande illisible`, e.message);
      return null;
    });
    const ville = await villeAvecCoordonnees(villeDuRelais(commande), commande && commande.livraison && commande.livraison.cp);
    const r = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const p = snap.data();
      if (!p || p.claimedBy !== uid || !['reserved', 'confirmed'].includes(p.status)) {
        throw new HttpsError('failed-precondition', "Cette tablette n'est plus réservée pour vous. Scannez à nouveau son code.");
      }
      // Retour en arrière sur le nom : la famille existe déjà, on la renomme.
      if (p.fid) {
        tx.update(db.doc(`families/${p.fid}`), { name: nom, rev: FieldValue.increment(1) });
        tx.update(ref, { familyName: nom });
        return { fid: p.fid };
      }
      let invite = codeAuHasard();
      for (let i = 0; i < 5 && (await tx.get(db.doc(`invites/${invite}`))).exists; i++) invite = codeAuHasard();
      const famille = db.collection('families').doc();
      tx.set(famille, {
        name: nom, code: invite, createdBy: uid, createdAt: FieldValue.serverTimestamp(),
        options: OPTIONS_PAR_DEFAUT, volumeSonnerie: VOLUME_SONNERIE, rev: 1,
        // Ni l'app ni la tablette ne se mettent « en pause » pendant l'installation ; la commande
        // reliée au jumelage (gestionJumelage) remplace ce statut, sinon « aucun » à la fin.
        abonnement: { statut: 'installation', majLe: FieldValue.serverTimestamp() },
        ...(ville ? { meteoVille: ville } : {}),
        installation: { etape: 'photo', pairing: code, debut: FieldValue.serverTimestamp() },
      });
      tx.set(db.doc(`invites/${invite}`), { fid: famille.id, createdBy: uid });
      tx.set(famille.collection('members').doc(uid), {
        name: p.claimedName, role: 'famille', code: invite, joinedAt: FieldValue.serverTimestamp(),
        uid, email, status: 'active', canCall: true,
      });
      tx.update(ref, {
        status: 'confirmed', fid: famille.id, familyName: nom,
        expiresAt: Timestamp.fromMillis(Date.now() + ENTREE_TABLETTE_MS),
      });
      return { fid: famille.id, invite, nouvelle: true };
    });
    // Le nom donné, la famille est validée (Tanguy, 22/10) : les proches en attente sont invités tout de suite.
    if (r.nouvelle) {
      await inviterAttente(r.fid, { name: nom, code: r.invite, installation: { pairing: code } }, uid)
        .catch((e) => logger.error(`Installation ${r.fid} : invitations`, e));
    }
    return { fid: r.fid };
  }

  // Proches qui ont scanné pendant l'installation : invités par e-mail (entrée directe, rien à accepter).
  async function inviterAttente(fid, fam, uid) {
    const code = fam.installation && fam.installation.pairing;
    const p = code ? (await db.doc(`pairings/${code}`).get()).data() : null;
    const attente = ((p && p.attente) || []).filter((a) => a.email && a.uid !== uid);
    if (!attente.length) return;
    const lien = `${appli}?code=${String(fam.code).replace(/^(.{4})(.{4})$/, '$1-$2')}&pour=${encodeURIComponent(fam.name)}`;
    const envois = attente.map(async (a) => {
      const email = a.email.toLowerCase();
      await db.doc(`families/${fid}/invitations/${email}`).set({
        email, fid, familyName: fam.name, invitedBy: p.claimedName || null, createdAt: FieldValue.serverTimestamp(),
      });
      await envoyerMail(email, mail.invitation({ prenom: p.claimedName, tablette: fam.name, lien, email }));
    });
    (await Promise.allSettled(envois)).filter((r) => r.status === 'rejected')
      .forEach((r) => logger.error(`Installation ${fid} : invitation non envoyée`, r.reason));
    await db.doc(`pairings/${code}`).update({ attente: FieldValue.delete() }).catch(() => null);
  }

  async function finirInstallation(request) {
    const { uid } = compteVerifie(request);
    const fid = request.data && request.data.fid;
    if (typeof fid !== 'string' || !fid) throw new HttpsError('invalid-argument', 'Famille manquante.');
    const ref = db.doc(`families/${fid}`);
    const fam = (await ref.get()).data();
    if (!fam) throw new HttpsError('not-found', 'Famille introuvable.');
    const membre = await ref.collection('members').doc(uid).get();
    const actif = membre.exists && (membre.get('status') || 'active') !== 'pending';
    if ((fam.createdBy !== uid && !(fam.admins || []).includes(uid)) || !actif) {
      throw new HttpsError('permission-denied', 'Réservé aux responsables de la famille.');
    }
    if (fam.installation && fam.installation.etape === 'fini') return { ok: true };
    const maj = { 'installation.etape': 'fini', 'installation.fin': FieldValue.serverTimestamp() };
    // Aucune commande reliée pendant l'installation (tablette pas reconnue). Avant de bloquer (B3, Tanguy
    // 2026-10-27) : une seule commande en attente à l'e-mail d'un membre → reliée ; sinon 48 h de tolérance
    // pendant lesquelles tout fonctionne et Tanguy relie la commande à la main, prévenu par e-mail.
    let aRelier = fam.abonnement && fam.abonnement.statut === 'installation';
    if (aRelier && relierParEmail) {
      const membres = await ref.collection('members').where('role', '==', 'famille').get();
      const emails = [...new Set(membres.docs.map((m) => m.get('email')).filter(Boolean).map((e) => String(e).toLowerCase()))];
      try {
        if (emails.length && await relierParEmail(fid, emails) === 1) aRelier = false;
      } catch (e) {
        logger.error(`Installation ${fid} : commande par e-mail`, e.message);
      }
    }
    if (aRelier) {
      maj['abonnement.toleranceJusqua'] = Timestamp.fromMillis(Date.now() + TOLERANCE_MS);
      maj['abonnement.majLe'] = FieldValue.serverTimestamp();
      maj.rev = FieldValue.increment(1);
    }
    await ref.update(maj);
    if (aRelier && prevenirPapote) {
      await prevenirPapote(`Famille installée sans commande reliée : ${fam.name || fid}`,
        `La tablette de « ${fam.name || fid} » vient d'être installée mais aucune commande n'est reliée (tablette pas reconnue à son n° de série, ou commande à un autre e-mail). Tout fonctionne pendant 48 h : reliez la commande depuis l'admin (page de la famille), sinon Papote passera en pause chez la personne.`)
        .catch((e) => logger.error(`Installation ${fid} : Papote non prévenu`, e.message));
    }
    await inviterAttente(fid, fam, uid);
    // Le mode d'emploi en trois lignes, à garder (2026-10-30) ; un échec d'envoi ne bloque pas la fin de l'installation.
    const { email } = compteVerifie(request);
    if (email && envoyerMail && mail.installationFinie) {
      await envoyerMail(email, mail.installationFinie({ prenom: membre.get('name'), famille: fam.name, lien: appli }))
        .catch((e) => logger.error(`Installation ${fid} : e-mail « tablette prête » non envoyé`, e.message));
    }
    return { ok: true };
  }

  // « Annuler l'installation » (le premier proche, avant « C'est parfait ») : tout ce qui a été fait part,
  // et la tablette peut être réinstallée avec un autre téléphone ou un autre nom.
  // Avant le nom ({ code }) : la réservation est rendue. Après ({ fid }) : la famille est effacée,
  // sauf si un abonnement payant y est déjà relié (on ne touche jamais à Stripe ici).
  async function annulerInstallation(request) {
    const { uid } = compteVerifie(request);
    const data = request.data || {};
    const code = normaliserCode(data.code);
    if (!data.fid && code) {
      const ref = db.doc(`pairings/${code}`);
      await db.runTransaction(async (tx) => {
        const p = (await tx.get(ref)).data();
        if (!p || p.claimedBy !== uid || p.status !== 'reserved') return;
        tx.update(ref, {
          status: 'waiting', claimedBy: FieldValue.delete(), claimedName: FieldValue.delete(),
          claimedEmail: FieldValue.delete(), reservedAt: FieldValue.delete(), attente: FieldValue.delete(),
          expiresAt: Timestamp.fromMillis(Date.now() + ENTREE_TABLETTE_MS),
        });
      });
      return { ok: true };
    }
    const fid = data.fid;
    if (typeof fid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(fid)) throw new HttpsError('invalid-argument', 'Famille manquante.');
    const ref = db.doc(`families/${fid}`);
    const fam = (await ref.get()).data();
    if (!fam) return { ok: true };
    const refus = refusAnnulation(fam, uid);
    if (refus) throw new HttpsError('failed-precondition', refus);
    // Fichiers d'abord : si la base échoue ensuite, un nouvel essai finit le travail.
    if (stockage) await stockage().deleteFiles({ prefix: `families/${fid}/`, force: true });
    await db.recursiveDelete(ref);
    if (fam.code) await db.doc(`invites/${fam.code}`).delete().catch(() => null);
    const [jumelages, commandes, fiches] = await Promise.all([
      db.collection('pairings').where('fid', '==', fid).get(),
      db.collection('commandes').where('fid', '==', fid).get(),
      db.collection('stock').where('fid', '==', fid).get(),
    ]);
    await Promise.all([
      ...jumelages.docs.map((d) => d.ref.delete()),
      // La commande et la tablette se relieront à la famille de la prochaine installation. fid à null, pas
      // effacé : les recherches des commandes pas encore reliées (where fid == null) doivent la retrouver.
      ...commandes.docs.map((d) => d.ref.update({ fid: null })),
      ...fiches.docs.map((d) => d.ref.update({ fid: null, jumeleeLe: FieldValue.delete() })),
    ]);
    await db.collection('suppressions').add({
      fid, nom: fam.name || null, membres: 1, le: Date.now(), par: uid, motif: 'installation annulée',
    });
    logger.info(`Installation de ${fid} annulée par ${uid}`);
    return { ok: true };
  }

  return { reserverTablette, nommerFamille, finirInstallation, annulerInstallation };
}

// Raison de refuser « Annuler l'installation », ou null (pure, testée).
function refusAnnulation(fam, uid) {
  if (fam.createdBy !== uid) return "Seule la personne qui installe la tablette peut annuler l'installation.";
  if (!fam.installation || fam.installation.etape === 'fini') return "L'installation est déjà finie.";
  const abo = fam.abonnement || {};
  if (abo.stripeSubscriptionId || !['installation', 'aucun'].includes(abo.statut || 'aucun')) {
    return "Votre commande est déjà reliée à cette famille : écrivez-nous à contact@mapapote.fr pour recommencer l'installation.";
  }
  return null;
}

module.exports = {
  brancher,
  regles: { decisionScan, refusAnnulation, REPRISE_MS, villeDuRelais, villeAvecCoordonnees, normaliserCode, OPTIONS_PAR_DEFAUT, ETAPES },
};
