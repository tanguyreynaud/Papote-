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
// p : pairing (ou null) ; uid : le compte qui scanne ; maintenant : ms.
// → { etat: 'reserver' | 'reprendre' | 'occupe' | 'inconnu' | 'expire', par?, fid? }
function decisionScan(p, uid, maintenant) {
  if (!p) return { etat: 'inconnu' };
  const moi = p.claimedBy === uid;
  if (p.status === 'waiting') {
    return (ms(p.expiresAt) || 0) > maintenant ? { etat: 'reserver' } : { etat: 'expire' };
  }
  if (p.status === 'reserved' || p.status === 'confirmed') {
    if (moi) return { etat: 'reprendre', fid: p.fid || null };
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
      { signal: AbortSignal.timeout(4000) });
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

// deps : { db, compteVerifie, envoyerMail, mail, appli, logger }
function brancher(deps) {
  const { db, compteVerifie, envoyerMail, mail, appli, logger } = deps;

  async function reserverTablette(request) {
    const { uid, email } = compteVerifie(request);
    const code = normaliserCode(request.data && request.data.code);
    const prenom = texteCourt(request.data && request.data.prenom);
    if (!code) throw new HttpsError('invalid-argument', 'Le code de la tablette a 8 caractères.');
    if (!prenom) throw new HttpsError('invalid-argument', 'Votre prénom est demandé.');
    const ref = db.doc(`pairings/${code}`);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const p = snap.exists ? snap.data() : null;
      const d = decisionScan(p, uid, Date.now());
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
    return db.runTransaction(async (tx) => {
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
      return { fid: famille.id };
    });
  }

  async function finirInstallation(request) {
    const { uid } = compteVerifie(request);
    const fid = request.data && request.data.fid;
    if (typeof fid !== 'string' || !fid) throw new HttpsError('invalid-argument', 'Famille manquante.');
    const ref = db.doc(`families/${fid}`);
    const fam = (await ref.get()).data();
    if (!fam) throw new HttpsError('not-found', 'Famille introuvable.');
    if (fam.createdBy !== uid && !(fam.admins || []).includes(uid)) {
      throw new HttpsError('permission-denied', 'Réservé aux responsables de la famille.');
    }
    if (fam.installation && fam.installation.etape === 'fini') return { ok: true };
    await ref.update({ 'installation.etape': 'fini', 'installation.fin': FieldValue.serverTimestamp() });
    const code = fam.installation && fam.installation.pairing;
    const p = code ? (await db.doc(`pairings/${code}`).get()).data() : null;
    const attente = ((p && p.attente) || []).filter((a) => a.email && a.uid !== uid);
    if (!attente.length) return { ok: true };
    const lien = `${appli}?code=${String(fam.code).replace(/^(.{4})(.{4})$/, '$1-$2')}&pour=${encodeURIComponent(fam.name)}`;
    const envois = attente.map(async (a) => {
      const email = a.email.toLowerCase();
      // L'invitation par e-mail fait entrer directement : le responsable n'a rien à accepter.
      await db.doc(`families/${fid}/invitations/${email}`).set({
        email, fid, familyName: fam.name, invitedBy: p.claimedName || null, createdAt: FieldValue.serverTimestamp(),
      });
      await envoyerMail(email, mail.invitation({ prenom: p.claimedName, tablette: fam.name, lien, email }));
    });
    (await Promise.allSettled(envois)).filter((r) => r.status === 'rejected')
      .forEach((r) => logger.error(`Installation ${fid} : invitation non envoyée`, r.reason));
    await db.doc(`pairings/${code}`).update({ attente: FieldValue.delete() }).catch(() => null);
    return { ok: true };
  }

  return { reserverTablette, nommerFamille, finirInstallation };
}

module.exports = {
  brancher,
  regles: { decisionScan, villeDuRelais, villeAvecCoordonnees, normaliserCode, OPTIONS_PAR_DEFAUT, ETAPES },
};
