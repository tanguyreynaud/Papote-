// Tableau de bord : cartes SIM vues par les tablettes (members/{uid}.sim = { iccid, operateur,
// reseau, signal, dataMoisMo, vuLe }), par famille, avec les alertes. Les contrats (opérateur,
// prix, promo…) sont tenus dans le registre à part de Tanguy, pas ici.
const $ = (id) => document.getElementById(id);
const DATA_MAX_MO = 15 * 1024;
const MUETTE_MS = 48 * 3600_000;

const toDate = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);
const quand = (d) => (d ? d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
const go = (mo) => (mo == null || mo < 0 ? '–' : mo >= 1024 ? `${(mo / 1024).toFixed(1)} Go` : `${Math.round(mo)} Mo`);
const last4 = (iccid) => (iccid ? String(iccid).replace(/\D/g, '').slice(-4) : '');

function rowFor(fam, list) {
  const sim = list.filter((t) => t.sim).sort((a, b) => (toDate(b.sim.vuLe) || 0) - (toDate(a.sim.vuLe) || 0))[0]?.sim || null;
  const seen = list.map((t) => toDate(t.lastOnline)).filter(Boolean).sort((a, b) => b - a)[0] || null;
  const alerts = [];
  const avecSim = fam.abonnement?.formule === 'sim';
  if (avecSim && (!sim || !sim.iccid)) alerts.push('Formule SIM mais aucune carte vue dans la tablette');
  if (sim?.dataMoisMo > DATA_MAX_MO) alerts.push(`Data du mois élevée : ${go(sim.dataMoisMo)}`);
  if (['suspendu', 'resilie'].includes(fam.abonnement?.statut) && sim?.dataMoisMo > 0) {
    alerts.push("Abonnement en pause mais la ligne consomme encore : suspendre la ligne chez l'opérateur");
  }
  if (seen && Date.now() - seen.getTime() > MUETTE_MS) alerts.push(`Tablette muette depuis le ${quand(seen)}`);
  return { fam, sim, seen, alerts, avecSim };
}

/** Appelé par le tableau de bord avec les familles et les fiches tablette déjà lues. */
export function refreshSim(families, tablets) {
  const rows = families
    .map((f) => rowFor(f, tablets[f.id] || []))
    .filter((r) => r.sim || r.avecSim)
    .sort((a, b) => b.alerts.length - a.alerts.length || a.fam.name.localeCompare(b.fam.name));
  $('sim-count').textContent = `${rows.length} tablette${rows.length > 1 ? 's' : ''} avec SIM · ${rows.filter((r) => r.alerts.length).length} à regarder`;
  $('sim-empty').hidden = rows.length > 0;
  $('sim-lines').replaceChildren(...rows.map(({ fam, sim, seen, alerts }) => {
    const li = document.createElement('li');
    li.className = `sim-line card${alerts.length ? ' warn' : ''}`;
    li.innerHTML = '<div class="sim-head"><strong></strong><code></code></div><dl></dl><ul class="sim-alerts"></ul>';
    li.querySelector('strong').textContent = `Famille de ${fam.name}`;
    li.querySelector('code').textContent = sim?.iccid ? `ICCID …${last4(sim.iccid)}` : 'pas de SIM';
    const items = [
      ['Opérateur', sim?.operateur || '–'],
      ['Réseau', sim ? `${sim.reseau || '?'}${sim.signal >= 0 ? `, signal ${sim.signal}/4` : ''}` : '–'],
      ['Data du mois', go(sim?.dataMoisMo)],
      ['SIM vue le', quand(toDate(sim?.vuLe))],
      ['Tablette en ligne', quand(seen)],
      ['Abonnement', fam.abonnement?.statut || '–'],
    ];
    const dl = li.querySelector('dl');
    for (const [k, v] of items) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    li.querySelector('.sim-alerts').replaceChildren(...alerts.map((a) => { const x = document.createElement('li'); x.textContent = a; return x; }));
    return li;
  }));
}
