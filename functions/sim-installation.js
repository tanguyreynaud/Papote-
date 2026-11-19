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
//   SMS+appel (Tanguy, 17/11) : si un numéro d'essai est noté (gestion/reglages.numeroEssai, action admin
//             simNumero), l'ordre porte appel = { numero, secondes, texte } : la tablette envoie un SMS puis appelle ce
//             portable ~20 s et raccroche seule. Son résultat ajoute sms = { ok, code, ms } et
//             appel = { ok, secondes, raison? } ; le test n'est réussi qu'avec les deux. Sans numéro : test comme avant.
//   répondeur (Tanguy, 19/11) : après son test, la tablette coupe le répondeur de sa ligne (##002#) et ajoute
//             repondeur = { ok, essais, raison? } (écrit à part, quelques secondes plus tard). Affiché dans l'admin,
//             sans bloquer l'envoi : la tablette réessaie seule chaque jour tant que ce n'est pas fait.
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
// Avec SMS et appel, la tablette met ~30 s (SMS au plus) + la durée de l'appel + 5 s.
const SILENCE_APPEL_MS = 90_000;
const APPEL_SECONDES = 20;
const RAISONS_APPEL = ['coupe', 'refuse', 'sans-permission', 'erreur', 'numero'];
const SUFFIXE_PIN = '-apres-pin';
const RAISONS_REPONDEUR = ['refuse', 'indisponible', 'delai', 'sans-permission', 'sans-reseau', 'occupe', 'erreur'];
// Après le résultat du test, la tablette met au plus ~40 s à couper le répondeur (2 essais de 15 s).
const REPONDEUR_MS = 60_000;

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

// Numéro d'essai : un portable français (06 ou 07), rendu en +336… / +337…. null sinon.
function numeroEssai(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  let n = v.replace(/[\s.\-()]/g, '');
  if (n.startsWith('0033')) n = `+33${n.slice(4)}`;
  if (/^0[67]\d{8}$/.test(n)) n = `+33${n.slice(1)}`;
  return /^\+33[67]\d{8}$/.test(n) ? n : null;
}
// +33612345678 → 06 12 34 56 78 (écran de l'admin).
const numeroLisible = (n) => (n ? `0${n.slice(3)}`.replace(/(\d{2})(?=\d)/g, '$1 ') : '');

// Ce qui part dans l'ordre quand un numéro d'essai est noté (sinon rien : test sans SMS ni appel).
function appelPourOrdre(numero, ref) {
  const n = numeroEssai(numero);
  if (!n) return null;
  return { numero: n, secondes: APPEL_SECONDES, texte: `Papote : test de la carte SIM de ${ref || 'la tablette'}`.slice(0, 160) };
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
  const base = { demandeLe: Timestamp.fromMillis(ms(o.demandeLe) || 0), simAttendue: o.simAttendue, ...(o.appel ? { appel: o.appel } : {}) };
  if (o.type === 'simPin') return { id: `${idDeBase(o.id)}${SUFFIXE_PIN}`, type: 'simTest', ...base };
  return { id: o.id, type: o.type, ...base };
}

// Résultat écrit par la tablette, gardé champ par champ (les règles l'ont déjà vérifié).
function resultatPropre(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !ETATS.includes(t.etat)) return null;
  const texte = (v, n) => (v == null ? null : String(v).slice(0, n));
  const d = t.donnees && typeof t.donnees === 'object' ? t.donnees : {};
  const entier = (v, min, max) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : null);
  const sms = t.sms && typeof t.sms === 'object'
    ? { ok: t.sms.ok === true, code: entier(t.sms.code, -1e6, 1e6), ms: entier(t.sms.ms, 0, 600_000) } : null;
  const appel = t.appel && typeof t.appel === 'object'
    ? { ok: t.appel.ok === true, secondes: entier(t.appel.secondes, 0, 3600), raison: RAISONS_APPEL.includes(t.appel.raison) ? t.appel.raison : null }
    : null;
  const repondeur = t.repondeur && typeof t.repondeur === 'object'
    ? { ok: t.repondeur.ok === true, essais: entier(t.repondeur.essais, 0, 10), raison: RAISONS_REPONDEUR.includes(t.repondeur.raison) ? t.repondeur.raison : null }
    : null;
  return {
    id: t.id.slice(0, 80), le: ms(t.le), etat: t.etat,
    iccid: texte(t.iccid, 32), mcc: texte(t.mcc, 3), mnc: texte(t.mnc, 3), operateur: texte(t.operateur, 60),
    inscrite: t.inscrite === true, itinerance: t.itinerance === true,
    donnees: { ok: d.ok === true, ms: Number.isFinite(d.ms) ? Math.round(d.ms) : null },
    sms, appel, repondeur,
  };
}

// Répondeur de la ligne de la tablette (information, ne bloque pas l'envoi). t : résultat de la tablette.
// → { ok, attente, message }
function etatRepondeur(t, maintenant) {
  const r = t && t.repondeur;
  if (r && r.ok === true) return { ok: true, attente: false, message: 'Répondeur de la ligne coupé : un appel sans réponse ne tombe jamais sur une messagerie.' };
  if (!r) {
    const le = ms(t && t.le);
    if (le != null && maintenant - le < REPONDEUR_MS) return { ok: false, attente: true, message: 'La tablette coupe le répondeur de la ligne, quelques secondes…' };
    return { ok: false, attente: false, message: 'La tablette n\'a pas dit si le répondeur est coupé : mettez à jour l\'appli Papote de la tablette. Elle le coupera ensuite toute seule.' };
  }
  if (r.raison === 'refuse') return { ok: false, attente: false, message: 'L\'opérateur a refusé de couper le répondeur. La tablette réessaiera chaque jour ; sinon, coupez-le depuis l\'espace client de l\'opérateur.' };
  if (r.raison === 'sans-permission') return { ok: false, attente: false, message: 'La tablette n\'a pas l\'autorisation Téléphone : autorisez-la pour l\'appli Papote (Paramètres de la tablette, Applications). Elle coupera ensuite le répondeur toute seule.' };
  return { ok: false, attente: false, message: 'Le répondeur n\'est pas encore coupé (réseau occupé). La tablette réessaiera toute seule chaque jour, rien à faire.' };
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

// SMS et appel d'essai : ce qui n'a pas marché, et quoi faire.
function messageSmsAppel(t) {
  const sms = t.sms || null;
  const appel = t.appel || null;
  if (!sms && !appel) return 'La tablette n\'a pas fait l\'essai de SMS et d\'appel : mettez à jour l\'appli Papote de la tablette, puis testez à nouveau.';
  if (appel && appel.raison === 'numero') return 'Le numéro d\'essai n\'est pas un portable français (06 ou 07) : corrigez-le plus bas, puis testez à nouveau.';
  if (appel && appel.raison === 'sans-permission') return 'La tablette n\'a pas encore l\'autorisation d\'envoyer des SMS et de passer des appels : autorisez Téléphone et SMS pour l\'appli Papote (Paramètres de la tablette, Applications), puis testez à nouveau.';
  if (!sms || sms.ok !== true) {
    return sms && (sms.code === -1 || sms.code === -999)
      ? 'Le SMS d\'essai n\'est pas parti dans les 30 secondes. Une ligne tout juste activée met parfois quelques minutes : attendez un peu, puis testez à nouveau.'
      : 'Le SMS d\'essai n\'est pas parti. Vérifiez que la ligne permet les SMS (et qu\'il reste du crédit), puis testez à nouveau.';
  }
  if (!appel || appel.ok !== true) {
    const r = appel && appel.raison;
    if (r === 'refuse') return 'Le réseau n\'a pas laissé passer l\'appel d\'essai (portable occupé, ou appels pas encore ouverts sur la ligne). Vérifiez que votre portable est libre, attendez un peu, puis testez à nouveau.';
    if (r === 'coupe') return `L'appel d'essai s'est arrêté trop tôt${appel && appel.secondes != null ? ` (au bout de ${appel.secondes} s)` : ''}. Attendez un peu, puis testez à nouveau.`;
    return 'La tablette n\'a pas pu passer l\'appel d\'essai : redémarrez-la, puis testez à nouveau.';
  }
  return '';
}

// Verdict pour l'écran de l'admin et pour l'envoi. ordre : stock.simOrdre ; test : le dernier résultat (stock.simTest,
// ou le résultat brut) ; simAttendue : ICCID de la carte choisie.
// → { ok, attente, coches: { carte, reseau, inscrite, internet, sms?, appel? }, ms, operateur, lue, message, sms?, appel? }
// sms et appel seulement quand l'ordre avait un numéro d'essai (ordre.appel).
function verdict({ ordre, test, simAttendue, maintenant }) {
  const avecAppel = !!(ordre && ordre.appel);
  const vide = { carte: false, reseau: false, inscrite: false, internet: false, ...(avecAppel ? { sms: false, appel: false } : {}) };
  if (!ordre || !ordre.id) {
    return { ok: false, attente: false, coches: vide, message: 'Touchez « Tester la carte » quand la carte est dans la tablette et la tablette redémarrée.' };
  }
  if (!repondA(ordre, test)) {
    const depuis = maintenant - (ms(ordre.demandeLe) || maintenant);
    return {
      ok: false, attente: true, coches: vide, depuis,
      message: depuis > (avecAppel ? SILENCE_APPEL_MS : SILENCE_MS)
        ? 'La tablette n\'a pas encore répondu. Vérifiez qu\'elle est allumée, sur l\'écran Bienvenue, avec le wifi.'
        : avecAppel
          ? 'La tablette teste la carte, puis envoie un SMS et appelle votre portable (environ une minute)…'
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
    ...(avecAppel ? { sms: !!(t.sms && t.sms.ok === true), appel: !!(t.appel && t.appel.ok === true) } : {}),
  };
  const le = ms(t.le);
  const recent = le != null && maintenant - le < FRAIS_MS;
  const smsAppel = avecAppel ? messageSmsAppel(t) : '';
  const ok = t.etat === 'ok' && carte && recent && t.itinerance !== true && coches.internet && !smsAppel;
  let message = 'La carte marche : vous pouvez passer à la suite.';
  if (ok && avecAppel) message = 'La carte marche : SMS parti et appel passé. Vous pouvez passer à la suite.';
  if (t.etat !== 'ok') message = MESSAGES[t.etat] || 'La tablette n\'a pas pu tester la carte : testez à nouveau.';
  else if (!carte) message = `Ce n'est pas la carte choisie : la tablette lit une carte qui finit par …${fin(t.iccid) || '?'}, la carte choisie finit par …${fin(simAttendue) || '?'}. Mettez la bonne carte, redémarrez la tablette, puis testez à nouveau.`;
  else if (t.itinerance === true) message = 'La carte est en itinérance : elle ne doit pas partir comme ça. Prenez une carte d\'un opérateur français.';
  else if (!coches.internet) message = MESSAGES['donnees-ko'];
  else if (smsAppel) message = smsAppel;
  else if (!recent) message = 'Ce test date de plus de 10 minutes : testez à nouveau.';
  return {
    ok, attente: false, coches, ms: t.donnees && Number.isFinite(t.donnees.ms) ? t.donnees.ms : null,
    operateur: nomOperateur(t), lue: fin(t.iccid), etat: t.etat, message,
    // Seulement quand la carte est inscrite au réseau français : la tablette ne coupe le répondeur qu'alors.
    repondeur: t.inscrite === true && t.itinerance !== true && francais ? etatRepondeur(t, maintenant) : null,
    ...(avecAppel ? {
      sms: t.sms ? { ok: t.sms.ok === true, ms: Number.isFinite(t.sms.ms) ? t.sms.ms : null } : null,
      appel: t.appel ? { ok: t.appel.ok === true, secondes: Number.isFinite(t.appel.secondes) ? t.appel.secondes : null, raison: t.appel.raison || null } : null,
    } : {}),
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
  // Test fait avec un numéro d'essai : le SMS et l'appel doivent être passés aussi.
  if (r.avecAppel === true && !(r.sms && r.sms.ok === true && r.appel && r.appel.ok === true)) {
    return `Le SMS ou l'appel d'essai de ${nom} n'est pas passé : testez à nouveau la carte (Préparer l'envoi, étape « Installer la carte SIM »).`;
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

  // Numéro d'essai du SMS et de l'appel (gestion/reglages : fermé aux applis, lu et changé par les actions admin).
  async function lireNumero() {
    return numeroEssai((await base().doc('gestion/reglages').get()).get('numeroEssai') || '');
  }

  // Action admin « simNumero » : { numero } (vide : plus de SMS ni d'appel pendant le test).
  async function noterNumero({ numero }) {
    const brut = typeof numero === 'string' ? numero.trim() : '';
    const n = brut ? numeroEssai(brut) : '';
    if (n === null) throw new HttpsError('invalid-argument', 'Notez un portable français, qui commence par 06 ou 07.');
    await base().doc('gestion/reglages').set({ numeroEssai: n }, { merge: true });
    return { ok: true, numero: numeroLisible(n) };
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
    const appel = appelPourOrdre(await lireNumero(), t.ref);
    const ordre = { id, type, demandeLe: Timestamp.fromMillis(maintenant), simAttendue: chiffres(ligne.iccid), ...(appel ? { appel } : {}) };
    await base().doc(`pairings/${choisi.code}`).update({ ordre });
    await fiche.ref.update({
      simOrdre: { id, type, demandeLe: maintenant, simAttendue: ordre.simAttendue, sim: t.simId, code: choisi.code, codes: [choisi.code], par: qui || null, ...(appel ? { appel } : {}) },
    });
    logger.info(`Carte SIM : ordre ${type} ${id} envoyé à ${nom} (code ${choisi.code})${appel ? ', avec SMS et appel d\'essai' : ''}.`);
    return { ok: true, id, code: choisi.code, ref: t.ref || null, appel: !!appel };
  }

  // Action admin « simEtat » : { stock } → l'ordre en cours et le verdict, relus toutes les 3 s par l'écran.
  async function etat({ stock }) {
    const [{ t, ligne }, numero] = await Promise.all([ficheEtCarte(stock), lireNumero()]);
    const o = t.simOrdre || null;
    const v = verdict({ ordre: o, test: t.simTest, simAttendue: (ligne && ligne.iccid) || (o && o.simAttendue), maintenant: Date.now() });
    // La carte a changé depuis l'ordre : le résultat ne vaut plus.
    if (o && ligne && ligne.iccid && !memeCarte(ligne.iccid, o.simAttendue)) Object.assign(v, { ok: false, message: 'La carte choisie a changé : testez à nouveau.' });
    return {
      ok: true, ref: t.ref || null, attendue: fin(ligne && ligne.iccid),
      ordre: o ? { id: o.id, type: o.type, demandeLe: ms(o.demandeLe), code: o.code, appel: !!o.appel } : null,
      verdict: v, numero: numeroLisible(numero),
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
        simTest: { ...r, simAttendue: o.simAttendue, ordre: o.id, type: o.type, code, ok: v.ok, avecAppel: !!o.appel, copieLe: Date.now() },
        'simOrdre.repondu': true,
      });
      return true;
    });
  }

  return { ordonner, etat, reporter, copier, noterNumero };
}

module.exports = {
  brancher, verdict, memeCarte, pairingPourOrdre, ordreDejaParti, ordreAReporter, ordreReporte, resultatPropre, refusSimNonTestee,
  idDeBase, repondA, etatRepondeur, RAISONS_REPONDEUR, REPONDEUR_MS, numeroEssai, numeroLisible, appelPourOrdre, messageSmsAppel,
  TYPES, ETATS, FRAIS_MS, DOUBLON_MS, REPORT_MS, SUFFIXE_PIN, SILENCE_MS, SILENCE_APPEL_MS, APPEL_SECONDES, RAISONS_APPEL,
};
