// Agenda côté famille : rappels (créer, lister, supprimer, voir quand Mamie a confirmé)
// et anniversaires de la famille, que la tablette rappelle le jour J.
import {
  db, doc, getDoc, collection, onSnapshot, serverTimestamp, writeBatch, bumpRev, deleteField,
} from './firebase.js';
import { askConfirm, notice, chooseAction, fonduNouveaux, partir, heureFr, deOuD } from './ui.js';

const $ = (id) => document.getElementById(id);
const JOURS_COURTS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const KINDS = { medicament: 'Médicament', rdv: 'Rendez-vous', autre: 'Autre' };

let session = null;
let stops = [];
// Photo de l'anniversaire en cours de saisie : data URL, null (aucune) ; préparée par famille.js (visageCarre).
let bdayPhoto = null;
let preparerPhoto = null;
function montrerPhoto() {
  $('bday-photo-img').hidden = !bdayPhoto;
  if (bdayPhoto) $('bday-photo-img').src = bdayPhoto;
  $('bday-photo-retirer').hidden = !bdayPhoto;
  $('bday-photo-texte').textContent = bdayPhoto ? 'Changer la photo' : 'Ajouter une photo (facultatif)';
}
$('bday-photo-choisir').addEventListener('click', () => $('in-bday-photo').click());
$('bday-photo-retirer').addEventListener('click', () => { bdayPhoto = null; montrerPhoto(); });
$('in-bday-photo').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !preparerPhoto) return;
  try {
    bdayPhoto = await preparerPhoto(file);
    montrerPhoto();
  } catch (err) {
    console.error(err);
    fail('Cette photo ne peut pas être lue. Essayez-en une autre.');
  }
});
let reminders = [];
let birthdays = [];
let seg = 'reminder';
// Élément en cours de modification : { coll: 'reminders' | 'birthdays', id }, sinon null (ajout).
let editing = null;

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function describe(r) {
  if (r.repeat === 'daily') return `Tous les jours à ${heureFr(r.time)}`;
  if (r.repeat === 'weekly') {
    const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => (r.days || []).includes(d)).map((d) => JOURS_COURTS[d]);
    return `Le ${days.join(', ')} à ${heureFr(r.time)}`;
  }
  const date = r.date ? new Date(`${r.date}T00:00`) : null;
  const label = date ? date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  return `Le ${label} à ${heureFr(r.time)}`;
}

const POUR_TOUJOURS = '9999-12-31';
const dateCourte = (j) => new Date(`${j}T00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }).replace(/^1 /, '1er ');
const enPause = (r) => !!r.enPauseJusquau && r.enPauseJusquau >= todayKey();
const avanceTexte = (m) => (m === 0 ? 'à l\'heure seulement' : m >= 60 ? `${m / 60} h avant` : `${m} min avant`);

// Complément sous l'heure : annonce, date de fin, pause.
function details(r) {
  const avance = Number.isInteger(r.avanceMin) ? r.avanceMin : 15;
  return [
    `Prévenue ${avanceTexte(avance)}`,
    r.repeat !== 'once' && r.finLe ? (r.finLe < todayKey() ? `terminé le ${dateCourte(r.finLe)}` : `jusqu'au ${dateCourte(r.finLe)}`) : null,
  ].filter(Boolean).join(' · ');
}

// Mettre en pause sans supprimer : la tablette n'affiche plus le rappel jusqu'à la date choisie (comprise).
async function changerPause(r, valeur) {
  const batch = writeBatch(db);
  batch.update(doc(db, 'families', session.fid, 'reminders', r.id), { enPauseJusquau: valeur });
  bumpRev(batch, session.fid);
  await batch.commit();
}
async function pause(r) {
  if (enPause(r)) {
    await changerPause(r, deleteField());
    toastAgenda('Rappel repris');
    return;
  }
  const jour = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
  const choix = await chooseAction(`Mettre « ${r.title} » en pause`, [
    { label: 'Aujourd\'hui seulement', value: jour(0) },
    { label: 'Pendant une semaine', value: jour(6) },
    { label: 'Pendant un mois', value: jour(29) },
    { label: 'Jusqu\'à ce que je le reprenne', value: POUR_TOUJOURS },
  ]);
  if (!choix) return;
  await changerPause(r, choix);
  toastAgenda('Rappel en pause');
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
  // Toute action faite se dit, comme « Message supprimé » (cohérence, 23/11).
  toastAgenda(kind === 'reminders' ? 'Rappel supprimé' : 'Anniversaire supprimé');
}

function editButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link small agenda-edit';
  b.textContent = 'Modifier';
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

// Ligne touchée hors de ses boutons : comme « Modifier » (audit des touchers, 17/11 : rien ne se passait).
function item(kindClass, kindLabel, titleText, whenText, onOpen) {
  const li = document.createElement('li');
  li.className = 'reminder ligne-touchable';
  li.addEventListener('click', (e) => { if (!e.target.closest('button, a')) onOpen(); });
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
    const { li, body } = item(`k-${r.kind || 'autre'}`, KINDS[r.kind] || 'Autre', r.title, describe(r), () => openEdit('reminders', r));
    const plus = document.createElement('p');
    plus.className = 'muted small';
    plus.textContent = details(r);
    body.append(plus);
    if (enPause(r)) {
      li.classList.add('en-pause');
      const p = document.createElement('p');
      p.className = 'small pause-note';
      p.textContent = r.enPauseJusquau === POUR_TOUJOURS ? 'En pause' : `En pause jusqu'au ${dateCourte(r.enPauseJusquau)} inclus`;
      body.append(p);
    }
    if (r.lastAck && r.lastAck.startsWith(todayKey())) {
      const ack = document.createElement('p');
      ack.className = 'seen small';
      ack.textContent = `${session.family.name} a confirmé aujourd'hui à ${heureFr(r.lastAck.slice(11))} ✓`;
      body.append(ack);
    } else if (r.lastSeen && r.lastSeen.startsWith(todayKey())) {
      // La tablette a vu un visage devant le rappel, sans qu'il soit encore confirmé.
      const seen = document.createElement('p');
      seen.className = 'muted small';
      seen.textContent = `${session.family.name} a vu le rappel à ${r.lastSeen.slice(11)}`;
      body.append(seen);
    }
    body.append(editButton(`Modifier le rappel « ${r.title} »`, () => openEdit('reminders', r)));
    const bPause = document.createElement('button');
    bPause.type = 'button';
    bPause.className = 'link small agenda-edit';
    bPause.textContent = enPause(r) ? 'Reprendre' : 'Mettre en pause';
    bPause.addEventListener('click', () => pause(r).catch((err) => { console.error(err); notice('La modification a échoué. Vérifiez la connexion.'); }));
    body.append(bPause);
    li.append(deleteButton('Supprimer ce rappel', async () => {
      if (await askConfirm(`Supprimer le rappel « ${r.title} » ?`)) { const depart = partir(li); await depart.fini; await remove('reminders', r.id).catch((e) => { depart.revenir(); throw e; }); }
    }));
    ul.append(li);
  }
  fonduNouveaux(ul, reminders.map((r) => r.id));
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
    const { li, body } = item('k-anniv', 'Anniversaire', b.name, when, () => openEdit('birthdays', b));
    const s = document.createElement('p');
    s.className = b.days === 0 ? 'seen small' : 'muted small';
    s.textContent = soon;
    body.append(s);
    body.append(editButton(`Modifier l'anniversaire ${deOuD(b.name)}${b.name}`, () => openEdit('birthdays', b)));
    li.append(deleteButton("Supprimer l'anniversaire", async () => {
      if (await askConfirm(`Supprimer l'anniversaire ${deOuD(b.name)}${b.name} ?`)) { const depart = partir(li); await depart.fini; await remove('birthdays', b.id).catch((e) => { depart.revenir(); throw e; }); }
    }));
    ul.append(li);
  }
  fonduNouveaux(ul, list.map((b) => b.id));
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
  $('rem-fin-wrap').hidden = repeat === 'once';
}

function setSeg(next) {
  seg = next;
  document.querySelectorAll('#agenda-seg .seg').forEach((b) => b.classList.toggle('active', b.dataset.seg === seg));
  $('rem-fields').hidden = seg !== 'reminder';
  $('bday-fields').hidden = seg !== 'birthday';
  $('btn-reminder').textContent = editing ? 'Enregistrer' : seg === 'reminder' ? 'Ajouter le rappel' : "Ajouter l'anniversaire";
  $('rem-error').hidden = true;
  // Agenda plein (30 rappels en cours) : dit dès l'ouverture, avant d'écrire pour rien.
  limite(seg === 'reminder' && !editing && rappelsEnCours() >= MAX_RAPPELS_EN_COURS ? TEXTE_RAPPELS_EN_COURS : '');
}

document.querySelectorAll('#agenda-seg .seg').forEach((b) => b.addEventListener('click', () => setSeg(b.dataset.seg)));

for (let d = 1; d <= 31; d++) $('bday-day').add(new Option(String(d), String(d)));
MOIS.forEach((m, i) => $('bday-month').add(new Option(m, String(i + 1))));

$('rem-repeat').addEventListener('change', syncRepeatFields);

// Double appui (une ligne, « Modifier », +) : une seule fenêtre, une seule entrée d'historique, et le 2e toucher qui
// tombe sur le voile ne la referme pas.
let feuilleOuverteLe = 0;
function openSheet() {
  cacherDoublon();
  if (!$('sheet-reminder').hidden) return;
  feuilleOuverteLe = Date.now();
  $('sheet-reminder').hidden = false;
  history.pushState({ page: 'agenda', sheet: true, niveau: (history.state?.niveau || 0) + 1 }, '');
}

$('add-reminder').addEventListener('click', () => {
  editing = null;
  $('reminder-title').textContent = "Ajouter à l'agenda";
  $('agenda-seg').hidden = false;
  $('rem-title').value = '';
  $('bday-name').value = '';
  $('bday-name-error').hidden = true;
  $('bday-year').value = '';
  bdayPhoto = null;
  montrerPhoto();
  $('rem-days').querySelectorAll('input').forEach((i) => { i.checked = false; });
  $('rem-avance').value = '15';
  $('rem-fin').value = '';
  $('rem-fin').min = todayKey();
  setSeg('reminder');
  openSheet();
  $('rem-title').focus();
});

// Modifier un rappel ou un anniversaire : même fenêtre, remplie, sans changer de type.
function openEdit(coll, data) {
  editing = { coll, id: data.id };
  $('agenda-seg').hidden = true;
  if (coll === 'reminders') {
    $('reminder-title').textContent = 'Modifier le rappel';
    $('rem-title').value = data.title || '';
    const kind = document.querySelector(`input[name="rem-kind"][value="${data.kind || 'autre'}"]`);
    if (kind) kind.checked = true;
    // Valeur inconnue (ancien rappel) : « Quand ? » restait vide (banc du 19/11). Une date seule = une seule fois.
    $('rem-repeat').value = ['daily', 'weekly', 'once'].includes(data.repeat) ? data.repeat : (data.date ? 'once' : 'daily');
    $('rem-date').min = '';
    $('rem-date').value = data.date || todayKey();
    $('rem-days').querySelectorAll('input').forEach((i) => { i.checked = (data.days || []).includes(Number(i.value)); });
    $('rem-time').value = data.time || '09:00';
    $('rem-avance').value = String(Number.isInteger(data.avanceMin) ? data.avanceMin : 15);
    $('rem-fin').value = data.finLe || '';
    syncRepeatFields();
    setSeg('reminder');
  } else {
    $('reminder-title').textContent = "Modifier l'anniversaire";
    $('bday-name').value = data.name || '';
    $('bday-name-error').hidden = true;
    $('bday-day').value = String(data.day || 1);
    $('bday-month').value = String(data.month || 1);
    $('bday-year').value = data.year ? String(data.year) : '';
    bdayPhoto = data.photo || null;
    montrerPhoto();
    setSeg('birthday');
  }
  openSheet();
}
$('reminder-close').addEventListener('click', () => history.back());
$('sheet-reminder').addEventListener('click', (e) => { if (e.target === $('sheet-reminder') && Date.now() - feuilleOuverteLe > 500) history.back(); });

// Petit message en bas de l'écran (même style que l'app).
function toastAgenda(text) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastAgenda.timer);
  toastAgenda.timer = setTimeout(() => { t.hidden = true; }, 2500);
}

// Le jour en toutes lettres est écrit dans le champ lui-même (listes.js : « Aujourd'hui », « Demain », « Jeudi 3
// décembre ») : « 26/10/2026 » seul ne disait pas si c'était bien « jeudi prochain » (tests du 21/11).

// champ : le champ fautif. Le message se place juste sous lui et l'écran y revient : en bas de la feuille, sous le
// bouton, il restait hors de vue et rien ne semblait se passer (tests du 21/11 : Sylvie a cru son rappel enregistré).

function fail(message, champ) {
  const erreur = $('rem-error');
  erreur.textContent = message;
  erreur.hidden = false;
  const ancre = champ?.closest('label') || $('btn-reminder');
  ancre.after(erreur);
  (champ?.closest('label') || erreur).scrollIntoView({ block: 'center' });
  champ?.focus({ preventScroll: true });
}

// ---------- Limites du jour (A12, Tanguy 12/11 ; serveur : functions/limites.js) ----------
// Le serveur tient families/{fid}/compteurs/jour et y note jusqu'à quand (minuit, heure de Paris) la famille ne crée
// plus de messages écrits (bloqueJusqua, 50 par jour) ni de rappels (rappelsBloquesJusqua, 10 par jour) ; les règles
// refusent alors l'écriture. Renvoie cette heure (Date) si elle n'est pas passée, sinon null. Illisible : null.
export async function limiteDuJour(fid, champ) {
  try {
    const snap = await getDoc(doc(db, 'families', fid, 'compteurs', 'jour'));
    const t = snap.exists() ? snap.get(champ) : null;
    const fin = t && typeof t.toDate === 'function' ? t.toDate() : null;
    return fin && fin > new Date() ? fin : null;
  } catch (err) {
    console.warn('Compteur du jour illisible', err);
    return null;
  }
}
export const MAX_RAPPELS_EN_COURS = 30;
const TEXTE_RAPPELS_JOUR = "10 rappels ajoutés aujourd'hui : c'est le maximum pour la journée. Vous pourrez en ajouter de nouveau demain.";
const TEXTE_RAPPELS_EN_COURS = `${MAX_RAPPELS_EN_COURS} rappels dans l'agenda : c'est le maximum. Supprimez un rappel qui ne sert plus pour en ajouter un nouveau.`;
// Rappel en cours : « une fois » pas encore passé, ou qui se répète sans être terminé (en pause compris). Même
// définition que le serveur (limites.js, rappelEnCours).
function rappelsEnCours() {
  const j = todayKey();
  return reminders.filter((r) => (r.repeat === 'once' ? !r.date || r.date >= j : !r.finLe || r.finLe >= j)).length;
}
function limite(message) {
  $('rem-limite').textContent = message;
  $('rem-limite').hidden = !message;
}

function reminderData() {
  const repeat = $('rem-repeat').value;
  const days = Array.from($('rem-days').querySelectorAll('input:checked')).map((i) => Number(i.value));
  if (!$('rem-title').value.trim()) return fail('Écrivez ce qu\'il faut rappeler.', $('rem-title'));
  if (repeat === 'weekly' && !days.length) return fail('Choisissez au moins un jour.');
  if (repeat === 'once' && !$('rem-date').value) return fail('Choisissez une date.', $('rem-date'));
  if (!$('rem-time').value) return fail('Choisissez une heure.', $('rem-time'));
  const finLe = repeat === 'once' ? null : $('rem-fin').value || null;
  if (finLe && finLe < todayKey()) return fail('La date de fin est déjà passée.', $('rem-fin'));
  return {
    title: $('rem-title').value.trim(),
    kind: document.querySelector('input[name="rem-kind"]:checked').value,
    time: $('rem-time').value,
    repeat,
    date: repeat === 'once' ? $('rem-date').value : null,
    days: repeat === 'weekly' ? days : [],
    avanceMin: Number($('rem-avance').value),
    finLe,
    createdBy: session.member.name,
    createdAt: serverTimestamp(),
    lastAck: null,
  };
}

// Doublons d'anniversaire : même prénom (sans accents ni majuscules) ou même jour et même mois, y compris
// les anniversaires ajoutés tout seuls depuis le profil d'un proche (membre-<uid>) et ceux d'un autre proche.
// Prévenu une fois dans la fenêtre ; un second appui sur le bouton enregistre quand même.
const sansAccents = (t) => (t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
let doublonVu = '';
function quand(b) {
  return `${b.day === 1 ? '1er' : b.day} ${MOIS[b.month - 1]}`;
}
function origine(b) {
  if (String(b.id).startsWith('membre-')) return 'ajouté tout seul avec son profil';
  return b.createdBy ? `ajouté par ${b.createdBy}` : '';
}
function doublons({ name, day, month }) {
  const n = sansAccents(name);
  return birthdays.filter((b) => !(editing && editing.coll === 'birthdays' && editing.id === b.id)
    && (sansAccents(b.name) === n || (b.day === day && b.month === month)));
}
function cacherDoublon() {
  doublonVu = '';
  $('bday-doublon').hidden = true;
  if (seg === 'birthday') $('btn-reminder').textContent = editing ? 'Enregistrer' : "Ajouter l'anniversaire";
}
['bday-name', 'bday-day', 'bday-month'].forEach((id) => $(id).addEventListener('input', cacherDoublon));
$('bday-name').addEventListener('input', () => { if (/\p{L}/u.test($('bday-name').value)) $('bday-name-error').hidden = true; });
// Renvoie true s'il faut s'arrêter pour montrer l'avertissement.
function prevenirDoublon(data) {
  const cle = `${sansAccents(data.name)}|${data.day}|${data.month}`;
  if (doublonVu === cle) return false;
  const deja = doublons(data);
  if (!deja.length) return false;
  doublonVu = cle;
  const lignes = deja.map((b) => {
    const o = origine(b);
    return `${b.name}, le ${quand(b)}${o ? ` (${o})` : ''}`;
  });
  $('bday-doublon').textContent = `Déjà dans l'agenda : ${lignes.join(' ; ')}.`;
  $('bday-doublon').hidden = false;
  $('btn-reminder').textContent = editing ? 'Enregistrer quand même' : 'Ajouter quand même';
  return true;
}

function birthdayData() {
  const name = $('bday-name').value.trim();
  const day = Number($('bday-day').value);
  const month = Number($('bday-month').value);
  const yearText = $('bday-year').value.trim();
  const year = yearText ? Number(yearText) : null;
  // Vide ou sans lettre : le mot sous le champ du prénom (18/11), rien n'est envoyé.
  if (!/\p{L}/u.test(name)) {
    $('bday-name-error').textContent = 'Écrivez le prénom.';
    $('bday-name-error').hidden = false;
    $('bday-name').focus();
    return null;
  }
  if (day > new Date(2024, month, 0).getDate()) return fail(`Il n'y a pas de ${day} ${MOIS[month - 1]}.`);
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear())) {
    return fail("L'année ne semble pas juste.");
  }
  return { name, day, month, year, photo: bdayPhoto || null, createdBy: session.member.name, createdAt: serverTimestamp() };
}

$('form-reminder').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('rem-error').hidden = true;
  limite('');
  const data = seg === 'reminder' ? reminderData() : birthdayData();
  if (!data) return;
  if (seg === 'birthday' && prevenirDoublon(data)) return;
  const nouveauRappel = seg === 'reminder' && !editing;
  if (nouveauRappel && rappelsEnCours() >= MAX_RAPPELS_EN_COURS) { limite(TEXTE_RAPPELS_EN_COURS); return; }
  $('btn-reminder').disabled = true;
  try {
    const batch = writeBatch(db);
    if (editing) {
      // Modification : on garde l'auteur, la date de création et la confirmation du jour.
      const { createdBy, createdAt, lastAck, ...changes } = data;
      batch.update(doc(db, 'families', session.fid, editing.coll, editing.id), changes);
    } else {
      batch.set(doc(collection(db, 'families', session.fid, seg === 'reminder' ? 'reminders' : 'birthdays')), data);
    }
    bumpRev(batch, session.fid);
    await batch.commit();
    if (editing) toastAgenda(editing.coll === 'reminders' ? 'Rappel modifié' : 'Anniversaire modifié');
    else toastAgenda(seg === 'reminder' ? 'Rappel ajouté' : 'Anniversaire ajouté');
    editing = null;
    $('rem-title').value = '';
    $('bday-name').value = '';
    $('bday-year').value = '';
    bdayPhoto = null;
    history.back();
  } catch (error) {
    // Refusé par les règles : les 10 rappels du jour sont peut-être déjà ajoutés (le dire calmement).
    if (nouveauRappel && error?.code === 'permission-denied' && await limiteDuJour(session.fid, 'rappelsBloquesJusqua')) {
      console.warn('Rappel refusé : limite du jour', error);
      limite(TEXTE_RAPPELS_JOUR);
    } else {
      console.error(error);
      fail("L'enregistrement a échoué. Vérifiez la connexion.");
    }
  } finally {
    $('btn-reminder').disabled = false;
  }
});

export function startAgenda(current, onChange, preparer = null) {
  preparerPhoto = preparer;
  session = current;
  $('rem-date').min = todayKey();
  $('rem-date').value = todayKey();
  syncRepeatFields();
  stopAgenda();
  stops.push(onSnapshot(collection(db, 'families', session.fid, 'reminders'), (snap) => {
    const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Rappels « une seule fois » dont le jour est passé : effacés automatiquement (un rappel arrivé à sa date de fin est gardé).
    const today = todayKey();
    const past = all.filter((r) => r.repeat === 'once' && r.date && r.date < today);
    if (past.length) {
      const batch = writeBatch(db);
      past.forEach((r) => batch.delete(doc(db, 'families', session.fid, 'reminders', r.id)));
      bumpRev(batch, session.fid);
      batch.commit().catch((err) => console.warn('Rappels passés non effacés', err));
    }
    reminders = all.filter((r) => !past.includes(r));
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
