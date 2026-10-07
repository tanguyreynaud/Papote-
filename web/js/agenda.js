// Agenda côté famille : rappels (créer, lister, supprimer, voir quand Mamie a confirmé)
// et anniversaires de la famille, que la tablette rappelle le jour J.
import {
  db, doc, collection, onSnapshot, serverTimestamp, writeBatch, bumpRev,
} from './firebase.js';

const $ = (id) => document.getElementById(id);
const JOURS_COURTS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const KINDS = { medicament: 'Médicament', rdv: 'Rendez-vous', autre: 'Autre' };

let session = null;
let stops = [];
let reminders = [];
let birthdays = [];
let seg = 'reminder';

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

function deleteButton(label, onConfirm) {
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon-btn del';
  del.setAttribute('aria-label', label);
  del.innerHTML = '<svg><use href="#i-trash"/></svg>';
  del.addEventListener('click', onConfirm);
  return del;
}

async function remove(kind, id) {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'families', session.fid, kind, id));
  bumpRev(batch, session.fid);
  await batch.commit();
}

function item(kindClass, kindLabel, titleText, whenText) {
  const li = document.createElement('li');
  li.className = 'reminder';
  const body = document.createElement('div');
  body.className = 'reminder-body';
  const kind = document.createElement('p');
  kind.className = `reminder-kind ${kindClass}`;
  kind.textContent = kindLabel;
  const title = document.createElement('p');
  title.className = 'reminder-title';
  title.textContent = titleText;
  const when = document.createElement('p');
  when.className = 'muted small reminder-when';
  when.textContent = whenText;
  body.append(kind, title, when);
  li.append(body);
  return { li, body };
}

function renderReminders() {
  const ul = $('reminders');
  ul.replaceChildren();
  reminders.sort((a, b) => a.time.localeCompare(b.time));
  for (const r of reminders) {
    const { li, body } = item(`k-${r.kind || 'autre'}`, KINDS[r.kind] || 'Autre', r.title, describe(r));
    if (r.lastAck && r.lastAck.startsWith(todayKey())) {
      const ack = document.createElement('p');
      ack.className = 'seen small';
      ack.textContent = `${session.family.name} a confirmé aujourd'hui à ${r.lastAck.slice(11)} ✓`;
      body.append(ack);
    }
    li.append(deleteButton('Supprimer ce rappel', async () => {
      if (confirm(`Supprimer le rappel « ${r.title} » ?`)) await remove('reminders', r.id);
    }));
    ul.append(li);
  }
  syncEmpty();
}

// Nombre de jours avant le prochain anniversaire (0 = aujourd'hui).
function daysUntil(b) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), b.month - 1, b.day);
  if (next < today) next = new Date(now.getFullYear() + 1, b.month - 1, b.day);
  return { days: Math.round((next - today) / 86_400_000), nextYear: next.getFullYear() };
}

function renderBirthdays() {
  const ul = $('birthdays');
  ul.replaceChildren();
  const list = birthdays.map((b) => ({ ...b, ...daysUntil(b) })).sort((a, b) => a.days - b.days);
  for (const b of list) {
    let when = `${b.day === 1 ? '1er' : b.day} ${MOIS[b.month - 1]}`;
    if (b.year) when += ` · ${b.days === 0 ? 'fête ses' : 'aura'} ${b.nextYear - b.year} ans`;
    const soon = b.days === 0 ? "C'est aujourd'hui !" : b.days === 1 ? 'Demain' : `Dans ${b.days} jours`;
    const { li, body } = item('k-anniv', 'Anniversaire', b.name, when);
    const s = document.createElement('p');
    s.className = b.days === 0 ? 'seen small' : 'muted small';
    s.textContent = soon;
    body.append(s);
    li.append(deleteButton("Supprimer l'anniversaire", async () => {
      if (confirm(`Supprimer l'anniversaire de ${b.name} ?`)) await remove('birthdays', b.id);
    }));
    ul.append(li);
  }
  syncEmpty();
}

function syncEmpty() {
  $('birthdays-title').hidden = !birthdays.length || !reminders.length;
  $('reminders-title').hidden = !birthdays.length || !reminders.length;
  $('reminders-empty').hidden = birthdays.length + reminders.length > 0;
}

// ---------- Formulaire : rappel ou anniversaire ----------

function syncRepeatFields() {
  const repeat = $('rem-repeat').value;
  $('rem-date-wrap').hidden = repeat !== 'once';
  $('rem-days').hidden = repeat !== 'weekly';
}

function setSeg(next) {
  seg = next;
  document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.seg === seg));
  $('rem-fields').hidden = seg !== 'reminder';
  $('bday-fields').hidden = seg !== 'birthday';
  $('btn-reminder').textContent = seg === 'reminder' ? 'Ajouter le rappel' : "Ajouter l'anniversaire";
  $('rem-error').hidden = true;
}

document.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => setSeg(b.dataset.seg)));

for (let d = 1; d <= 31; d++) $('bday-day').add(new Option(String(d), String(d)));
MOIS.forEach((m, i) => $('bday-month').add(new Option(m, String(i + 1))));

$('rem-repeat').addEventListener('change', syncRepeatFields);

$('add-reminder').addEventListener('click', () => {
  setSeg('reminder');
  $('sheet-reminder').hidden = false;
  history.pushState({ page: 'agenda', sheet: true }, '');
  $('rem-title').focus();
});
$('reminder-close').addEventListener('click', () => history.back());
$('sheet-reminder').addEventListener('click', (e) => { if (e.target === $('sheet-reminder')) history.back(); });

function fail(message) {
  $('rem-error').textContent = message;
  $('rem-error').hidden = false;
}

function reminderData() {
  const repeat = $('rem-repeat').value;
  const days = Array.from($('rem-days').querySelectorAll('input:checked')).map((i) => Number(i.value));
  if (!$('rem-title').value.trim()) return fail('Écrivez ce qu\'il faut rappeler.');
  if (repeat === 'weekly' && !days.length) return fail('Choisissez au moins un jour.');
  if (repeat === 'once' && !$('rem-date').value) return fail('Choisissez une date.');
  if (!$('rem-time').value) return fail('Choisissez une heure.');
  return {
    title: $('rem-title').value.trim(),
    kind: document.querySelector('input[name="rem-kind"]:checked').value,
    time: $('rem-time').value,
    repeat,
    date: repeat === 'once' ? $('rem-date').value : null,
    days: repeat === 'weekly' ? days : [],
    createdBy: session.member.name,
    createdAt: serverTimestamp(),
    lastAck: null,
  };
}

function birthdayData() {
  const name = $('bday-name').value.trim();
  const day = Number($('bday-day').value);
  const month = Number($('bday-month').value);
  const yearText = $('bday-year').value.trim();
  const year = yearText ? Number(yearText) : null;
  if (!name) return fail('Écrivez le prénom.');
  if (day > new Date(2024, month, 0).getDate()) return fail(`Il n'y a pas de ${day} ${MOIS[month - 1]}.`);
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear())) {
    return fail("L'année ne semble pas juste.");
  }
  return { name, day, month, year, createdBy: session.member.name, createdAt: serverTimestamp() };
}

$('form-reminder').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('rem-error').hidden = true;
  const data = seg === 'reminder' ? reminderData() : birthdayData();
  if (!data) return;
  $('btn-reminder').disabled = true;
  try {
    const batch = writeBatch(db);
    batch.set(doc(collection(db, 'families', session.fid, seg === 'reminder' ? 'reminders' : 'birthdays')), data);
    bumpRev(batch, session.fid);
    await batch.commit();
    $('rem-title').value = '';
    $('bday-name').value = '';
    $('bday-year').value = '';
    history.back();
  } catch (error) {
    console.error(error);
    fail("L'enregistrement a échoué. Vérifiez la connexion.");
  } finally {
    $('btn-reminder').disabled = false;
  }
});

export function startAgenda(current, onChange) {
  session = current;
  $('rem-date').min = todayKey();
  $('rem-date').value = todayKey();
  syncRepeatFields();
  stopAgenda();
  stops.push(onSnapshot(collection(db, 'families', session.fid, 'reminders'), (snap) => {
    reminders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderReminders();
    onChange?.(reminders);
  }));
  stops.push(onSnapshot(collection(db, 'families', session.fid, 'birthdays'), (snap) => {
    birthdays = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderBirthdays();
  }, (err) => console.error('Anniversaires illisibles', err)));
}

export function stopAgenda() {
  stops.forEach((stop) => stop());
  stops = [];
}
