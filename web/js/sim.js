// Tableau de bord : registre des cartes SIM (simLines, saisi par l'administrateur) rapproché
// de ce que remontent les tablettes (members/{uid}.sim = { iccid, operateur, reseau, signal, dataMoisMo, vuLe }).
import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const $ = (id) => document.getElementById(id);
const DATA_MAX_MO = 15 * 1024;
const MUETTE_MS = 48 * 3600_000;
const PROMO_MS = 30 * 86_400_000;

const toDate = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);
const jour = (d) => (d ? d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
const go = (mo) => (mo == null ? '–' : mo >= 1024 ? `${(mo / 1024).toFixed(1)} Go` : `${Math.round(mo)} Mo`);
const last4 = (iccid) => (iccid ? String(iccid).replace(/\D/g, '').slice(-4) : '');

let db = null;
let lines = [];
let ctx = { families: [], tablets: {} }; // tablets : fid -> fiches tablette

// La SIM vue par la tablette de la famille (fiche la plus récemment en ligne).
function reported(fid) {
  return (ctx.tablets[fid] || []).filter((t) => t.sim)
    .sort((a, b) => (toDate(b.sim.vuLe) || 0) - (toDate(a.sim.vuLe) || 0))[0] || null;
}

function lastOnline(fid) {
  return (ctx.tablets[fid] || []).map((t) => toDate(t.lastOnline)).filter(Boolean).sort((a, b) => b - a)[0] || null;
}

function alertsFor(line) {
  const out = [];
  const fam = ctx.families.find((f) => f.id === line.fid);
  const tab = line.fid ? reported(line.fid) : null;
  const sim = tab?.sim;
  if (line.fid && !sim) out.push('SIM absente ou pas encore remontée par la tablette');
  if (sim && line.iccid && last4(sim.iccid) && last4(sim.iccid) !== last4(line.iccid)) out.push(`La tablette a une autre carte (…${last4(sim.iccid)})`);
  if (sim?.dataMoisMo > DATA_MAX_MO) out.push(`Data du mois élevée : ${go(sim.dataMoisMo)}`);
  const statut = fam?.abonnement?.statut;
  if (['suspendu', 'resilie'].includes(statut) && sim?.dataMoisMo > 0) out.push('Abonnement en pause mais la ligne consomme encore : suspendre la ligne chez l\'opérateur');
  const seen = line.fid ? lastOnline(line.fid) : null;
  if (line.fid && seen && Date.now() - seen.getTime() > MUETTE_MS) out.push(`Tablette muette depuis le ${jour(seen)}`);
  const promo = toDate(line.finPromo);
  if (promo && promo.getTime() - Date.now() < PROMO_MS) out.push(promo < new Date() ? `Promo terminée le ${jour(promo)}` : `Fin de promo le ${jour(promo)}`);
  return out;
}

function famName(fid) {
  return ctx.families.find((f) => f.id === fid)?.name || null;
}

function render() {
  // Familles en formule SIM sans ligne au registre.
  const missing = ctx.families.filter((f) => f.abonnement?.formule === 'sim' && !lines.some((l) => l.fid === f.id));
  $('sim-missing').hidden = !missing.length;
  $('sim-missing').textContent = missing.length
    ? `Formule SIM sans ligne enregistrée : ${missing.map((f) => f.name).join(', ')}`
    : '';
  const rows = lines.map((l) => ({ l, alerts: alertsFor(l) })).sort((a, b) => b.alerts.length - a.alerts.length);
  $('sim-count').textContent = `${lines.length} ligne${lines.length > 1 ? 's' : ''} · ${rows.filter((r) => r.alerts.length).length} à regarder`;
  $('sim-lines').replaceChildren(...rows.map(({ l, alerts }) => {
    const sim = l.fid ? reported(l.fid)?.sim : null;
    const li = document.createElement('li');
    li.className = `sim-line card${alerts.length ? ' warn' : ''}`;
    li.innerHTML = '<div class="sim-head"><strong></strong><code></code><button type="button" class="link small">Modifier</button></div><dl></dl><ul class="sim-alerts"></ul>';
    li.querySelector('strong').textContent = l.fid ? `Famille de ${famName(l.fid) || '?'}` : 'Pas encore attribuée';
    li.querySelector('code').textContent = l.iccid ? `…${last4(l.iccid)}` : '';
    li.querySelector('button').addEventListener('click', () => openForm(l));
    const rowsDl = [
      ['Numéro', l.numero || '–'], ['Opérateur', l.operateur || sim?.operateur || '–'], ['ID client', l.idClient || '–'],
      ['Activée le', jour(toDate(l.dateActivation))], ['Fin de promo', jour(toDate(l.finPromo))], ['Prix', l.prix ? `${l.prix} €/mois` : '–'],
      ['Réseau', sim ? `${sim.reseau || '?'}${sim.signal != null ? `, signal ${sim.signal}/4` : ''}` : '–'],
      ['Data du mois', go(sim?.dataMoisMo)], ['Vue le', jour(toDate(sim?.vuLe))],
    ];
    if (l.note) rowsDl.push(['Note', l.note]);
    const dl = li.querySelector('dl');
    for (const [k, v] of rowsDl) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    li.querySelector('.sim-alerts').replaceChildren(...alerts.map((a) => { const x = document.createElement('li'); x.textContent = a; return x; }));
    return li;
  }));
  $('sim-empty').hidden = lines.length > 0;
}

// ---------- Saisie d'une ligne ----------

let editing = null;
const FIELDS = ['fid', 'iccid', 'numero', 'operateur', 'idClient', 'dateActivation', 'finPromo', 'prix', 'note'];

function openForm(line) {
  editing = line || null;
  $('sim-form-title').textContent = line ? 'Modifier la ligne' : 'Nouvelle ligne';
  $('sim-fid').replaceChildren(new Option('Pas encore attribuée', ''), ...ctx.families
    .slice().sort((a, b) => a.name.localeCompare(b.name)).map((f) => new Option(`Famille de ${f.name}`, f.id)));
  for (const k of FIELDS) $(`sim-${k}`).value = line?.[k] ?? '';
  $('sim-delete').hidden = !line;
  $('sim-form').hidden = false;
  $('sim-form').scrollIntoView({ behavior: 'smooth' });
}

async function save(e) {
  e.preventDefault();
  const data = {};
  for (const k of FIELDS) {
    const v = $(`sim-${k}`).value.trim();
    data[k] = v === '' ? null : (k === 'prix' ? Number(v.replace(',', '.')) : v);
  }
  data.majLe = serverTimestamp();
  try {
    if (editing) await updateDoc(doc(db, 'simLines', editing.id), data);
    else await addDoc(collection(db, 'simLines'), data);
    $('sim-form').hidden = true;
    await loadLines();
  } catch (err) {
    console.error(err);
    alert("La ligne n'a pas pu être enregistrée.");
  }
}

async function remove() {
  if (!editing || !confirm('Supprimer cette ligne du registre ?')) return;
  await deleteDoc(doc(db, 'simLines', editing.id));
  $('sim-form').hidden = true;
  await loadLines();
}

async function loadLines() {
  const snap = await getDocs(collection(db, 'simLines'));
  lines = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
}

export function setupSim(firestore) {
  db = firestore;
  $('sim-add').addEventListener('click', () => openForm(null));
  $('sim-form').addEventListener('submit', save);
  $('sim-cancel').addEventListener('click', () => { $('sim-form').hidden = true; });
  $('sim-delete').addEventListener('click', remove);
}

/** Appelé par le tableau de bord avec les familles et les fiches tablette déjà lues. */
export async function refreshSim(families, tablets) {
  ctx = { families, tablets };
  try {
    await loadLines();
  } catch (err) {
    console.warn('Registre SIM illisible', err);
  }
}
