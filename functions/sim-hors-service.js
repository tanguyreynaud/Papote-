// Carte SIM sans réseau depuis plus de 2 h (Tanguy, 13/11) : Tanguy seul est prévenu, une fois par panne (ligne
// « À faire » de l'admin + e-mail à Papote), puis un mot quand le réseau revient. Pas d'e-mail à la famille.
// Deux cas, même délai, même alerte (le texte dit lequel) :
//   'service'   sim.service reste « hors service » (ou « urgences » : la garde de la tablette, GardeReseau.hors, la
//               compte aussi hors service ; c'est la panne T-003 du 12/11) ;
//   'antennes'  sim.antennes ne contient aucune antenne du réseau qui porte la carte (le réseau hôte : Bouygues 20820
//               pour une carte Lyca 20825 ou Auchan Télécom ; Poissy, 13/11 : rien que de l'Orange).
//
// La tablette envoie l'état de sa carte toutes les 30 min (une fois par heure la nuit) sur sa fiche,
// families/{fid}/members/{uid}.sim (Sync.java simValue, SimInfo.java, Antennes.java) :
//   sim = null                       pas de carte SIM prête : tablette pas concernée ;
//   sim.service                      'ok' | 'hors service' | 'urgences' | 'eteint' (mode avion, pas une panne) | '' ;
//   sim.antennes                     6 au plus : [{ reseau (MCC-MNC, « 20820 »), nom, type, bande, dbm, utilisee }] ;
//                                    absente (vieille tablette) ou vide (position refusée) : le cas 'antennes' ne joue pas ;
//   sim.vuLe                         heure de la tablette au moment du rapport.
// Réseau hôte : la tablette le retient depuis 68e8f8a (GardeReseau, préférence « reseauHote » = getOperatorNumeric
// quand la carte est en service) mais ne l'envoie PAS dans le rapport. Le serveur le lit donc dans sim.reseauHote si
// une tablette l'envoie un jour, sinon il l'apprend lui-même : rapport « ok » avec l'antenne utilisée (utilisee: true)
// → son réseau est noté sur la fiche (simReseauHote, une écriture seulement quand il change). Inconnu : pas de cas 'antennes'.
// Carte SIM bloquée par un code (tablette 2bfc17b : sim = { bloquee: 'pin' | 'puk' | 'verrouillee', service: 'code …',
// vuLe } au lieu de null) : une carte bloquée ne se débloque pas seule, Tanguy est prévenu DÈS le premier rapport, une
// fois par blocage (état simBloquee = { code, depuis, alerteLe } sur la fiche), et un mot quand sim.bloquee disparaît.
// Elle prime sur l'alerte 2 h : une panne « hors service » en cours est oubliée sans e-mail, sa ligne « À faire » est
// remplacée par celle du blocage, et rien n'est compté tant que la carte reste bloquée.
// La tablette redémarre seule après 20 min hors service (GardeReseau, cmnwxy 539360e) : 2 h, c'est que ça n'a pas suffi.
//
// Mécanisme : pas de tâche planifiée. compterProches (index.js) tourne déjà à chaque écriture d'une fiche membre ; il
// appelle surEcriture, qui ne regarde que les nouveaux rapports SIM d'une tablette, avec l'avant et l'après de
// l'événement (aucune lecture). État de la panne sur la fiche, à côté de sim (pas dedans : la tablette remplace
// toute la carte sim à chaque rapport) :
//   simHorsService = { depuis (heure du premier rapport en panne, horloge de la tablette), motif, alerteLe? }
// Coût : rien pour un rapport normal ; une écriture au début de la panne ; à l'alerte une transaction (1 lecture,
// 1 écriture), 3 lectures (famille, fiche de stock, commande) et une écriture dans interne/simHorsService (la ligne
// « À faire ») ; au retour une transaction, une écriture et les 3 mêmes lectures. Une tablette muette n'envoie plus
// de rapport : rien ne part d'ici (l'alerte « ne répond plus » d'alertes.js s'en occupe, pas de doublon).
// Restauration en cours : compterProches passe par base.declencheurs, qui se tait (A34).
//
// Des rapports trop espacés (plus de DELAI_MS entre deux rapports : tablette muette entre-temps) ne prouvent pas une
// panne continue : le compte repart du rapport présent (sauf si l'alerte est déjà partie : la panne dure jusqu'au
// retour du réseau).

const { FieldValue, FieldPath, Timestamp } = require('firebase-admin/firestore');
const mail = require('./mail');

// La seule constante : sans réseau depuis 2 h → Tanguy est prévenu.
const DELAI_MS = 2 * 3600_000;
const DOCUMENT = 'interne/simHorsService';
const HORS_SERVICE = ['hors service', 'urgences'];

const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : typeof v === 'number' ? v : null);
// Identité d'un rapport : son heure ; sans elle (vieille version), son contenu.
const rapport = (sim) => (sim ? ms(sim.vuLe) ?? JSON.stringify(sim) : null);

// Réseau hôte connu : envoyé par la tablette, sinon appris par le serveur.
const reseauHote = (fiche) => (fiche && ((fiche.sim && fiche.sim.reseauHote) || fiche.simReseauHote)) || null;
// Réseau à apprendre de ce rapport (carte en service, antenne utilisée connue), ou null.
function hoteVu(sim) {
  if (!sim || sim.service !== 'ok' || !Array.isArray(sim.antennes)) return null;
  const a = sim.antennes.find((x) => x && x.utilisee === true && x.reseau);
  return a ? a.reseau : null;
}

// État du réseau d'un rapport : { panne: null | 'service' | 'antennes', fin: bool } ; fin = le réseau est là.
function etatReseau(sim, hote) {
  if (!sim) return { panne: null, fin: false };
  const antennes = Array.isArray(sim.antennes) && sim.antennes.length ? sim.antennes : null;
  const hoteEntendu = antennes && hote ? antennes.some((a) => a && a.reseau === hote) : null;
  if (hoteEntendu === false) return { panne: 'antennes', fin: false };
  if (HORS_SERVICE.includes(sim.service)) return { panne: 'service', fin: false };
  return { panne: null, fin: sim.service === 'ok' || hoteEntendu === true };
}

// Blocage, sans dépendance : null ou { quoi: 'bloquee' | 'debloquee' | 'oublier', code, quand, depuis }.
// Selon l'état noté sur la fiche (simBloquee), pas selon le rapport précédent : un rapport manqué ne fait rien rater.
function deciderBlocage(apres, maintenant = Date.now()) {
  if (!apres || apres.role !== 'tablette') return null;
  const sim = apres.sim || null;
  const etat = apres.simBloquee || null;
  const quand = (sim && ms(sim.vuLe)) || maintenant;
  const code = sim && sim.bloquee ? String(sim.bloquee) : null;
  if (code) return etat && etat.code === code ? null : { quoi: 'bloquee', code, quand };
  if (!etat) return null;
  // Plus de carte du tout (retirée) : oubliée sans e-mail ; une carte lue sans blocage : débloquée.
  return { quoi: sim ? 'debloquee' : 'oublier', code: etat.code, quand, depuis: ms(etat.depuis) };
}

// Décision, sans dépendance. avant, apres : données de la fiche (ou null) ; maintenant : repli si le rapport n'a
// pas d'heure. Renvoie null (rien à faire) ou { quoi: 'debut' | 'alerte' | 'revenu' | 'oublier' | 'hote', depuis,
// quand, motif, hote } ; hote : réseau hôte à noter sur la fiche en même temps (ou seul : quoi 'hote').
function decider(avant, apres, maintenant = Date.now()) {
  if (!apres || apres.role !== 'tablette') return null;
  const simAvant = avant ? avant.sim : null;
  const sim = apres.sim || null;
  if (rapport(simAvant) === rapport(sim)) return null; // pas un nouveau rapport (autre champ de la fiche)
  const vu = hoteVu(sim);
  const hote = vu && vu !== apres.simReseauHote && !(sim && sim.reseauHote) ? vu : null;
  const etat = apres.simHorsService || null;
  const depuis = etat ? ms(etat.depuis) : null;
  const quand = (sim && ms(sim.vuLe)) || maintenant;
  const r = etatReseau(sim, reseauHote(apres) || vu);
  const rien = hote ? { quoi: 'hote', hote } : null;
  if (r.panne) {
    if (!etat || !depuis) return { quoi: 'debut', quand, motif: r.panne, hote };
    if (etat.alerteLe) return rien; // déjà prévenu pour cette panne
    const precedent = simAvant && ms(simAvant.vuLe);
    const suivi = etatReseau(simAvant, reseauHote(avant) || reseauHote(apres)).panne && (!precedent || quand - precedent <= DELAI_MS);
    if (!suivi) return { quoi: 'debut', quand, motif: r.panne, hote };
    return quand - depuis >= DELAI_MS ? { quoi: 'alerte', depuis, quand, motif: r.panne, hote } : rien;
  }
  if (!etat) return rien;
  // Réseau revenu : le mot à Tanguy s'il avait été prévenu. Plus de carte SIM : la panne est oubliée sans e-mail.
  if (r.fin) return { quoi: 'revenu', depuis, quand, motif: etat.motif || 'service', hote };
  if (!sim) return { quoi: 'oublier', depuis, quand, motif: etat.motif || 'service', hote };
  return rien; // mode avion, état illisible : on attend le prochain rapport
}

const heure = (t) => new Date(t).toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).replace(':', ' h ');
const duree = (d) => {
  const min = Math.max(0, Math.round(d / 60000));
  const h = Math.floor(min / 60);
  return h ? `${h} h${min % 60 ? ` ${String(min % 60).padStart(2, '0')}` : ''}` : `${min} min`;
};
const cle = (fid, uid) => `${fid}_${uid}`;

// Lignes « À faire » (accueil de l'admin, récap du lundi) : une par panne signalée et pas encore revenue.
function lignesAFaire(doc) {
  const pannes = Object.values((doc && doc.pannes) || {}).filter((p) => p && ms(p.depuis));
  return pannes.sort((a, b) => ms(a.depuis) - ms(b.depuis)).map((p) => {
    if (p.motif === 'bloquee') return `Carte SIM bloquée depuis le ${heure(ms(p.depuis))} : tablette ${p.ref ? `${p.ref} ` : ''}de ${p.nom || 'Mamie'}. ${CONSIGNE[p.code] || CONSIGNE.verrouillee}`;
    const qui = `tablette ${p.ref ? `${p.ref} ` : ''}de ${p.nom || 'Mamie'}${p.operateur ? ` (${p.operateur})` : ''}`;
    return p.motif === 'antennes'
      ? `Carte SIM sans antenne de son réseau depuis le ${heure(ms(p.depuis))} : ${qui}. Aucune antenne ${p.hote || ''} chez le client, redémarrer n'y fera rien : changer de carte SIM (autre réseau)`
      : `Carte SIM hors service depuis le ${heure(ms(p.depuis))} : ${qui}. Elle a déjà redémarré seule : appeler le client (retirer et remettre la carte), sinon changer de carte`;
  });
}

// Que faire, selon le blocage (lignes « À faire » ; l'e-mail en dit plus : mail.alerteSimBloquee).
const CONSIGNE = {
  pin: 'Code PIN demandé : mettre la carte dans un téléphone, saisir le code PIN et désactiver la demande de code, puis la remettre',
  puk: 'Code PUK demandé (3 codes PIN faux) : demander le code PUK à l\'opérateur, le saisir dans un téléphone, sinon changer de carte',
  verrouillee: 'Carte verrouillée par l\'opérateur : appeler l\'opérateur pour la déverrouiller, sinon changer de carte',
};

// Qui est la tablette : nom de la famille, fiche de stock (référence T-00x) et commande, lus seulement à l'alerte.
async function contexte(db, fid, uid) {
  const [fam, fiches, commandes] = await Promise.all([
    db.doc(`families/${fid}`).get(),
    db.collection('stock').where('tabletUid', '==', uid).limit(1).get(),
    db.collection('commandes').where('fid', '==', fid).limit(1).get(),
  ]);
  const fiche = fiches.docs[0];
  return {
    nom: (fam.exists && fam.get('name')) || 'Mamie',
    ref: fiche ? fiche.get('ref') || fiche.get('numero') || null : null,
    commande: commandes.docs[0] ? commandes.docs[0].id : null,
  };
}

// Appelé par compterProches à chaque écriture d'une fiche membre. prevenir(contenu) : e-mail à Papote (index.js).
// Renvoie la décision prise ('debut', 'alerte', 'revenu', 'oublier', 'hote') ou null.
async function surEcriture({ db, fid, uid, avant, apres, prevenir, logger, maintenant = Date.now() }) {
  const ref = db.doc(`families/${fid}/members/${uid}`);
  const b = deciderBlocage(apres, maintenant);
  const fait = b ? await surBlocage({ db, fid, uid, ref, b, prevenir, logger }) : null;
  // Carte bloquée : l'alerte « bloquée » prime, pas de compte des 2 h (la panne en cours a été oubliée par surBlocage).
  if (apres && apres.sim && apres.sim.bloquee) return fait;
  const d = decider(avant, apres, maintenant);
  if (!d) return fait;
  const noterHote = d.hote ? { simReseauHote: d.hote } : {};
  if (d.quoi === 'hote') {
    await ref.update(noterHote);
    return 'hote';
  }
  if (d.quoi === 'debut') {
    await ref.update({ ...noterHote, simHorsService: { depuis: Timestamp.fromMillis(d.quand), motif: d.motif } });
    return 'debut';
  }
  const operateur = (apres.sim && apres.sim.operateur) || null;
  const hote = d.hote || reseauHote(apres);
  if (d.quoi === 'alerte') {
    // Événement livré deux fois : une seule alerte.
    const pris = await db.runTransaction(async (t) => {
      const s = await t.get(ref);
      const e = s.exists ? s.get('simHorsService') : null;
      if (!e || e.alerteLe || ms(e.depuis) !== d.depuis) return false;
      t.update(ref, { ...noterHote, 'simHorsService.alerteLe': Timestamp.fromMillis(d.quand), 'simHorsService.motif': d.motif });
      return true;
    });
    if (!pris) return null;
    const c = await contexte(db, fid, uid);
    await db.doc(DOCUMENT).set({ pannes: { [cle(fid, uid)]: {
      fid, uid, nom: c.nom, ref: c.ref, operateur, motif: d.motif, hote: hote || null,
      depuis: Timestamp.fromMillis(d.depuis), alerteLe: Timestamp.fromMillis(d.quand),
    } } }, { merge: true });
    await prevenir(mail.alerteSimHorsService({ nom: c.nom, famille: fid, ref: c.ref, operateur, motif: d.motif, hote, service: (apres.sim && apres.sim.service) || null, depuis: d.depuis, duree: duree(d.quand - d.depuis), commande: c.commande }));
    logger.info(`Famille ${fid}, tablette ${uid} : carte SIM sans réseau (${d.motif}) depuis ${duree(d.quand - d.depuis)}, Papote prévenu`);
    return 'alerte';
  }
  // revenu ou oublier : l'état est effacé une fois ; le mot ne part que si l'alerte était partie.
  const alerte = await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    const e = s.exists ? s.get('simHorsService') : null;
    if (!e) return null;
    t.update(ref, { ...noterHote, simHorsService: FieldValue.delete() });
    return e.alerteLe ? e : false;
  });
  if (alerte === null) return null;
  if (alerte) {
    await db.doc(DOCUMENT).update(new FieldPath('pannes', cle(fid, uid)), FieldValue.delete()).catch((e) => {
      if (e.code !== 5) throw e; // pas de relevé : rien à retirer
    });
    if (d.quoi === 'revenu') {
      const c = await contexte(db, fid, uid);
      await prevenir(mail.alerteSimHorsService({ nom: c.nom, famille: fid, ref: c.ref, operateur, motif: alerte.motif || 'service', hote, depuis: ms(alerte.depuis), duree: duree(d.quand - ms(alerte.depuis)), revenu: true, commande: c.commande }));
    }
    logger.info(`Famille ${fid}, tablette ${uid} : carte SIM ${d.quoi === 'revenu' ? 'de nouveau sur son réseau' : 'retirée'}, ligne « À faire » levée`);
  }
  return d.quoi;
}

// Blocage : alerte tout de suite (une fois par blocage, transaction), ou mot de fin quand la carte est débloquée.
async function surBlocage({ db, fid, uid, ref, b, prevenir, logger }) {
  const k = cle(fid, uid);
  if (b.quoi === 'bloquee') {
    const pris = await db.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists || (s.get('simBloquee') && s.get('simBloquee').code === b.code)) return false;
      // La panne « hors service » en cours est remplacée par le blocage : pas de 2e alerte, pas de « revenue ».
      t.update(ref, { simBloquee: { code: b.code, depuis: Timestamp.fromMillis(b.quand), alerteLe: Timestamp.fromMillis(b.quand) }, simHorsService: FieldValue.delete() });
      return true;
    });
    if (!pris) return null;
    const c = await contexte(db, fid, uid);
    await db.doc(DOCUMENT).set({ pannes: { [k]: {
      fid, uid, nom: c.nom, ref: c.ref, motif: 'bloquee', code: b.code, depuis: Timestamp.fromMillis(b.quand), alerteLe: Timestamp.fromMillis(b.quand),
    } } }, { merge: true });
    await prevenir(mail.alerteSimBloquee({ nom: c.nom, famille: fid, ref: c.ref, code: b.code, depuis: b.quand, commande: c.commande }));
    logger.info(`Famille ${fid}, tablette ${uid} : carte SIM bloquée (${b.code}), Papote prévenu`);
    return 'bloquee';
  }
  const etait = await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    const e = s.exists ? s.get('simBloquee') : null;
    if (!e) return null;
    t.update(ref, { simBloquee: FieldValue.delete() });
    return e;
  });
  if (!etait) return null;
  await db.doc(DOCUMENT).update(new FieldPath('pannes', k), FieldValue.delete()).catch((e) => {
    if (e.code !== 5) throw e;
  });
  if (b.quoi === 'debloquee') {
    const c = await contexte(db, fid, uid);
    await prevenir(mail.alerteSimBloquee({ nom: c.nom, famille: fid, ref: c.ref, code: etait.code, depuis: ms(etait.depuis), duree: duree(b.quand - ms(etait.depuis)), debloquee: true, commande: c.commande }));
  }
  logger.info(`Famille ${fid}, tablette ${uid} : carte SIM ${b.quoi === 'debloquee' ? 'débloquée' : 'retirée'}, ligne « À faire » levée`);
  return b.quoi;
}

module.exports = { surEcriture, decider, deciderBlocage, CONSIGNE, etatReseau, lignesAFaire, duree, DELAI_MS, DOCUMENT };
