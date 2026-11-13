// « Installer la carte SIM » dans « Préparer l'envoi » (admin, Tanguy 13/11) : la carte est testée PAR la tablette
// elle-même, avant que le colis parte.
//
//   ordre     l'admin touche « Tester la carte » ou « Retirer le code PIN » (gestionStock, action simOrdre) : le
//             serveur écrit pairings/{code}.ordre = { id, type: 'simTest' | 'simPin', demandeLe, simAttendue } dans le
//             code le plus récent que la tablette affiche (écran Bienvenue, relu toutes les 4 s). Ordre en cours
//             gardé sur stock/{id}.simOrdre.
//   report    le code se renouvelle tous les quarts d'heure : un nouveau code de la même tablette reçoit l'ordre
//             encore sans réponse (jumelageAutomatique, à la création du pairing).
//   résultat  la tablette écrit pairings/{code}.simTest (firestore.rules : ce seul champ, par la tablette) ; le
//             déclencheur simInstallation le recopie dans stock/{id}.simTest avec le verdict. Pour simPin, la
//             tablette enchaîne un test d'id `${id}-apres-pin`.
//   envoi     « Colis déposé », « Tablette remise » et l'étiquette d'envoi sont refusés tant que la carte de la
//             tablette n'a pas un test réussi (refusSimNonTestee).
//
// Logique pure en haut (testée dans sim-installation.test.js), accès à la base dans brancher().

const { randomBytes } = require('node:crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

const TYPES = ['simTest', 'simPin'];
const ETATS = ['ok', 'absente', 'pin', 'puk', 'verrouillee', 'etrangere', 'sans-reseau', 'donnees-ko'];
// Un résultat plus vieux ne compte plus : la carte a pu être retirée depuis.
const FRAIS_MS = 10 * 60_000;
// Deux appuis rapprochés sur le même bouton : un seul ordre.
const DOUBLON_MS = 15_000;
// Ordre sans réponse reporté sur les nouveaux codes de la tablette pendant ce temps (au-delà, à redemander).
const REPORT_MS = 30 * 60_000;
// Sans réponse au bout de ce temps : l'écran le dit, sans alarmer.
const SILENCE_MS = 45_000;
const SUFFIXE_PIN = '-apres-pin';

const OPERATEURS = { '01': 'Orange', '02': 'Orange', '10': 'SFR', '11': 'SFR', '13': 'SFR', '15': 'Free', '16': 'Free', '20': 'Bouygues', '21': 'Bouygues', '88': 'Bouygues' };

const ms = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return null;
};
const chiffres = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const fin = (v) => chiffres(v).slice(-4);

// La carte lue par la tablette est-elle celle choisie ? ICCID complet, ou ses 13 derniers chiffres (au moins), ou
// le même sans son dernier chiffre de contrôle (certains Android le donnent sur 19 chiffres).
function memeCarte(attendue, lue) {
  const a = chiffres(attendue);
  const b = chiffres(lue);
  if (a.length < 13 || b.length < 13) return false;
  if (a === b) return true;
  if (a.slice(-13) === b.slice(-13)) return true;
  const [court, long] = a.length < b.length ? [a, b] : [b, a];
  return long.length - court.length === 1 && court.length >= 18 && long.startsWith(court);
}

const idDeBase = (id) => String(id || '').replace(new RegExp(`${SUFFIXE_PIN}$`), '');
// Ce résultat répond-il à cet ordre ? Le test lui-même, ou celui qui suit le retrait du code PIN.
const repondA = (ordre, test) => !!(ordre && test && ordre.id && (test.id === ordre.id || test.id === `${ordre.id}${SUFFIXE_PIN}`));

// Le code de la tablette où écrire l'ordre : le plus récent, encore en attente et pas expiré, écrit par un compte
// prouvé pour ce n° de série (comptes : tabletUid de la fiche, ou clé App Check de l'installation).
function pairingPourOrdre(pairings, { serie, comptes = [], maintenant }) {
  return pairings
    .filter((p) => p && p.serie === serie && p.status === 'waiting' && comptes.includes(p.tabletUid)
      && (ms(p.expiresAt) == null || ms(p.expiresAt) > maintenant))
    .sort((a, b) => (ms(b.createdAt) || 0) - (ms(a.createdAt) || 0))[0] || null;
}

// Même bouton touché deux fois de suite (double clic, deux onglets) : l'ordre déjà parti, sans réponse.
function ordreDejaParti(simOrdre, type, maintenant) {
  return !!(simOrdre && simOrdre.type === type && !simOrdre.repondu
    && maintenant - (ms(simOrdre.demandeLe) || 0) < DOUBLON_MS);
}

// Ordre en cours à reporter sur un nouveau code de la tablette.
function ordreAReporter(simOrdre, code, maintenant) {
  return !!(simOrdre && simOrdre.id && !simOrdre.repondu && !(simOrdre.codes || []).includes(code)
    && maintenant - (ms(simOrdre.demandeLe) || 0) < REPORT_MS);
}

// Ordre tel qu'il est reporté sur un nouveau code. Un « Retirer le code PIN » déjà parti devient le test qui le
// suit (id « -apres-pin ») : la tablette exécute un ordre une seule fois par id, et son test d'après le PIN échoue
// s'il vise l'ancien code (fil tablette, 13/11). Si le PIN n'était pas encore retiré, le test le dit (« pin »).
function ordreReporte(o) {
  const base = { demandeLe: Timestamp.fromMillis(ms(o.demandeLe) || 0), simAttendue: o.simAttendue };
  if (o.type === 'simPin') return { id: `${idDeBase(o.id)}${SUFFIXE_PIN}`, type: 'simTest', ...base };
  return { id: o.id, type: o.type, ...base };
}

// Résultat écrit par la tablette, gardé champ par champ (les règles l'ont déjà vérifié).
function resultatPropre(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !ETATS.includes(t.etat)) return null;
  const texte = (v, n) => (v == null ? null : String(v).slice(0, n));
  const d = t.donnees && typeof t.donnees === 'object' ? t.donnees : {};
  return {
    id: t.id.slice(0, 80), le: ms(t.le), etat: t.etat,
    iccid: texte(t.iccid, 32), mcc: texte(t.mcc, 3), mnc: texte(t.mnc, 3), operateur: texte(t.operateur, 60),
    inscrite: t.inscrite === true, itinerance: t.itinerance === true,
    donnees: { ok: d.ok === true, ms: Number.isFinite(d.ms) ? Math.round(d.ms) : null },
  };
}

const nomOperateur = (t) => (t && (t.operateur || OPERATEURS[String(t.mnc || '').padStart(2, '0')])) || '';

const MESSAGES = {
  absente: 'Aucune carte détectée : vérifiez qu\'elle est bien dans la tablette, puis redémarrez-la.',
  pin: 'La carte demande un code PIN : touchez « Retirer le code PIN ».',
  puk: 'La carte demande son code PUK (trop d\'essais de code PIN). Le code PUK est dans l\'espace client de l\'opérateur. Le plus simple : prenez une autre carte.',
  verrouillee: 'La tablette n\'accepte pas cette carte (carte verrouillée). Prenez une autre carte, ou demandez à l\'opérateur.',
  etrangere: 'Cette carte n\'est pas sur un réseau français : prenez une carte d\'un opérateur français.',
  'sans-reseau': 'La carte ne capte pas encore le réseau. Une ligne tout juste activée met parfois quelques minutes : attendez un peu, puis testez à nouveau.',
  'donnees-ko': 'La carte a le réseau, mais pas internet. Vérifiez que la ligne est activée avec internet, puis testez à nouveau.',
};

// Verdict pour l'écran de l'admin et pour l'envoi. ordre : stock.simOrdre ; test : le dernier résultat (stock.simTest,
// ou le résultat brut) ; simAttendue : ICCID de la carte choisie.
// → { ok, attente, coches: { carte, reseau, inscrite, internet }, ms, operateur, lue, message }
function verdict({ ordre, test, simAttendue, maintenant }) {
  const vide = { carte: false, reseau: false, inscrite: false, internet: false };
  if (!ordre || !ordre.id) {
    return { ok: false, attente: false, coches: vide, message: 'Touchez « Tester la carte » quand la carte est dans la tablette et la tablette redémarrée.' };
  }
  if (!repondA(ordre, test)) {
    const depuis = maintenant - (ms(ordre.demandeLe) || maintenant);
    return {
      ok: false, attente: true, coches: vide, depuis,
      message: depuis > SILENCE_MS
        ? 'La tablette n\'a pas encore répondu. Vérifiez qu\'elle est allumée, sur l\'écran Bienvenue, avec le wifi.'
        : 'La tablette teste la carte, quelques secondes…',
    };
  }
  const t = test;
  const carte = memeCarte(simAttendue, t.iccid);
  const francais = String(t.mcc || '') === '208' && t.etat !== 'etrangere';
  const coches = {
    carte,
    reseau: francais && t.itinerance !== true,
    inscrite: t.inscrite === true,
    internet: !!(t.donnees && t.donnees.ok === true),
  };
  const le = ms(t.le);
  const recent = le != null && maintenant - le < FRAIS_MS;
  const ok = t.etat === 'ok' && carte && recent && t.itinerance !== true && coches.internet;
  let message = 'La carte marche : vous pouvez passer à la suite.';
  if (t.etat !== 'ok') message = MESSAGES[t.etat] || 'La tablette n\'a pas pu tester la carte : testez à nouveau.';
  else if (!carte) message = `Ce n'est pas la carte choisie : la tablette lit une carte qui finit par …${fin(t.iccid) || '?'}, la carte choisie finit par …${fin(simAttendue) || '?'}. Mettez la bonne carte, redémarrez la tablette, puis testez à nouveau.`;
  else if (t.itinerance === true) message = 'La carte est en itinérance : elle ne doit pas partir comme ça. Prenez une carte d\'un opérateur français.';
  else if (!coches.internet) message = MESSAGES['donnees-ko'];
  else if (!recent) message = 'Ce test date de plus de 10 minutes : testez à nouveau.';
  return {
    ok, attente: false, coches, ms: t.donnees && Number.isFinite(t.donnees.ms) ? t.donnees.ms : null,
    operateur: nomOperateur(t), lue: fin(t.iccid), etat: t.etat, message,
  };
}

// « Colis déposé », « Tablette remise » et étiquette d'envoi : la carte de la tablette doit avoir réussi son test, et
// ce doit être encore la même carte. t : fiche stock ; ligne : sims/{t.simId}. '' ou la raison du refus.
function refusSimNonTestee(t, ligne) {
  if (!t || !t.simId) return '';
  const nom = `la tablette ${t.ref || ''}`.trim();
  const r = t.simTest;
  if (!r || r.ok !== true) {
    return `Testez d'abord la carte SIM dans ${nom} (Préparer l'envoi, étape « Installer la carte SIM »).`;
  }
  if (ligne && ligne.iccid && !memeCarte(ligne.iccid, r.simAttendue)) {
    return `La carte SIM de ${nom} a changé depuis son test : testez la nouvelle carte (Préparer l'envoi, étape « Installer la carte SIM »).`;
  }
  return '';
}

// ---------- Accès à la base ----------

// deps : { db: () => Firestore, logger }
function brancher({ db, logger }) {
  const base = () => (typeof db === 'function' ? db() : db);

  // Comptes de la tablette dont on croit le n° de série : celui de sa fiche, ou celui de sa clé d'installation.
  async function comptesProuves(t) {
    const cles = await base().collection('clesTablettes').where('serie', '==', t.serieAndroid).get();
    return [...new Set([t.tabletUid, ...cles.docs.map((d) => d.get('tabletUid'))].filter(Boolean))];
  }

  async function ficheEtCarte(id) {
    if (typeof id !== 'string' || !id) throw new HttpsError('invalid-argument', 'Tablette manquante.');
    const fiche = await base().doc(`stock/${id}`).get();
    if (!fiche.exists) throw new HttpsError('not-found', 'Tablette introuvable.');
    const t = fiche.data();
    const ligne = t.simId ? (await base().doc(`sims/${t.simId}`).get()).data() || null : null;
    return { fiche, t, ligne };
  }

  // Action admin « simOrdre » : { stock, type }.
  async function ordonner({ stock, type }, qui) {
    if (!TYPES.includes(type)) throw new HttpsError('invalid-argument', 'Ordre inconnu.');
    const { fiche, t, ligne } = await ficheEtCarte(stock);
    const nom = t.ref || 'la tablette';
    if (!ligne) throw new HttpsError('failed-precondition', `Reliez d'abord une carte SIM à ${nom} (étape « Activer la carte SIM »).`);
    if (chiffres(ligne.iccid).length < 13) {
      throw new HttpsError('failed-precondition', 'Notez d\'abord l\'ICCID de la carte (le long numéro imprimé sur la carte), dans Stock, Cartes SIM : il sert à vérifier que c\'est la bonne carte.');
    }
    if (!t.serieAndroid) throw new HttpsError('failed-precondition', `${nom} n'est pas encore installée : faites d'abord sa réception.`);
    const maintenant = Date.now();
    if (ordreDejaParti(t.simOrdre, type, maintenant)) {
      return { ok: true, deja: true, id: t.simOrdre.id, code: t.simOrdre.code, ref: t.ref || null };
    }
    const [pairings, comptes] = await Promise.all([
      base().collection('pairings').where('serie', '==', t.serieAndroid).get(),
      comptesProuves(t),
    ]);
    const choisi = pairingPourOrdre(pairings.docs.map((d) => ({ ...d.data(), code: d.id })), { serie: t.serieAndroid, comptes, maintenant });
    if (!choisi) {
      throw new HttpsError('failed-precondition', `${nom} n'affiche pas encore son code : allumez-la, branchez le wifi et attendez l'écran Bienvenue, puis touchez à nouveau.`);
    }
    const id = randomBytes(9).toString('base64url');
    const ordre = { id, type, demandeLe: Timestamp.fromMillis(maintenant), simAttendue: chiffres(ligne.iccid) };
    await base().doc(`pairings/${choisi.code}`).update({ ordre });
    await fiche.ref.update({
      simOrdre: { id, type, demandeLe: maintenant, simAttendue: ordre.simAttendue, sim: t.simId, code: choisi.code, codes: [choisi.code], par: qui || null },
    });
    logger.info(`Carte SIM : ordre ${type} ${id} envoyé à ${nom} (code ${choisi.code}).`);
    return { ok: true, id, code: choisi.code, ref: t.ref || null };
  }

  // Action admin « simEtat » : { stock } → l'ordre en cours et le verdict, relus toutes les 3 s par l'écran.
  async function etat({ stock }) {
    const { t, ligne } = await ficheEtCarte(stock);
    const o = t.simOrdre || null;
    const v = verdict({ ordre: o, test: t.simTest, simAttendue: (ligne && ligne.iccid) || (o && o.simAttendue), maintenant: Date.now() });
    // La carte a changé depuis l'ordre : le résultat ne vaut plus.
    if (o && ligne && ligne.iccid && !memeCarte(ligne.iccid, o.simAttendue)) Object.assign(v, { ok: false, message: 'La carte choisie a changé : testez à nouveau.' });
    return {
      ok: true, ref: t.ref || null, attendue: fin(ligne && ligne.iccid),
      ordre: o ? { id: o.id, type: o.type, demandeLe: ms(o.demandeLe), code: o.code } : null,
      verdict: v,
    };
  }

  // Nouveau code de la tablette (jumelageAutomatique) : l'ordre encore sans réponse y est recopié.
  async function reporter(ref, p) {
    if (!p || p.status !== 'waiting' || !p.serie || !p.tabletUid) return false;
    const fiches = await base().collection('stock').where('serieAndroid', '==', p.serie).limit(1).get();
    const fiche = fiches.docs[0];
    if (!fiche) return false;
    const t = fiche.data();
    const o = t.simOrdre;
    if (!ordreAReporter(o, ref.id, Date.now())) return false;
    if (!(await comptesProuves(t)).includes(p.tabletUid)) return false;
    const fait = await base().runTransaction(async (tx) => {
      const [snap, f] = await Promise.all([tx.get(ref), tx.get(fiche.ref)]);
      const encore = f.get('simOrdre');
      if (!snap.exists || snap.get('status') !== 'waiting' || !encore || encore.id !== o.id || encore.repondu) return false;
      tx.update(ref, { ordre: ordreReporte(o) });
      tx.update(fiche.ref, { 'simOrdre.code': ref.id, 'simOrdre.codes': FieldValue.arrayUnion(ref.id) });
      return true;
    });
    if (fait) logger.info(`Carte SIM : ordre ${o.id} reporté sur le nouveau code ${ref.id} de ${t.ref || fiche.id}.`);
    return fait;
  }

  // pairings/{code}.simTest écrit par la tablette : recopié dans stock/{id}.simTest s'il répond à l'ordre en cours.
  async function copier(code, avant, apres) {
    const r = resultatPropre(apres && apres.simTest);
    const r0 = resultatPropre(avant && avant.simTest);
    if (!r || (r0 && r0.id === r.id && r0.le === r.le && r0.etat === r.etat)) return false;
    const fiches = await base().collection('stock').where('simOrdre.id', '==', idDeBase(r.id)).limit(1).get();
    const fiche = fiches.docs[0];
    if (!fiche) return false;
    // Le code où la tablette répond : un de ceux qui ont reçu l'ordre, ou un autre code de cette même tablette
    // (renouvelé entre le retrait du code PIN et le test qui suit).
    const t = fiche.data();
    const sienne = ((t.simOrdre && t.simOrdre.codes) || []).includes(code)
      || (!!apres.tabletUid && apres.serie === t.serieAndroid && (await comptesProuves(t)).includes(apres.tabletUid));
    if (!sienne) {
      logger.warn(`Carte SIM : résultat ${r.id} écrit sur le code ${code}, qui n'est pas celui de ${t.ref || fiche.id} : ignoré.`);
      return false;
    }
    return base().runTransaction(async (tx) => {
      const f = await tx.get(fiche.ref);
      const o = f.get('simOrdre');
      if (!o || !repondA(o, r)) return false;
      const v = verdict({ ordre: o, test: r, simAttendue: o.simAttendue, maintenant: Date.now() });
      tx.update(fiche.ref, {
        simTest: { ...r, simAttendue: o.simAttendue, ordre: o.id, type: o.type, code, ok: v.ok, copieLe: Date.now() },
        'simOrdre.repondu': true,
      });
      return true;
    });
  }

  return { ordonner, etat, reporter, copier };
}

module.exports = {
  brancher, verdict, memeCarte, pairingPourOrdre, ordreDejaParti, ordreAReporter, ordreReporte, resultatPropre, refusSimNonTestee,
  idDeBase, repondA, TYPES, ETATS, FRAIS_MS, DOUBLON_MS, REPORT_MS, SUFFIXE_PIN,
};
