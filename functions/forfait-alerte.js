// Alerte de fin du forfait internet de la carte SIM (Tanguy, 5/11), lancée toutes les heures par taches.js.
//
// La tablette envoie sur sa fiche (members/{uid}.sim, Sync.java) les Mo passés par la carte depuis le début du
// forfait : { dataCycleMo, plafondMo, niveau, cycleDebut }. Le serveur écrit sur la famille ce que fait l'opérateur
// au bout du forfait (families/{fid}.forfaitSim.finForfait, gestion.js) :
//   'reduit'  débit réduit (Lyca, Bouygues) : les appels vidéo seront plus lents jusqu'au forfait suivant ;
//   'bloque'  internet coupé (Sosh 1 Go bloqué) jusqu'au forfait suivant.
//
// Une fois par forfait et par seuil (ce qui est parti est noté sur la fiche : alerteForfait) :
//   80 % et 95 %   e-mail à Papote (même canal que les autres alertes admin : mail.alerteForfait → alerteAdmin) ;
//   95 %           e-mail calme aux responsables de la famille (mail.forfaitPresqueEpuise), en journée seulement ;
//   'bloque' passé 95 % puis silencieuse : e-mail à Papote « internet sans doute coupé par le forfait », pas une panne.
// La décision est dans decider(), sans dépendance (forfait-alerte.test.js).

const { logger } = require('firebase-functions/v2');
const { db: base } = require('./base');
const mail = require('./mail');
const journal = require('./journal-alertes');

const SEUILS = [80, 95];
const SEUIL_FAMILLE = 95;
const CYCLE_JOURS = 30; // Forfait.CYCLE_MS de la tablette : un pass « debut » repart tous les 30 jours
// Silencieuse depuis plus de 2 h (la tablette se signale toutes les 30 min sur la SIM, une fois par heure la nuit).
const SILENCE_MS = 2 * 3600_000;
// E-mail à la famille seulement en journée (heure de Paris) ; la nuit, il attend le matin.
const JOURNEE = { de: 8, a: 21 };

function enMillis(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return typeof v === 'number' ? v : null;
}

const finForfaitDe = (forfaitSim) => (forfaitSim && forfaitSim.finForfait === 'bloque' ? 'bloque' : 'reduit');

function jourParis(ms) {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms));
}
function heureParis(ms) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms)));
}

// Jour « AAAA-MM-JJ » où le forfait repart, d'après le début du cycle lu par la tablette : 30 jours après pour un
// pass (forfaitSim.debut), le même jour le mois suivant sinon (forfaitSim.jour, comme Forfait.debutCycle).
function finDuCycle(cycleDebut, forfaitSim) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cycleDebut || '');
  if (!m) return null;
  const [a, mo, j] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const d = forfaitSim && forfaitSim.debut ? new Date(Date.UTC(a, mo, j + CYCLE_JOURS)) : new Date(Date.UTC(a, mo + 1, j));
  return d.toISOString().slice(0, 10);
}

// Midi (UTC) du jour « AAAA-MM-JJ » : une date sans heure, affichée telle quelle à Paris.
const jourEnMs = (jour) => Date.parse(`${jour}T12:00:00Z`);

// Ce que la fiche de la tablette dit du forfait en cours, ou null (pas de SIM, pas de limite, cycle fini).
function etatForfait(tablette, forfaitSim, maintenant) {
  const sim = tablette && tablette.sim;
  if (!sim || !(sim.plafondMo > 0) || !(sim.dataCycleMo >= 0)) return null;
  const fin = finDuCycle(sim.cycleDebut, forfaitSim);
  // Cycle terminé : le forfait est reparti, la tablette enverra le nouveau.
  if (!fin || jourParis(maintenant) >= fin) return null;
  const vue = enMillis(tablette.lastOnline);
  return {
    pourCent: Math.floor((sim.dataCycleMo * 100) / sim.plafondMo),
    conso: sim.dataCycleMo, plafond: sim.plafondMo,
    cycle: sim.cycleDebut, fin, type: finForfaitDe(forfaitSim),
    silencieuse: Boolean(vue) && maintenant - vue > SILENCE_MS,
  };
}

// Forfait 'bloque' passé 95 % pendant le forfait en cours : si la tablette se tait (alertes.js le décide), internet
// est sans doute coupé par l'opérateur. Renvoie le jour où il revient (« AAAA-MM-JJ »), sinon null. Sert à adoucir
// l'alerte « ne répond plus » envoyée aux téléphones de la famille.
function coupeeParForfait(tablette, forfaitSim, maintenant) {
  const e = etatForfait(tablette, forfaitSim, maintenant);
  return e && e.type === 'bloque' && e.pourCent >= SEUIL_FAMILLE ? e.fin : null;
}

// Ce qu'il faut envoyer maintenant, d'après l'état et ce qui est déjà parti pour ce forfait (deja = alerteForfait).
// Renvoie { admin: seuil | null, famille: bool, coupee: bool, note } ; note = nouvel alerteForfait si tout part.
function decider(etat, deja, maintenant) {
  const rien = { admin: null, famille: false, coupee: false, note: null };
  if (!etat) return rien;
  const avant = deja && deja.cycle === etat.cycle ? deja : { cycle: etat.cycle, admin: [] };
  const atteints = SEUILS.filter((s) => etat.pourCent >= s);
  const nouveaux = atteints.filter((s) => !(avant.admin || []).includes(s));
  // Deux seuils passés d'un coup (tablette longtemps sans nouvelles) : un seul e-mail, au plus haut.
  const admin = nouveaux.length ? Math.max(...nouveaux) : null;
  const h = heureParis(maintenant);
  const famille = etat.pourCent >= SEUIL_FAMILLE && !avant.famille && h >= JOURNEE.de && h < JOURNEE.a;
  const coupee = etat.type === 'bloque' && etat.silencieuse && etat.pourCent >= SEUIL_FAMILLE && !avant.coupee;
  if (!admin && !famille && !coupee) return rien;
  return {
    admin, famille, coupee,
    note: {
      cycle: etat.cycle,
      admin: [...new Set([...(avant.admin || []), ...atteints])].sort((a, b) => a - b),
      ...(avant.famille || famille ? { famille: true } : {}),
      ...(avant.coupee || coupee ? { coupee: true } : {}),
    },
  };
}

const jourTexte = (jour) => new Date(jourEnMs(jour)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });

// E-mail à Papote (mail.alerteForfait) : seuil atteint (seuil), ou internet sans doute coupé (coupee).
function emailAdmin(etat, { nom, famille, seuil, coupee, commande }) {
  return mail.alerteForfait({
    nom, famille, pourCent: etat.pourCent, conso: etat.conso, plafond: etat.plafond,
    debut: jourEnMs(etat.cycle), fin: jourEnMs(etat.fin), type: etat.type, seuil, coupee, commande,
  });
}

// La tâche (taches.js, toutes les heures). envoyerMail(a, contenu) : celle d'index.js (SMTP).
async function alerteForfait(envoyerMail, { emailPapote, auth, estActif }) {
  const db = base();
  const maintenant = Date.now();
  const familles = await db.collection('families').select('abonnement', 'name', 'createdBy', 'admins', 'forfaitSim').get();
  for (const fam of familles.docs) {
    const f = fam.data();
    if (!estActif(f.abonnement)) continue;
    const tablettes = await fam.ref.collection('members').where('role', '==', 'tablette').get();
    for (const t of tablettes.docs) {
      const tablette = t.data();
      const etat = etatForfait(tablette, f.forfaitSim, maintenant);
      const d = decider(etat, tablette.alerteForfait, maintenant);
      if (!d.note) continue;
      const nom = f.name || 'Mamie';
      try {
        const commande = (await db.collection('commandes').where('fid', '==', fam.id).limit(1).get()).docs[0];
        const pourPapote = (x) => envoyerMail(emailPapote, emailAdmin(etat, { nom, famille: fam.id, commande: commande ? commande.id : null, ...x }));
        if (d.admin) await pourPapote({ seuil: d.admin });
        if (d.coupee) await pourPapote({ coupee: true });
        if (d.famille) {
          const responsables = [...new Set([f.createdBy, ...(f.admins || [])].filter(Boolean))];
          const comptes = await Promise.all(responsables.map((uid) => auth.getUser(uid).catch(() => null)));
          const adresses = [...new Set(comptes.filter((c) => c && c.email).map((c) => c.email.toLowerCase()))];
          const contenu = mail.forfaitPresqueEpuise({ nom, type: etat.type, fin: jourEnMs(etat.fin) });
          const envois = await Promise.allSettled(adresses.map((a) => envoyerMail(a, contenu)));
          envois.filter((r) => r.status === 'rejected').forEach((r) => logger.warn(`Famille ${fam.id} : e-mail forfait non parti`, r.reason && r.reason.message));
          await journal.noter(db, { genre: 'forfait', fid: fam.id, tablette: t.id, telephones: envois.filter((r) => r.status === 'fulfilled').length });
        }
        await t.ref.update({ alerteForfait: d.note });
        logger.info(`Famille ${fam.id}, tablette ${t.id} : forfait à ${etat.pourCent} % (${etat.type})`, d);
      } catch (e) {
        // Rien n'est noté : le tour suivant réessaie.
        logger.error(`Famille ${fam.id}, tablette ${t.id} : alerte forfait non envoyée`, e.message);
      }
    }
  }
}

module.exports = {
  alerteForfait, etatForfait, decider, coupeeParForfait, finDuCycle, emailAdmin, jourTexte, finForfaitDe,
  SEUILS, SEUIL_FAMILLE, SILENCE_MS,
};
