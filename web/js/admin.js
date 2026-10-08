// Tableau de bord de l'administrateur : toutes les familles et l'état de leurs tablettes,
// et transfert des anciennes photos et vidéos de la base vers Storage.
// Une app Firebase à part (« admin ») : la connexion Google ne touche pas à la famille de ce navigateur.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore, collection, collectionGroup, query, where, orderBy, limit,
  getDocs, getDoc, doc, writeBatch, getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  getStorage, ref, uploadBytes, getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { setupSim, refreshSim } from './sim.js';

const app = initializeApp({
  apiKey: 'AIzaSyAvoivJR8p-u2VxUWzlyHzTgP20-5ZG_-E',
  authDomain: 'papote-famille.firebaseapp.com',
  projectId: 'papote-famille',
  storageBucket: 'papote-famille.firebasestorage.app',
  messagingSenderId: '807031084851',
  appId: '1:807031084851:web:b8048e2952cb1e893b1046',
}, 'admin');
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app, 'europe-west1');
setupSim(db);

const $ = (id) => document.getElementById(id);
const OFFLINE_MS = 45 * 60_000;
const IDLE_MS = 24 * 3600_000;

let families = [];

const toDate = (ts) => (ts && ts.toDate ? ts.toDate() : null);

function ago(date) {
  if (!date) return 'jamais';
  const min = Math.round((Date.now() - date.getTime()) / 60000);
  if (min < 2) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} jours`;
}

// ---------- Connexion ----------

$('btn-signin').addEventListener('click', async () => {
  $('signin-error').hidden = true;
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    console.error(err);
    $('signin-error').textContent = 'La connexion a échoué. Réessayez.';
    $('signin-error').hidden = false;
  }
});

$('btn-signout').addEventListener('click', () => signOut(auth));
$('btn-refresh').addEventListener('click', load);

onAuthStateChanged(auth, (user) => {
  $('signin').hidden = !!user;
  $('dashboard').hidden = !user;
  $('btn-refresh').hidden = !user;
  $('who').textContent = user ? user.email : '';
  if (user) load();
});

// ---------- Familles et tablettes ----------

// Commandes payées sur le site, tablette à préparer (écrites par le serveur Stripe).
async function loadOrders() {
  try {
    const snap = await getDocs(query(collection(db, 'commandes'), where('expedition', '==', 'a-preparer')));
    const list = snap.docs.map((d) => d.data())
      .sort((a, b) => (toDate(a.creeLe)?.getTime() || 0) - (toDate(b.creeLe)?.getTime() || 0));
    $('orders-empty').hidden = list.length > 0;
    $('orders').replaceChildren(...list.map((c) => {
      const li = document.createElement('li');
      const a = c.livraison?.adresse || {};
      const adresse = [a.line1, a.line2, `${a.postal_code || ''} ${a.city || ''}`.trim(), a.country].filter(Boolean).join(', ');
      li.innerHTML = '<strong></strong><span class="muted small"></span><span></span>';
      li.querySelector('strong').textContent = `${c.livraison?.nom || c.nom || c.email} · ${c.formule === 'sim' ? 'carte SIM' : 'Wi-Fi'}, tablette ${c.tablette === 'incluse' ? 'incluse' : 'achetée'}`;
      li.querySelector('.muted').textContent = `${c.email}${c.telephone ? ` · ${c.telephone}` : ''} · commandé ${ago(toDate(c.creeLe))}${c.fid ? ' · famille créée' : ''}`;
      li.querySelector('span:last-child').textContent = adresse || 'Adresse non fournie';
      return li;
    }));
  } catch (err) {
    console.warn('Commandes illisibles', err);
    $('orders-empty').hidden = false;
  }
}

// Tablettes incluses à rendre après la fin d'un abonnement (restitution écrite par le serveur).
async function loadReturns() {
  try {
    const snap = await getDocs(query(collection(db, 'commandes'), where('restitution.statut', 'in', ['attendue', 'echec'])));
    $('returns-empty').hidden = !snap.empty;
    $('returns').replaceChildren(...snap.docs.map((d) => {
      const c = d.data();
      const r = c.restitution || {};
      const avant = toDate(r.avant);
      const li = document.createElement('li');
      li.innerHTML = '<strong></strong><span class="muted small"></span><span class="small"></span><button type="button" class="secondary small-btn">Tablette rendue</button>';
      li.querySelector('strong').textContent = c.livraison?.nom || c.nom || c.email;
      li.querySelector('.muted').textContent = `${c.email}${c.telephone ? ` · ${c.telephone}` : ''}`;
      li.querySelector('span.small:not(.muted)').textContent = r.statut === 'echec'
        ? `Prélèvement de 100 € échoué${r.erreur ? ` (${r.erreur})` : ''} : à relancer depuis Stripe.`
        : `À rendre avant le ${avant ? avant.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : '?'}.`;
      const btn = li.querySelector('button');
      btn.addEventListener('click', async () => {
        if (!confirm(`La tablette de ${c.email} est bien revenue ?`)) return;
        btn.disabled = true;
        try {
          await httpsCallable(functions, 'tabletteRendue')({ commande: d.id });
          li.remove();
        } catch (err) {
          console.error(err);
          alert("L'enregistrement a échoué.");
          btn.disabled = false;
        }
      });
      return li;
    }));
  } catch (err) {
    console.warn('Restitutions illisibles', err);
    $('returns-empty').hidden = false;
  }
}

async function load() {
  loadOrders();
  loadReturns();
  $('loading-families').hidden = false;
  try {
    const [famSnap, tabletSnap] = await Promise.all([
      getDocs(collection(db, 'families')),
      getDocs(query(collectionGroup(db, 'members'), where('role', '==', 'tablette'))),
    ]);
    const tablets = {};
    for (const d of tabletSnap.docs) {
      const fid = d.ref.parent.parent.id;
      (tablets[fid] = tablets[fid] || []).push(d.data());
    }
    families = await Promise.all(famSnap.docs.map(async (d) => {
      const posts = collection(db, 'families', d.id, 'posts');
      const [count, last, people, legacy] = await Promise.all([
        getCountFromServer(posts).then((c) => c.data().count).catch(() => null),
        getDocs(query(posts, orderBy('createdAt', 'desc'), limit(1))).then((s) => toDate(s.docs[0]?.data().createdAt)).catch(() => null),
        getCountFromServer(query(collection(db, 'families', d.id, 'members'), where('role', '==', 'famille'))).then((c) => c.data().count).catch(() => null),
        getCountFromServer(query(posts, where('hasMedia', '==', true))).then((c) => c.data().count).catch(() => 0),
      ]);
      const list = tablets[d.id] || [];
      const latest = (field) => list.reduce((max, t) => {
        const v = toDate(t[field]);
        return v && (!max || v > max) ? v : max;
      }, null);
      return {
        id: d.id, ...d.data(), posts: count, lastPost: last, people, legacy,
        hasTablet: list.length > 0,
        online: latest('lastOnline'),
        active: latest('lastActive'),
        version: list.map((t) => t.appVersion).filter(Boolean).sort().pop() || null,
      };
    }));
    render();
    refreshSim(families, tablets);
  } catch (err) {
    console.error(err);
    $('families').innerHTML = '<li class="card error">Lecture impossible. Ce compte a-t-il les droits d\'administrateur ?</li>';
  } finally {
    $('loading-families').hidden = true;
  }
}

function state(f) {
  if (!f.hasTablet) return { cls: 'none', label: 'Pas de tablette' };
  if (!f.online || Date.now() - f.online.getTime() > OFFLINE_MS) return { cls: 'off', label: `Hors ligne, vue ${ago(f.online)}` };
  return { cls: 'on', label: 'En ligne' };
}

function render() {
  const now = Date.now();
  const withTablet = families.filter((f) => f.hasTablet);
  const offline = withTablet.filter((f) => state(f).cls === 'off');
  $('s-families').textContent = families.length;
  $('s-online').textContent = withTablet.length - offline.length;
  $('s-offline').textContent = offline.length;
  $('s-idle').textContent = withTablet.filter((f) => !f.active || now - f.active.getTime() > IDLE_MS).length;

  // Les tablettes à problème d'abord.
  const rank = { off: 0, on: 1, none: 2 };
  const sorted = families.slice().sort((a, b) => rank[state(a).cls] - rank[state(b).cls] || a.name.localeCompare(b.name));
  $('families').replaceChildren(...sorted.map((f) => {
    const s = state(f);
    const li = document.createElement('li');
    li.className = `family card ${s.cls}`;
    const rows = [
      ['Statut', s.label],
      ['Utilisée', ago(f.active)],
      ['Version', f.version || '–'],
      ['Membres', f.people ?? '–'],
      ['Envois', f.posts ?? '–'],
      ['Dernier envoi', ago(f.lastPost)],
    ];
    li.innerHTML = `<div class="family-head"><span class="dot"></span><strong></strong><code></code></div><dl></dl>`;
    li.querySelector('strong').textContent = f.name;
    li.querySelector('code').textContent = f.code ? `${f.code.slice(0, 4)}-${f.code.slice(4)}` : '';
    const dl = li.querySelector('dl');
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    return li;
  }));
  const legacy = families.reduce((n, f) => n + (f.legacy || 0), 0);
  $('migrate-count').textContent = legacy
    ? `${legacy} envoi${legacy > 1 ? 's' : ''} encore dans la base (photos, vidéos et anciens vocaux).`
    : 'Tout est déjà dans Storage.';
  $('btn-migrate').disabled = !legacy;
}

// ---------- Transfert vers Storage ----------

function log(line) {
  $('migrate-log').hidden = false;
  $('migrate-log').textContent += `${line}\n`;
  $('migrate-log').scrollTop = $('migrate-log').scrollHeight;
}

async function dataUrlBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

async function migratePost(fid, snap) {
  const post = snap.data();
  const postRef = snap.ref;
  const mediaRef = (kind) => doc(postRef, 'media', kind);
  let blob;
  let ext;
  let field;
  const toDelete = [];
  if (post.type === 'photo') {
    const m = await getDoc(mediaRef('image'));
    if (!m.exists()) return 'sans fichier';
    blob = await dataUrlBlob(m.data().data);
    ext = 'jpg';
    field = 'imageUrl';
    toDelete.push(mediaRef('image'));
  } else if (post.type === 'video') {
    const parts = [];
    for (let i = 0; i < (post.chunks || 0); i++) {
      const part = await getDoc(mediaRef(`video${i}`));
      if (!part.exists()) return 'vidéo incomplète';
      parts.push(part.data().data);
      toDelete.push(mediaRef(`video${i}`));
    }
    blob = await dataUrlBlob(`data:${post.mime || 'video/webm'};base64,${parts.join('')}`);
    ext = (post.mime || '').includes('mp4') ? 'mp4' : 'webm';
    field = 'videoUrl';
  } else {
    return 'ignoré (vocal)';
  }
  const path = `families/${fid}/media/${snap.id}.${ext}`;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, blob, { contentType: blob.type || (ext === 'jpg' ? 'image/jpeg' : `video/${ext}`) });
  const url = await getDownloadURL(fileRef);
  // L'adresse d'abord, puis l'effacement des morceaux : la tablette ne perd jamais l'image.
  const batch = writeBatch(db);
  batch.update(postRef, { [field]: url, storagePath: path, hasMedia: false, chunks: 0 });
  toDelete.forEach((r) => batch.delete(r));
  await batch.commit();
  return `${Math.round(blob.size / 1024)} Ko`;
}

$('btn-migrate').addEventListener('click', async () => {
  if (!confirm('Transférer toutes les anciennes photos et vidéos vers Storage ?')) return;
  $('btn-migrate').disabled = true;
  $('migrate-log').textContent = '';
  let done = 0;
  let failed = 0;
  for (const f of families.filter((x) => x.legacy)) {
    log(`— ${f.name}`);
    const snap = await getDocs(query(collection(db, 'families', f.id, 'posts'), where('hasMedia', '==', true)));
    for (const d of snap.docs) {
      try {
        const result = await migratePost(f.id, d);
        log(`  ${d.data().type} ${d.id} : ${result}`);
        done++;
      } catch (err) {
        console.error(err);
        log(`  ${d.data().type} ${d.id} : ÉCHEC (${err.code || err.message})`);
        failed++;
      }
    }
  }
  log(`Terminé : ${done} traités, ${failed} échecs.`);
  load();
});
