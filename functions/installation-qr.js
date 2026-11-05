// Installation des tablettes par QR code (provisionnement Android « propriétaire de l'appareil », 05/11) :
// la tablette remise à zéro, on touche 6 fois l'écran d'accueil, on scanne le QR affiché par l'admin (Stock ›
// « Installer une tablette ») ; Android télécharge Papote, la rend propriétaire de l'appareil (mode kiosque) et
// lui passe le jeton. Remplace, sans PC ni câble, installer-tablette.ps1 (adb).
//
//   jetonInstallation  appel depuis l'admin : { essai, canal } -> { jeton, expire, provisionnement }
//                      provisionnement = contenu du QR sans le wifi (le wifi est ajouté par la page, jamais envoyé ici)
//   inscrireTablette   appel depuis la tablette, sans compte (android/…/Installation.java) :
//                      { jeton, serie, iccid, modele, android, criteresOk, criteres: { pouces, android13, camera, simPin, ok, manque } }
//                      -> { appCheckKey, code?, ref, essai, horsCriteres } : note la tablette dans le stock et lui donne sa clé
//                      App Check (comme outils/admin/cle-tablette.js, voir appcheck.js)
//
// installations/{jeton} = { creeLe, expire (24 h), essai, canal, creePar, serie, inscriteLe, fiche, essais }
//   écrit par le serveur seulement (firestore.rules : rien côté client). Le jeton sert 24 h, pour UNE tablette :
//   nouvel essai permis avec le même n° de série (même fiche, une clé de plus, toutes valables), refusé avec un autre.
// La clé App Check n'est jamais gardée ni écrite dans un journal : seule son empreinte (clesTablettes/{empreinte}).

const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const crypto = require('node:crypto');
const { nouvelleCle } = require('./appcheck');

const DUREE_MS = 24 * 3600 * 1000;
// Jetons créés en une heure (tous admins confondus) : au-delà, c'est une erreur ou un abus.
const MAX_JETONS_HEURE = 20;
// Appels d'inscription par jeton (nouveaux essais d'une tablette qui a perdu la réponse) : une clé chacun.
const MAX_ESSAIS = 10;

// Contenu fixe du QR (norme Android). Empreinte : SHA-256 du certificat de signature de Papote, en base64url.
const COMPOSANT = 'com.papote.tablette/.AdminReceiver';
const EMPREINTE_SIGNATURE = '_yWAPegUjhtPlkspLstFmFlfmTSzn5Ywzxk_lFzSBZk';
// Fichiers de version des tablettes (installation/maj-commun.ps1) et leur secours hors Google (Updater.java).
const FLUX = ['https://papote-maj.web.app/version.json', 'https://maj.mapapote.fr/version.json'];
// Même garde-fou que la tablette (android/…/MajGarde.java) : dépôt Papote à un commit précis, ou maj.mapapote.fr.
const URL_APK = /^https:\/\/raw\.githubusercontent\.com\/tanguyreynaud\/Papote-\/[0-9a-f]{40}\/installation\/Papote\.apk$/;
const URL_APK_SECOURS = /^https:\/\/maj\.mapapote\.fr\/[A-Za-z0-9._-]{1,80}\.apk$/;

const jetonValide = (j) => typeof j === 'string' && /^[A-Za-z0-9_-]{32}$/.test(j);
const nouveauJeton = () => crypto.randomBytes(24).toString('base64url');
const ms = (v) => (v == null ? null : typeof v === 'number' ? v : v.toMillis ? v.toMillis() : null);

function texte(v, max = 80) {
  if (v == null) return null;
  const t = String(v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

// N° de série Android (ro.serialno) : lettres, chiffres et quelques signes, 4 à 40 caractères.
function serieValide(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^[A-Za-z0-9._:-]{4,40}$/.test(s) && !/^(unknown|0+)$/i.test(s) ? s : null;
}
const codeTablette = (v) => (typeof v === 'string' && /^[A-Z0-9]{8}$/.test(v) ? v : null);
const iccidValide = (v) => (typeof v === 'string' && /^\d{18,22}$/.test(v.replace(/\s/g, '')) ? v.replace(/\s/g, '') : null);

// Entrée d'un fichier de version utilisable pour le QR, sinon null.
function apkDuFlux(f) {
  if (!f || typeof f !== 'object') return null;
  const url = typeof f.url === 'string' ? f.url : '';
  if (!(URL_APK.test(url) || URL_APK_SECOURS.test(url))) return null;
  const versionCode = Number(f.versionCode);
  if (!Number.isInteger(versionCode) || versionCode < 1) return null;
  return { url, versionCode, versionName: texte(f.versionName, 30) };
}

// La plus récente des versions publiées (comme la tablette) ; null si aucun fichier n'est lisible.
async function lireApk(chercher = fetch) {
  const lus = await Promise.all(FLUX.map(async (u) => {
    try {
      const r = await chercher(u, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(5000) });
      return r.ok ? apkDuFlux(await r.json()) : null;
    } catch (e) {
      return null;
    }
  }));
  return lus.filter(Boolean).sort((a, b) => b.versionCode - a.versionCode)[0] || null;
}

// Contenu du QR sans le wifi (que la page ajoute). Clés et valeurs : norme Android, convenues avec la tablette.
function provisionnement({ jeton, canal, apkUrl }) {
  return {
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': COMPOSANT,
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': apkUrl,
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM': EMPREINTE_SIGNATURE,
    'android.app.extra.PROVISIONING_LOCALE': 'fr_FR',
    'android.app.extra.PROVISIONING_TIME_ZONE': 'Europe/Paris',
    'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': false,
    'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': { papote_jeton: jeton, papote_canal: canal },
  };
}

// Que faire d'une demande d'inscription (pure, testée). inst : installations/{jeton} ou null.
// -> { etat: 'inconnu' | 'expire' | 'autre-tablette' | 'trop' | 'premiere' | 'nouvel-essai' }
function decisionInscription(inst, serie, maintenant) {
  if (!inst) return { etat: 'inconnu' };
  if ((ms(inst.expire) || 0) <= maintenant) return { etat: 'expire' };
  if (inst.serie && inst.serie !== serie) return { etat: 'autre-tablette' };
  if ((inst.essais || 0) >= MAX_ESSAIS) return { etat: 'trop' };
  return { etat: inst.serie ? 'nouvel-essai' : 'premiere' };
}

// Critères des tablettes vendues, vérifiés par la tablette (android/…/Installation.java) :
// criteres = { pouces, android13, camera, simPin, ok, manque: « écran 8.0" ; Android 11 ; … » }.
// Le serveur ne refuse rien : il garde le détail pour que l'administrateur décide. (Une liste de textes est acceptée aussi.)
function criteresPropres(criteresOk, criteres) {
  const c = criteres && typeof criteres === 'object' && !Array.isArray(criteres) ? criteres : {};
  const brut = Array.isArray(criteres) ? criteres : typeof c.manque === 'string' ? c.manque.split(';') : [];
  const detail = brut.map((x) => texte(typeof x === 'string' ? x : JSON.stringify(x), 200)).filter(Boolean).slice(0, 10);
  const simPin = c.simPin === true;
  if (simPin && !detail.some((x) => /PIN/i.test(x))) detail.push('carte SIM avec code PIN');
  const ok = criteresOk !== false && c.ok !== false && !simPin;
  const mesures = {};
  if (Number.isFinite(Number(c.pouces)) && c.pouces != null) mesures.pouces = Math.round(Number(c.pouces) * 10) / 10;
  for (const k of ['android13', 'camera']) if (typeof c[k] === 'boolean') mesures[k] = c[k];
  return { ok, detail, simPin, mesures };
}

// Achat d'une fiche : la dépense qui l'a créée, sinon vendeur + date + prix (outils/gestion/preparer-tablette.js).
const cleAchat = (t) => t.depense || [t.fournisseur, ms(t.acheteeLe) || '', t.prixAchat ?? ''].join('|');
const memeModele = (a, b) => {
  const n = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return !n(a) || !n(b) || n(a).includes(n(b)) || n(b).includes(n(a));
};

// Quelle fiche d'achat libre est cette tablette ? Même règle que preparer-tablette.js, sans question possible :
// réception ouverte dans l'admin, sinon n° de série tapé, sinon (même modèle) un seul achat → sa plus ancienne fiche.
// Plusieurs achats possibles → null : la tablette a sa propre fiche, à relier depuis « Recevoir une tablette »
// (gestionParcours, type 'lier'). libres : [{ id, ...données }]. Pure, testée.
function choisirFiche(libres, serie, modele) {
  const n = (x) => String(x || '').replace(/\s/g, '').toUpperCase();
  const sure = libres.find((t) => t.reception && !t.reception.fini) || libres.find((t) => n(t.numero) === n(serie));
  if (sure) return { id: sure.id, ambigu: false };
  const possibles = libres.filter((t) => memeModele(t.modele, modele));
  const parAchat = new Map();
  for (const t of (possibles.length ? possibles : libres)) if (!parAchat.has(cleAchat(t))) parAchat.set(cleAchat(t), t);
  if (parAchat.size === 1) return { id: [...parAchat.values()][0].id, ambigu: false };
  return { id: null, ambigu: parAchat.size > 1 };
}

// deps : { db, logger, verifierAdmin, chercher? }
function brancher({ db, logger, verifierAdmin, chercher }) {
  async function jetonInstallation(request) {
    verifierAdmin(request);
    const d = request.data || {};
    const canal = d.canal === 'test' ? 'test' : 'stable';
    const essai = d.essai === true;
    const maintenant = Date.now();
    const recents = await db().collection('installations')
      .where('creeLe', '>', Timestamp.fromMillis(maintenant - 3600 * 1000)).count().get();
    if (recents.data().count >= MAX_JETONS_HEURE) {
      throw new HttpsError('resource-exhausted', `Déjà ${MAX_JETONS_HEURE} QR d'installation cette heure-ci : réessayez plus tard.`);
    }
    // APK lue au moment du QR : celle de toutes les tablettes (une tablette « test » passe ensuite à sa version).
    const apk = await lireApk(chercher || fetch);
    if (!apk) throw new HttpsError('unavailable', 'Fichier de version des tablettes illisible : réessayez dans un instant.');
    const jeton = nouveauJeton();
    const expire = maintenant + DUREE_MS;
    await db().doc(`installations/${jeton}`).create({
      creeLe: Timestamp.fromMillis(maintenant), expire: Timestamp.fromMillis(expire), essai, canal,
      creePar: request.auth.token.email || request.auth.uid, apk: { versionCode: apk.versionCode, url: apk.url },
      serie: null, inscriteLe: null, fiche: null, essais: 0,
    });
    logger.info(`Installation par QR : jeton créé (${canal}${essai ? ', essai' : ''}, version ${apk.versionName || apk.versionCode})`);
    return { jeton, expire, versionName: apk.versionName, provisionnement: provisionnement({ jeton, canal, apkUrl: apk.url }) };
  }

  // Fiche de stock de la tablette : la sienne si elle a déjà servi, sinon un achat libre, sinon une nouvelle.
  async function noterAuStock({ serie, iccid, modele, android, criteres, essai, fiche }) {
    const stock = db().collection('stock');
    const maintenant = Date.now();
    const horsCriteres = criteres.ok ? null : { detail: criteres.detail.length ? criteres.detail : ['détail non transmis'], le: maintenant };
    const releve = {
      serieAndroid: serie, modele: modele || null, android: android || null, iccid: iccid || null,
      // Carte SIM qui demande son code PIN : la tablette resterait bloquée chez le client (à retirer avant l'envoi).
      simPin: criteres.simPin,
      installation: { par: 'qr', le: maintenant, criteres: criteres.detail, mesures: criteres.mesures },
      horsCriteres, ...(essai ? { essai: true } : {}), majLe: FieldValue.serverTimestamp(),
    };
    const trace = (etat, extra = {}) => ({ le: maintenant, etat, par: 'installation-qr', ...extra });
    // Nouvel essai : la fiche notée la première fois (le stock a pu bouger entre-temps).
    let existante = fiche ? await stock.doc(fiche).get() : null;
    if (!existante || !existante.exists || existante.get('serieAndroid') !== serie) {
      existante = (await stock.where('serieAndroid', '==', serie).limit(1).get()).docs[0] || null;
    }
    if (existante) {
      const t = existante.data();
      const maj = { ...releve, modele: t.modele || releve.modele };
      // Revenue d'un client (ou remplacée) et réinstallée : de nouveau prête à partir (comme preparer-tablette.js).
      if (['revenue', 'en-retour'].includes(t.etat)) {
        Object.assign(maj, { etat: 'preparee', preparee: maintenant, commande: null, fid: null, remplaceePour: FieldValue.delete(),
          historique: FieldValue.arrayUnion(trace('preparee')) });
      }
      await existante.ref.update(maj);
      return { id: existante.id, ref: t.ref || null, code: codeTablette(t.code) };
    }
    const prochaineRef = async () => {
      const compteurs = db().doc('gestion/compteurs');
      const n = await db().runTransaction(async (tx) => {
        const v = ((await tx.get(compteurs)).get('tablettes') || 0) + 1;
        tx.set(compteurs, { tablettes: v }, { merge: true });
        return v;
      });
      return `T-${String(n).padStart(3, '0')}`;
    };
    // Tablette d'essai : sa propre fiche, sans prendre un achat du stock ni de numéro de carton.
    if (essai) {
      const ref = await stock.add({
        ...releve, numero: serie, etat: 'en-stock', commande: null, prixAchat: null, acheteeLe: null, sim: null,
        notes: 'Tablette d\'essai installée par QR : jamais pour un client.',
        historique: [trace('en-stock', { motif: 'essai' })], creeLe: FieldValue.serverTimestamp(),
      });
      return { id: ref.id, ref: null };
    }
    const libres = (await stock.where('etat', 'in', ['en-stock', 'commandee']).get()).docs
      .filter((x) => !x.get('serieAndroid') && !x.get('commande') && x.get('essai') !== true)
      .map((x) => ({ id: x.id, ...x.data() }))
      .sort((a, b) => (a.etat === 'commandee') - (b.etat === 'commandee') || (ms(a.acheteeLe) || 0) - (ms(b.acheteeLe) || 0));
    const choix = choisirFiche(libres, serie, modele);
    const ref = await prochaineRef();
    if (choix.id) {
      const t = libres.find((x) => x.id === choix.id);
      await stock.doc(choix.id).update({
        ...releve, ref, etat: 'preparee', preparee: maintenant,
        ...(t.modele ? { modele: t.modele } : {}), ...(t.numero ? {} : { numero: serie }),
        historique: t.etat === 'commandee'
          ? FieldValue.arrayUnion(trace('en-stock', { le: maintenant - 1, motif: 'reçue' }), trace('preparee'))
          : FieldValue.arrayUnion(trace('preparee')),
      });
      return { id: choix.id, ref };
    }
    const nouvelle = await stock.add({
      ...releve, ref, numero: serie, etat: 'preparee', preparee: maintenant, commande: null, prixAchat: null, acheteeLe: null, sim: null,
      notes: choix.ambigu
        ? 'Installée par QR : plusieurs achats possibles. Reliez-la à son achat depuis « Recevoir une tablette ».'
        : 'Créée à l\'installation par QR : aucun achat en stock à rattacher (ajoutez la facture).',
      historique: [trace('preparee')], creeLe: FieldValue.serverTimestamp(),
    });
    return { id: nouvelle.id, ref };
  }

  async function inscrireTablette(request) {
    const d = request.data || {};
    const jeton = jetonValide(d.jeton) ? d.jeton : null;
    const serie = serieValide(d.serie);
    if (!jeton) throw new HttpsError('invalid-argument', 'Jeton d\'installation manquant.');
    if (!serie) throw new HttpsError('invalid-argument', 'N° de série de la tablette illisible.');
    const instRef = db().doc(`installations/${jeton}`);
    const maintenant = Date.now();
    // Transaction : deux tablettes avec le même QR en même temps, une seule passe ; la clé est enregistrée avec.
    const { decision, inst, cle } = await db().runTransaction(async (tx) => {
      const snap = await tx.get(instRef);
      const i = snap.exists ? snap.data() : null;
      const dec = decisionInscription(i, serie, maintenant);
      if (!['premiere', 'nouvel-essai'].includes(dec.etat)) return { decision: dec, inst: i };
      const c = nouvelleCle();
      tx.set(db().doc(`clesTablettes/${c.empreinte}`), { serie, creeLe: Timestamp.fromMillis(maintenant), par: 'qr' });
      tx.update(instRef, {
        serie, essais: FieldValue.increment(1), dernierEssai: Timestamp.fromMillis(maintenant),
        ...(dec.etat === 'premiere' ? { inscriteLe: Timestamp.fromMillis(maintenant) } : {}),
      });
      return { decision: dec, inst: i, cle: c.cle };
    });
    if (decision.etat === 'inconnu') throw new HttpsError('not-found', 'QR d\'installation inconnu : créez-en un nouveau dans l\'admin.');
    // Codes HTTP : la tablette oublie le jeton sur 400, 403 ou 404 (refus définitifs) et réessaie sur tout autre.
    if (decision.etat === 'expire') throw new HttpsError('permission-denied', 'QR d\'installation expiré (24 h) : créez-en un nouveau dans l\'admin.');
    if (decision.etat === 'autre-tablette') {
      logger.warn('Installation par QR : jeton déjà utilisé par une autre tablette');
      throw new HttpsError('permission-denied', 'Ce QR a déjà servi à installer une autre tablette : créez-en un nouveau dans l\'admin.');
    }
    if (decision.etat === 'trop') throw new HttpsError('permission-denied', 'Trop d\'essais avec ce QR : créez-en un nouveau dans l\'admin.');

    const criteres = criteresPropres(d.criteresOk, d.criteres);
    const fiche = await noterAuStock({
      serie, iccid: iccidValide(d.iccid), modele: texte(d.modele), android: texte(d.android, 20),
      criteres, essai: inst.essai === true, fiche: inst.fiche,
    });
    if (fiche.id !== inst.fiche) await instRef.update({ fiche: fiche.id });
    logger.info(`Installation par QR : tablette ${fiche.ref || fiche.id} notée au stock (${decision.etat}${criteres.ok ? '' : ', hors critères'}${inst.essai ? ', essai' : ''})`);
    // appCheckKey : même nom que l'extra posé par installer-tablette.ps1. code : code tablette de la fiche, s'il y en a un.
    return {
      appCheckKey: cle, ...(fiche.code ? { code: fiche.code } : {}),
      ref: fiche.ref, essai: inst.essai === true, horsCriteres: !criteres.ok, canal: inst.canal || 'stable',
    };
  }

  return { jetonInstallation, inscrireTablette };
}

module.exports = {
  brancher, decisionInscription, choisirFiche, criteresPropres, apkDuFlux, lireApk, provisionnement, jetonValide, serieValide, iccidValide,
  DUREE_MS, MAX_ESSAIS, MAX_JETONS_HEURE, EMPREINTE_SIGNATURE, COMPOSANT, FLUX,
};
