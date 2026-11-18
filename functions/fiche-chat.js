// Fiche du compte pour le chat de support (supportChat, support.js) : lecture seule, jamais d'action.
//
// Chantier 2 du chat (validé par Tanguy le 18/11) : le chat voit l'état du compte de la personne qui écrit.
//
//   Dans l'appli famille, la bulle (vitrine/chat-support.js) envoie le jeton de connexion (Authorization: Bearer …)
//   et la famille ouverte ({ famille: fid }). quiEcrit vérifie le jeton et que la personne est bien membre active de
//   CETTE famille (pas la tablette) : sinon le chat répond comme avant, sans fiche.
//   lireFamille lit, champ par champ (select / fieldMask, comme ia-admin.js), l'état de la tablette, l'abonnement,
//   la carte SIM, la commande et le colis, les réglages ; resumeFamille en fait quelques lignes pour l'IA.
//   Jamais de téléphone, d'adresse, d'e-mail, de nom d'un autre membre, d'IBAN ni de photo : ces champs ne sont
//   même pas lus. Les détails de paiement (impayé, prochain prélèvement, arrêt prévu) ne sont donnés qu'aux
//   responsables (propriétaire et responsables nommés), qui seuls peuvent agir sur l'abonnement.
//
//   Sur le site (personne non connectée) : suivi de commande avec le code de commande ET l'e-mail de la commande,
//   écrits dans la conversation (jamais un seul des deux). trouverCodeEmail les cherche dans les derniers messages
//   de la personne ; lireCommande ne répond que si les deux correspondent à la même commande.
//
// Rien n'est écrit en base ici. Le chat ne fait aucune action, surtout pas sur l'argent : il lit, explique, et dit
// quel bouton de l'appli toucher (c'est la personne qui appuie).

const ABONNEMENTS = {
  actif: 'actif',
  impaye: 'paiement en retard',
  suspendu: 'en pause pour impayé (la tablette est en pause)',
  resilie: 'résilié (terminé)',
  aucun: 'aucun abonnement en cours',
  offert: 'offert (rien à payer)',
  installation: 'en cours d’installation (pas encore commencé)',
};
const ROLES = { proprietaire: 'propriétaire du compte (a créé la famille)', responsable: 'responsable de la famille', membre: 'proche (membre de la famille, pas responsable)' };
const ALPHABET_CODE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MESSAGES_FOUILLES = 6; // derniers messages de la personne où chercher le code de commande et l'e-mail

function enMillis(v) {
  if (v == null) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function ilYA(ms, maintenant) {
  const min = Math.max(0, Math.round((maintenant - ms) / 60000));
  if (min < 2) return 'à l’instant';
  if (min < 60) return `il y a ${min} min`;
  if (min < 48 * 60) return `il y a ${Math.round(min / 60)} h`;
  return `il y a ${Math.round(min / 1440)} jours`;
}

const date = (ms) => new Date(ms).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });
// Texte court sans retour à la ligne ni crochet : un nom de famille ne peut pas glisser une consigne ou une balise.
const court = (v, max = 40) => String(v == null ? '' : v).replace(/[\r\n[\]<>{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const idSur = (v) => (typeof v === 'string' && /^[\w.-]{1,128}$/.test(v) ? v : null);

// ---------- Qui écrit (appli) ----------

// null (chat sans fiche) ou { uid, fid, role, famille }. verifier = admin.auth().verifyIdToken.
// Jamais d'exception : un jeton absent, expiré ou faux, une famille inconnue, un membre en attente ou la tablette
// elle-même donnent null.
async function quiEcrit(req, { db, verifier }) {
  try {
    const entete = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
    const m = entete.match(/^Bearer\s+([\w.-]{20,4096})$/);
    const fid = idSur(req.body && req.body.famille);
    if (!m || !fid) return null;
    const jeton = await verifier(m[1]);
    const uid = jeton && idSur(jeton.uid);
    if (!uid) return null;
    const base = db();
    const [famille, membre] = await Promise.all([
      base.doc(`families/${fid}`).get(),
      base.doc(`families/${fid}/members/${uid}`).get(),
    ]);
    if (!famille.exists || !membre.exists) return null;
    if ((membre.get('status') || 'active') === 'pending' || membre.get('role') === 'tablette') return null;
    const createdBy = famille.get('createdBy');
    const admins = famille.get('admins') || [];
    const role = createdBy === uid ? 'proprietaire' : (Array.isArray(admins) && admins.includes(uid) ? 'responsable' : 'membre');
    return { uid, fid, role, famille };
  } catch (e) {
    return null;
  }
}

// ---------- Lecture (appli) ----------

// Lecture seule, seulement les champs utiles. famille : l'instantané déjà lu par quiEcrit.
async function lireFamille(db, { fid, famille }) {
  const base = db();
  const f = (p) => famille.get(p);
  const abonnement = {
    statut: f('abonnement.statut'), graceJusqua: f('abonnement.graceJusqua'), finPeriode: f('abonnement.finPeriode'),
    essaiJusqua: f('abonnement.essaiJusqua'), resiliationLe: f('abonnement.resiliationLe'), formule: f('abonnement.formule'),
    commande: idSur(f('abonnement.stripeSubscriptionId')),
  };
  const [membres, stock] = await Promise.all([
    base.collection(`families/${fid}/members`)
      .select('role', 'status', 'lastOnline', 'lastSeen', 'lastActive', 'battery.level', 'battery.charging', 'battery.unpluggedAt',
        'wifi.ssid', 'sim.reseau', 'sim.signal', 'sim.dataMoisMo', 'appVersion').get(),
    base.collection('stock').where('fid', '==', fid).select('ref', 'etat', 'simId', 'commande').get(),
  ]);
  const tous = membres.docs.map((d) => ({ id: d.id, ...lireChamps(d, ['role', 'status', 'lastOnline', 'lastSeen', 'lastActive', 'battery', 'wifi', 'sim', 'appVersion']) }));
  const tablettes = tous.filter((m) => m.role === 'tablette');
  const fiches = stock.docs.map((d) => ({ id: d.id, ref: d.get('ref'), etat: d.get('etat'), simId: idSur(d.get('simId')), commande: idSur(d.get('commande')) }));
  const simId = (fiches.find((t) => t.etat === 'chez-client' && t.simId) || fiches.find((t) => t.simId) || {}).simId;
  const [sim, commande] = await Promise.all([
    simId ? base.doc(`sims/${simId}`).get().then((s) => (s.exists ? { statut: s.get('statut'), go: s.get('go'), prochaineRecharge: s.get('prochaineRecharge') } : null)) : null,
    abonnement.commande ? lireDocCommande(base, abonnement.commande) : null,
  ]);
  return {
    nom: f('name'),
    nomAChoisir: f('nomAChoisir') === true,
    veille: f('veille'),
    abonnement,
    tablettes,
    proches: tous.filter((m) => m.role !== 'tablette' && (m.status || 'active') !== 'pending').length,
    enAttente: tous.filter((m) => m.role !== 'tablette' && m.status === 'pending').length,
    stock: fiches,
    sim,
    commande,
  };
}

function lireChamps(snap, champs) {
  const r = {};
  for (const c of champs) { const v = snap.get(c); if (v !== undefined) r[c] = v; }
  return r;
}

const CHAMPS_COMMANDE = ['code', 'expedition', 'envoyeeLe', 'suivi', 'livraison.cp', 'remise', 'preparation.recuLe',
  'restitution.statut', 'restitution.avant', 'pause.jusqua', 'creeLe'];

async function lireDocCommande(base, id) {
  const [s] = await base.getAll(base.doc(`commandes/${id}`), { fieldMask: CHAMPS_COMMANDE });
  if (!s || !s.exists) return null;
  return {
    code: s.get('code'), expedition: s.get('expedition'), envoyeeLe: s.get('envoyeeLe'), suivi: s.get('suivi'), cp: s.get('livraison.cp'),
    remise: s.get('remise'), recuLe: s.get('preparation.recuLe'), restitution: s.get('restitution.statut') ? { statut: s.get('restitution.statut'), avant: s.get('restitution.avant') } : null,
    pauseJusqua: s.get('pause.jusqua'), creeLe: s.get('creeLe'),
  };
}

// ---------- Résumé pour l'IA ----------

function lienSuivi(suivi, cp) {
  const p = new URLSearchParams({ numeroExpedition: suivi });
  if (cp) p.set('codePostal', cp);
  return `https://www.mondialrelay.fr/suivi-de-colis/?${p}`;
}

// Étape de la commande et du colis, en clair. c : commande lue par lireDocCommande.
function lignesCommande(c, maintenant) {
  if (!c) return [];
  const l = [];
  const recu = enMillis(c.recuLe);
  const envoyee = enMillis(c.envoyeeLe);
  if (c.expedition === 'annulee') l.push('Commande : annulée.');
  else if (c.expedition === 'paiement-en-attente') l.push('Commande : enregistrée, la banque n’a pas encore confirmé le premier prélèvement SEPA (quelques jours) ; la tablette part ensuite.');
  else if (c.expedition === 'a-preparer') l.push('Commande : payée, tablette en préparation, pas encore envoyée.');
  else if (recu) l.push(`Commande : tablette ${c.remise === 'main-propre' ? 'remise en main propre' : 'reçue (colis retiré)'} le ${date(recu)}.`);
  else if (envoyee || c.expedition === 'envoyee') {
    const suivi = typeof c.suivi === 'string' && /^[A-Z0-9]{6,30}$/.test(c.suivi) ? c.suivi : null;
    l.push(`Commande : colis envoyé${envoyee ? ` le ${date(envoyee)}` : ''} en point relais Mondial Relay, pas encore noté comme retiré.${suivi ? ` Lien de suivi du colis : ${lienSuivi(suivi, typeof c.cp === 'string' ? c.cp.slice(0, 10) : '')}` : ''}`);
  }
  const pause = enMillis(c.pauseJusqua);
  if (pause && pause > maintenant) l.push(`Pause hospitalisation en cours jusqu’au ${date(pause)}.`);
  if (c.restitution) {
    const avant = enMillis(c.restitution.avant);
    const etats = { attendue: 'tablette à renvoyer', 'en-route': 'tablette renvoyée, colis de retour en route', recue: 'tablette renvoyée et bien reçue par Papote', facturee: 'tablette jamais rendue, matériel facturé', echec: 'tablette jamais rendue, prélèvement du matériel refusé' };
    l.push(`Retour de la tablette : ${etats[c.restitution.statut] || court(c.restitution.statut, 20)}${avant && c.restitution.statut === 'attendue' ? `, au plus tard le ${date(avant)}` : ''} (appli : Profil, « Abonnement », « Je renvoie la tablette »).`);
  }
  return l;
}

// Une ligne par tablette : en ligne ou non, Wi-Fi ou carte SIM, batterie, vue ou touchée, version.
function ligneTablette(t, maintenant) {
  const m = [];
  const vu = enMillis(t.lastOnline);
  if (!vu) m.push('jamais connectée pour l’instant');
  else if (maintenant - vu < 70 * 60_000) m.push(`en ligne (dernier signe de vie ${ilYA(vu, maintenant)})`);
  else m.push(`hors ligne depuis ${ilYA(vu, maintenant).replace('il y a ', '')} (dernier signe de vie le ${date(vu)})`);
  if (t.wifi && t.wifi.ssid) m.push('sur le Wi-Fi');
  else if (t.sim && t.sim.reseau) m.push(`sur la carte SIM (${court(t.sim.reseau, 8)}${Number.isFinite(t.sim.signal) && t.sim.signal >= 0 ? `, signal ${t.sim.signal} sur 4` : ''})`);
  const b = t.battery || {};
  if (Number.isFinite(b.level)) {
    const debranchee = enMillis(b.unpluggedAt);
    m.push(`batterie ${Math.round(b.level)} %, ${b.charging ? 'branchée' : `débranchée${debranchee ? ` depuis ${ilYA(debranchee, maintenant).replace('il y a ', '')}` : ''}`}`);
  }
  const regardee = enMillis(t.lastSeen);
  const touchee = enMillis(t.lastActive);
  if (regardee) m.push(`quelqu’un vu devant l’écran ${ilYA(regardee, maintenant)}`);
  if (touchee) m.push(`écran touché ${ilYA(touchee, maintenant)}`);
  if (typeof t.appVersion === 'string' && /^[\w.-]{1,20}$/.test(t.appVersion)) m.push(`version ${t.appVersion}`);
  return `Tablette : ${m.join(' ; ')}.`;
}

// Fiche pour l'IA, en quelques lignes. d : lireFamille ; qui : quiEcrit.
function resumeFamille(d, qui, maintenant) {
  const l = [];
  const responsable = qui.role !== 'membre';
  l.push(`Personne qui écrit : ${ROLES[qui.role]}.`);
  if (d.nom && !d.nomAChoisir) l.push(`Nom donné à la tablette : « ${court(d.nom)} ».`);
  // Une tablette a deux comptes (affichage et appels, Sync.java) : seul celui qui donne des nouvelles compte. On garde
  // celui vu en ligne le plus récemment, comme l'appli (famille.js, targetTablet).
  const tablette = d.tablettes.slice().sort((x, y) => (enMillis(y.lastOnline) || 0) - (enMillis(x.lastOnline) || 0))[0];
  l.push(tablette ? ligneTablette(tablette, maintenant) : 'Tablette : pas encore reliée à la famille.');

  const abo = d.abonnement || {};
  if (abo.statut) {
    let a = `Abonnement : ${ABONNEMENTS[abo.statut] || court(abo.statut, 20)}`;
    if (responsable) {
      const grace = enMillis(abo.graceJusqua);
      if (abo.statut === 'impaye' && grace) a += `, la tablette se mettra en pause le ${date(grace)} si rien n’est réglé`;
      const arret = enMillis(abo.resiliationLe);
      if (arret && ['actif', 'impaye'].includes(abo.statut)) a += `, arrêt demandé : l’abonnement s’arrête le ${date(arret)}`;
      const fin = enMillis(abo.finPeriode);
      const essai = enMillis(abo.essaiJusqua);
      if (abo.statut === 'actif' && !arret && essai && essai > maintenant) a += `, premier prélèvement le ${date(essai)}`;
      else if (abo.statut === 'actif' && !arret && fin && fin > maintenant) a += `, prochain prélèvement le ${date(fin)}`;
    }
    l.push(`${a}.`);
    if (!responsable && ['impaye', 'suspendu', 'resilie'].includes(abo.statut)) {
      l.push('Les détails du paiement ne sont visibles que d’un responsable de la famille : c’est lui qui règle, depuis son téléphone.');
    }
  }

  const sim = d.sim;
  if (sim) {
    const s = [];
    if (sim.statut) s.push(sim.statut === 'active' ? 'active' : sim.statut === 'suspendue' ? 'suspendue' : court(sim.statut, 20));
    const t = d.tablettes.find((x) => x.sim && Number.isFinite(x.sim.dataMoisMo) && x.sim.dataMoisMo >= 0);
    const forfaitMo = Number.isFinite(sim.go) ? Math.round(sim.go * 1000) : null;
    if (t) s.push(`internet consommé ce mois-ci : ${Math.round(t.sim.dataMoisMo)} Mo${forfaitMo ? ` sur ${forfaitMo} Mo` : ''}`);
    const recharge = enMillis(sim.prochaineRecharge);
    if (recharge && recharge > maintenant) s.push(`forfait renouvelé le ${date(recharge)}`);
    if (s.length) l.push(`Carte SIM de la tablette : ${s.join(', ')}.`);
  }

  l.push(...lignesCommande(d.commande, maintenant));

  l.push(`Famille : ${d.proches} ${d.proches > 1 ? 'proches' : 'proche'} dans l’appli${responsable && d.enAttente ? `, ${d.enAttente} ${d.enAttente > 1 ? 'demandes' : 'demande'} pour rejoindre en attente (appli : Réglages, « Membres »)` : ''}.`);
  const v = d.veille;
  if (v && typeof v === 'object') {
    const h = (x, mn) => `${Number(x) || 0} h${mn ? String(mn).padStart(2, '0') : ''}`;
    l.push(v.active === false ? 'Écran éteint la nuit : désactivé.' : `Écran éteint la nuit : de ${h(v.de, v.deMin)} à ${h(v.a, v.aMin)}.`);
  }
  return l.join('\n');
}

// Consigne qui accompagne la fiche : lue après le bloc du guide mis en cache.
function blocFiche(texte, maintenant) {
  return `# Fiche du compte de la personne (lue à l’instant, ${new Date(maintenant).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}, heure de Paris)

Ces informations viennent directement du compte de la personne qui écrit : tu peux t’en servir pour répondre (« votre tablette est hors ligne depuis hier soir »), même si tes consignes disent que tu ne peux rien consulter. Tu ne peux toujours rien modifier ni déclencher : pour agir, donne le bouton de l’appli à toucher. N’affirme rien qui n’est pas écrit ici. Ne recopie pas toute la fiche : cite seulement ce qui aide à répondre.

${texte}`;
}

// ---------- Suivi de commande (site) ----------

// Code de commande tel qu'il est affiché (« ABCD-EFGH », casse indifférente) ou collé en majuscules avec au moins un
// chiffre (« ABCD2345 », « ABCD 2345 ») : jamais deux mots ordinaires (« avec deux », « PARTAGER »).
function codeDans(t) {
  const L = `[${ALPHABET_CODE}]`;
  const tiret = t.toUpperCase().match(new RegExp(`(?:^|[^A-Z0-9])(${L}{4})[-‐‑–](${L}{4})(?![A-Z0-9])`));
  if (tiret) return tiret[1] + tiret[2];
  const colle = t.match(new RegExp(`(?:^|[^A-Za-z0-9])(${L}{4}) ?(${L}{4})(?![A-Za-z0-9])`));
  if (colle && /\d/.test(colle[1] + colle[2])) return colle[1] + colle[2];
  return null;
}

// Code de commande (8 caractères, « ABCD-EFGH ») et e-mail écrits par la personne dans ses derniers messages.
function trouverCodeEmail(messages) {
  const textes = (messages || []).filter((m) => m && m.role === 'user' && typeof m.content === 'string').slice(-MESSAGES_FOUILLES).map((m) => m.content);
  let code = null;
  let email = null;
  for (const t of textes.reverse()) {
    if (!email) { const e = t.match(/[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[a-z]{2,}/i); if (e) email = e[0].toLowerCase().replace(/[.]+$/, ''); }
    if (!code) code = codeDans(t);
  }
  return code && email ? { code, email } : null;
}

// Commande dont le code ET l'e-mail correspondent, ou null. Seuls les champs du suivi sont renvoyés.
async function lireCommande(db, { code, email }) {
  const base = db();
  const trouvees = await base.collection('commandes').where('code', '==', code).limit(1).get();
  const doc = trouvees.empty ? null : trouvees.docs[0];
  if (!doc || String(doc.get('email') || '').trim().toLowerCase() !== email) return null;
  return lireDocCommande(base, doc.id);
}

function blocCommande(c, maintenant) {
  if (!c) {
    return '# Suivi de commande\n\nLa personne a donné un code de commande et une adresse e-mail, mais aucune commande ne correspond aux deux ensemble. Dis-le simplement, et demande de vérifier le code et l’adresse sur l’e-mail de confirmation de commande. Ne dis pas lequel des deux ne va pas.';
  }
  const l = lignesCommande(c, maintenant);
  return `# Suivi de commande (lu à l’instant)

La personne a donné le code de commande et l’adresse e-mail de la commande : voici où en est SA commande. Tu peux t’en servir pour répondre, même si tes consignes disent que tu ne peux rien consulter. Tu ne peux rien modifier.

${l.length ? l.join('\n') : 'Commande enregistrée.'}`;
}

module.exports = { quiEcrit, lireFamille, resumeFamille, blocFiche, trouverCodeEmail, lireCommande, blocCommande };
module.exports._test = { lignesCommande, ligneTablette, court, enMillis };
