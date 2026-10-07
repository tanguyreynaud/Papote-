// Rappels et agenda côté famille : créer, lister, supprimer ; voir quand Mamie a confirmé.
import {
  db, doc, collection, onSnapshot, serverTimestamp, writeBatch, bumpRev,
} from './firebase.js';

const $ = (id) => document.getElementById(id);
const JOURS_COURTS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const KINDS = { medicament: 'Médicament', rdv: 'Rendez-vous', autre: 'Autre' };

let session = null;
let stop = null;

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function describe(r) {
  if (r.repeat === 'daily') return `Tous les jours à ${r.time}`;
  if (r.repeat === 'weekly') {
    const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => (r.days || []).includes(d)).map((d) => JOURS_COURTS[d]);
    return `Le ${days.join(', ')} à ${r.time}`;
  }
  const date = r.date ? new Date(`${r.date}T00:00`) : null;
  const label = date ? date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  return `Le ${label} à ${r.time}`;
}

function render(list) {
  const ul = $('reminders');
  ul.replaceChildren();
  $('reminders-empty').hidden = list.length > 0;
  list.sort((a, b) => a.time.localeCompare(b.time));
  for (const r of list) {
    const li = document.createElement('li');
    li.className = 'reminder';
    const body = document.createElement('div');
    body.className = 'reminder-body';
    const kind = document.createElement('p');
    kind.className = `reminder-kind k-${r.kind || 'autre'}`;
    kind.textContent = KINDS[r.kind] || 'Autre';
    const title = document.createElement('p');
    title.className = 'reminder-title';
    title.textContent = r.title;
    const when = document.createElement('p');
    when.className = 'muted small reminder-when';
    when.textContent = describe(r);
    body.append(kind, title, when);
    li.append(body);
    if (r.lastAck && r.lastAck.startsWith(todayKey())) {
      const ack = document.createElement('p');
      ack.className = 'seen small';
      ack.textContent = `${session.family.name} a confirmé aujourd'hui à ${r.lastAck.slice(11)} ✓`;
      body.append(ack);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn del';
    del.setAttribute('aria-label', 'Supprimer ce rappel');
    del.innerHTML = '<svg><use href="#i-trash"/></svg>';
    del.addEventListener('click', async () => {
      if (!confirm(`Supprimer le rappel « ${r.title} » ?`)) return;
      const batch = writeBatch(db);
      batch.delete(doc(db, 'families', session.fid, 'reminders', r.id));
      bumpRev(batch, session.fid);
      await batch.commit();
    });
    li.append(del);
    ul.append(li);
  }
}

function syncRepeatFields() {
  const repeat = $('rem-repeat').value;
  $('rem-date-wrap').hidden = repeat !== 'once';
  $('rem-days').hidden = repeat !== 'weekly';
}

$('rem-repeat').addEventListener('change', syncRepeatFields);

$('add-reminder').addEventListener('click', () => {
  $('rem-error').hidden = true;
  $('sheet-reminder').hidden = false;
  history.pushState({ page: 'agenda', sheet: true }, '');
  $('rem-title').focus();
});
$('reminder-close').addEventListener('click', () => history.back());
$('sheet-reminder').addEventListener('click', (e) => { if (e.target === $('sheet-reminder')) history.back(); });

$('form-reminder').addEventListener('submit', async (e) => {
  e.preventDefault();
  const repeat = $('rem-repeat').value;
  const days = Array.from($('rem-days').querySelectorAll('input:checked')).map((i) => Number(i.value));
  const err = $('rem-error');
  err.hidden = true;
  if (repeat === 'weekly' && !days.length) { err.textContent = 'Choisissez au moins un jour.'; err.hidden = false; return; }
  if (repeat === 'once' && !$('rem-date').value) { err.textContent = 'Choisissez une date.'; err.hidden = false; return; }
  $('btn-reminder').disabled = true;
  try {
    const batch = writeBatch(db);
    batch.set(doc(collection(db, 'families', session.fid, 'reminders')), {
      title: $('rem-title').value.trim(),
      kind: document.querySelector('input[name="rem-kind"]:checked').value,
      time: $('rem-time').value,
      repeat,
      date: repeat === 'once' ? $('rem-date').value : null,
      days: repeat === 'weekly' ? days : [],
      createdBy: session.member.name,
      createdAt: serverTimestamp(),
      lastAck: null,
    });
    bumpRev(batch, session.fid);
    await batch.commit();
    $('rem-title').value = '';
    history.back();
  } catch (error) {
    console.error(error);
    err.textContent = "Le rappel n'a pas pu être enregistré. Vérifiez la connexion.";
    err.hidden = false;
  } finally {
    $('btn-reminder').disabled = false;
  }
});

export function startAgenda(current, onChange) {
  session = current;
  $('rem-date').min = todayKey();
  $('rem-date').value = todayKey();
  syncRepeatFields();
  stop?.();
  stop = onSnapshot(collection(db, 'families', session.fid, 'reminders'), (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render(list);
    onChange?.(list);
  });
}

export function stopAgenda() {
  stop?.();
  stop = null;
}
