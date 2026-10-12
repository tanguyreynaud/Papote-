// Espace d'administration (admin.html) : familles et tablettes, envois et retours de commandes,
// transfert des anciennes photos et vidéos vers Storage. Le stock, les factures et la comptabilité
// sont dans gestion.js, sur la même page.
// Une app Firebase à part (« admin ») : la connexion Google ne touche pas à la famille de ce navigateur.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore, collection, collectionGroup, query, where, orderBy, limit,
  getDocs, getDoc, doc, writeBatch, getCountFromServer, setDoc, deleteDoc, updateDoc,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  getStorage, ref, uploadBytes, getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { refreshSim } from './sim.js';
import { appeler, donnees, signalerChangement } from './gestion-api.js';

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
$('btn-refresh').addEventListener('click', () => {
  load();
  signalerChangement();
});

onAuthStateChanged(auth, (user) => {
  $('signin').hidden = !!user;
  $('dashboard').hidden = !user;
  $('btn-refresh').hidden = !user;
  $('who').textContent = user ? user.email : '';
  if (user) load();
});

// ---------- Familles et tablettes ----------

// Commandes payées sur le site, tablette à préparer (écrites par le serveur Stripe).
// Adresse de livraison : point relais Mondial Relay, ou adresse postale des anciennes commandes.
function livraisonTexte(c) {
  const l = c.livraison || {};
  if (l.transporteur === 'mondial-relay') {
    return `Point relais ${l.nom || ''} (n° ${l.id || '?'}) · ${[l.adresse, `${l.cp || ''} ${l.ville || ''}`.trim(), l.pays].filter(Boolean).join(', ')}`;
  }
  const a = l.adresse || {};
  const postale = [a.line1, a.line2, `${a.postal_code || ''} ${a.city || ''}`.trim(), a.country].filter(Boolean).join(', ');
  return postale ? `Adresse : ${postale}` : 'Adresse non fournie';
}

const lienSuivi = (c) => `https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=${encodeURIComponent(c.suivi || '')}&codePostal=${encodeURIComponent(c.livraison?.cp || '')}`;

function orderHead(c) {
  return `${c.nom || c.email} · ${c.formule === 'sim' ? 'carte SIM' : 'Wi-Fi'}, tablette ${c.tablette === 'incluse' ? 'incluse' : 'achetée'}`;
}

// Tablettes à envoyer : point relais, puis numéro de suivi et « Envoyée » (e-mail au client par le serveur).
async function loadOrders() {
  try {
    const snap = await getDocs(query(collection(db, 'commandes'), where('expedition', '==', 'a-preparer')));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (toDate(a.creeLe)?.getTime() || 0) - (toDate(b.creeLe)?.getTime() || 0));
    $('orders-empty').hidden = list.length > 0;
    $('orders').replaceChildren(...list.map((c) => {
      const li = document.createElement('li');
      li.innerHTML = '<strong></strong><span class="muted small"></span><span class="small"></span>'
        + '<form class="ship"><select class="tablette" aria-label="Tablette du stock"><option value="">Tablette du stock…</option></select>'
        + '<input placeholder="N° de suivi Mondial Relay" autocomplete="off" required><button type="submit" class="primary small-btn">Envoyée</button></form>';
      li.querySelector('strong').textContent = orderHead(c);
      li.querySelector('.muted').textContent = `${c.email}${c.telephone ? ` · ${c.telephone}` : ''} · commandé ${ago(toDate(c.creeLe))}${c.fid ? ' · famille créée' : ''}`;
      li.querySelector('span.small:not(.muted)').textContent = livraisonTexte(c);
      const form = li.querySelector('form');
      remplirTablettes(form.querySelector('select.tablette'), c.id);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const suivi = form.querySelector('input').value.trim();
        const tablette = form.querySelector('select.tablette').value;
        form.querySelector('button').disabled = true;
        try {
          await httpsCallable(functions, 'tabletteEnvoyee')({ commande: c.id, suivi });
          if (tablette) {
            await appeler('gestionStock', { action: 'modifier', id: tablette, champs: { etat: 'envoyee', commande: c.id } })
              .catch((err) => alert(`Colis enregistré, mais la tablette n'a pas pu être sortie du stock : ${err.message}`));
          }
          signalerChangement();
          loadOrders();
          loadShipped();
        } catch (err) {
          console.error(err);
          alert(err.code?.endsWith('invalid-argument') ? 'Ce numéro de suivi ne semble pas valide.' : "L'enregistrement a échoué.");
          form.querySelector('button').disabled = false;
        }
      });
      return li;
    }));
  } catch (err) {
    console.warn('Commandes illisibles', err);
    $('orders-empty').hidden = false;
  }
}

// Tablettes disponibles dans le stock (gestion), pour savoir laquelle part avec la commande.
async function remplirTablettes(select, commande) {
  try {
    const { stock } = await donnees();
    const dispo = stock.filter((t) => t.commande === commande || (['en-stock', 'preparee'].includes(t.etat) && !t.commande));
    for (const t of dispo) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = [t.numero || 'sans n° de série', t.modele].filter(Boolean).join(' · ');
      o.selected = t.commande === commande;
      select.append(o);
    }
    if (!dispo.length) select.options[0].textContent = 'Stock vide';
  } catch (err) {
    select.hidden = true;
  }
}

// Envoyées mais pas encore reliées à une famille : suivi du colis, alerte au bout de 20 jours.
async function loadShipped() {
  try {
    const snap = await getDocs(query(collection(db, 'commandes'), where('expedition', '==', 'envoyee'), where('fid', '==', null)));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.alerteJumelage === true) - (a.alerteJumelage === true)
        || (toDate(a.envoyeeLe)?.getTime() || 0) - (toDate(b.envoyeeLe)?.getTime() || 0));
    $('shipped-empty').hidden = list.length > 0;
    $('shipped').replaceChildren(...list.map((c) => {
      const li = document.createElement('li');
      if (c.alerteJumelage) li.classList.add('alert');
      li.innerHTML = '<strong></strong><span class="muted small"></span><span class="small"></span><a target="_blank" rel="noopener" class="small"></a>';
      li.querySelector('strong').textContent = orderHead(c);
      const infos = [c.email, `envoyée ${ago(toDate(c.envoyeeLe))}`, `${c.rappels || 0} rappel(s) envoyé(s)`];
      if (c.alerteJumelage) infos.push('pas jumelée après 20 jours : appeler le client');
      li.querySelector('.muted').textContent = infos.join(' · ');
      li.querySelector('span.small:not(.muted)').textContent = c.mailErreur ? `E-mail non parti : ${c.mailErreur}` : livraisonTexte(c);
      const a = li.querySelector('a');
      a.href = lienSuivi(c);
      a.textContent = `Suivre le colis ${c.suivi || ''}`;
      return li;
    }));
  } catch (err) {
    console.warn('Envois illisibles', err);
    $('shipped-empty').hidden = false;
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
      li.innerHTML = '<strong></strong><span class="muted small"></span><span class="small"></span><span class="small remb"></span>'
        + '<form class="etiquette"><input type="url" placeholder="Lien de l\'étiquette de retour" aria-label="Étiquette de retour"><button type="submit" class="secondary small-btn">Envoyer l\'étiquette</button></form>'
        + '<button type="button" class="secondary small-btn rendue">Tablette rendue</button>';
      li.querySelector('strong').textContent = c.livraison?.nom || c.nom || c.email;
      li.querySelector('.muted').textContent = `${c.email}${c.telephone ? ` · ${c.telephone}` : ''}`;
      li.querySelector('span.small:not(.muted):not(.remb)').textContent = (r.statut === 'echec'
        ? `Prélèvement échoué${r.erreur ? ` (${r.erreur})` : ''} : à relancer depuis Stripe.`
        : `À rendre avant le ${avant ? avant.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : '?'}.`)
        + (r.motif === 'retractation' ? ' Rétractation.' : '');
      const remb = c.remboursement;
      const rembEl = li.querySelector('.remb');
      if (remb) {
        const montant = remb.montant ? `${(remb.montant / 100).toLocaleString('fr-FR')} €` : '';
        rembEl.textContent = remb.statut === 'echec'
          ? `Remboursement ${montant} échoué${remb.erreur ? ` (${remb.erreur})` : ''} : à rembourser depuis Stripe.`
          : `Remboursement ${montant} : ${remb.statut === 'au-retour' ? 'au retour de la tablette' : remb.statut}.`;
        rembEl.classList.toggle('error', remb.statut === 'echec');
      }
      const form = li.querySelector('.etiquette');
      const input = form.querySelector('input');
      if (r.etiquette) input.value = r.etiquette;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const lien = input.value.trim();
        if (!/^https:\/\//.test(lien)) { alert('Collez le lien https de l\'étiquette prépayée.'); return; }
        const sb = form.querySelector('button');
        sb.disabled = true;
        try {
          await httpsCallable(functions, 'etiquetteRetour')({ commande: d.id, lien });
          sb.textContent = 'Étiquette envoyée au client';
        } catch (err) {
          console.error(err);
          alert("L'étiquette n'a pas pu être envoyée.");
          sb.disabled = false;
        }
      });
      const btn = li.querySelector('button.rendue');
      btn.addEventListener('click', async () => {
        if (!confirm(`La tablette de ${c.email} est bien revenue ?`)) return;
        btn.disabled = true;
        try {
          await httpsCallable(functions, 'tabletteRendue')({ commande: d.id });
          // La tablette revient dans le stock, à vérifier avant de repartir.
          const { stock } = await donnees().catch(() => ({ stock: [] }));
          const t = stock.find((x) => x.commande === d.id);
          if (t) await appeler('gestionStock', { action: 'modifier', id: t.id, champs: { etat: 'revenue' } }).catch(() => null);
          signalerChangement();
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
  loadShipped();
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

// Demandes en attente dans une famille : l'administrateur peut les accepter, et désigner le
// propriétaire (par exemple après un changement de compte, quand plus personne ne peut accepter).
async function showPending(f, li) {
  let snap;
  try {
    snap = await getDocs(query(collection(db, 'families', f.id, 'members'), where('status', '==', 'pending')));
  } catch (err) { return; }
  if (snap.empty) return;
  const box = document.createElement('div');
  box.className = 'replace';
  for (const d of snap.docs) {
    const m = d.data();
    const row = document.createElement('p');
    row.className = 'small pending-row';
    row.textContent = `En attente : ${m.name}${m.email ? ` (${m.email})` : ''} `;
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'link small';
    ok.textContent = 'Accepter';
    const owner = document.createElement('button');
    owner.type = 'button';
    owner.className = 'link small';
    owner.textContent = 'Accepter comme propriétaire';
    const accept = async (asOwner) => {
      try {
        await updateDoc(d.ref, { status: 'active' });
        if (asOwner) await updateDoc(doc(db, 'families', f.id), { createdBy: d.id });
        row.textContent = asOwner ? `${m.name} est maintenant propriétaire.` : `${m.name} a été accepté.`;
      } catch (err) {
        console.error(err);
        alert("L'opération a échoué.");
      }
    };
    ok.addEventListener('click', () => accept(false));
    owner.addEventListener('click', () => { if (confirm(`Faire de ${m.name} le propriétaire de la famille de ${f.name} ?`)) accept(true); });
    row.append(ok, ' · ', owner);
    box.append(row);
  }
  li.append(box);
}

// Membres d'une famille : l'administrateur peut, en secours, nommer ou retirer un responsable,
// changer le propriétaire et retirer un proche (jamais le propriétaire).
async function toggleMembers(f, li) {
  const out = li.querySelector('.members-out');
  if (!out.hidden) { out.hidden = true; return; }
  out.hidden = false;
  out.textContent = 'Chargement…';
  let snap;
  let fam;
  try {
    [snap, fam] = await Promise.all([
      getDocs(query(collection(db, 'families', f.id, 'members'), where('role', '==', 'famille'))),
      getDoc(doc(db, 'families', f.id)),
    ]);
  } catch (err) {
    console.error(err);
    out.textContent = 'Lecture impossible.';
    return;
  }
  const data = fam.data() || {};
  const admins = new Set(data.admins || []);
  const rerender = () => { out.hidden = true; toggleMembers(f, li); };
  const act = async (fn) => {
    try { await fn(); rerender(); } catch (err) { console.error(err); alert("L'opération a échoué."); }
  };
  const button = (label, onClick, danger) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `link small${danger ? ' danger' : ''}`;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  const famRef = doc(db, 'families', f.id);
  const rows = snap.docs.filter((d) => d.data().status !== 'pending').map((d) => {
    const m = d.data();
    const isOwner = data.createdBy === d.id;
    const isResp = isOwner || admins.has(d.id);
    const row = document.createElement('p');
    row.className = 'small pending-row';
    row.textContent = `${m.name}${m.email ? ` (${m.email})` : ''}${isOwner ? ' · propriétaire' : isResp ? ' · responsable' : ''} `;
    if (isOwner) return row;
    const parts = [
      button(isResp ? 'Retirer responsable' : 'Rendre responsable', () => act(() => {
        const next = new Set(admins);
        if (isResp) next.delete(d.id); else next.add(d.id);
        return updateDoc(famRef, { admins: [...next] });
      })),
      button('Faire propriétaire', () => {
        if (confirm(`Faire de ${m.name} le propriétaire de la famille de ${f.name} ?`)) act(() => updateDoc(famRef, { createdBy: d.id }));
      }),
      button('Retirer', () => {
        if (!confirm(`Retirer ${m.name} de la famille de ${f.name} ?`)) return;
        act(async () => {
          if (admins.has(d.id)) { const next = new Set(admins); next.delete(d.id); await updateDoc(famRef, { admins: [...next] }); }
          await deleteDoc(d.ref);
        });
      }, true),
    ];
    parts.forEach((p, i) => row.append(...(i ? [' · ', p] : [p])));
    return row;
  });
  out.replaceChildren(...(rows.length ? rows : [Object.assign(document.createElement('p'), { className: 'small muted', textContent: 'Aucun proche.' })]));
}

// Tablette de remplacement : un code d'installation pour cette famille. Installée avec
// installer-tablette.ps1 -Code, elle arrive déjà dans la famille, sans écran de bienvenue.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
async function prepareReplacement(f, li) {
  const out = li.querySelector('.replace-out');
  if (!confirm(`Préparer une tablette de remplacement pour la famille de ${f.name} ?`)) return;
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  try {
    await setDoc(doc(db, 'invites', code), { fid: f.id, createdBy: auth.currentUser.uid, kind: 'tablette' });
  } catch (err) {
    console.error(err);
    alert("Le code n'a pas pu être créé.");
    return;
  }
  const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
  out.hidden = false;
  out.innerHTML = '';
  const p1 = document.createElement('p');
  p1.textContent = `Installez la nouvelle tablette avec : installer-tablette.ps1 -Code ${shown}`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'link danger small';
  btn.textContent = "Retirer l'ancienne tablette de la famille";
  btn.addEventListener('click', () => removeOldTablets(f, btn));
  out.append(p1, btn);
}

// À faire une fois la nouvelle tablette installée : l'ancienne ne reçoit plus rien.
async function removeOldTablets(f, btn) {
  const snap = await getDocs(query(collection(db, 'families', f.id, 'members'), where('role', '==', 'tablette')));
  const list = snap.docs.map((d) => ({ ref: d.ref, ...d.data() }))
    .sort((a, b) => (toDate(b.joinedAt)?.getTime() || 0) - (toDate(a.joinedAt)?.getTime() || 0));
  // On garde les fiches de la tablette la plus récente (ses deux comptes, inscrits à la même installation).
  const newest = toDate(list[0]?.joinedAt)?.getTime() || 0;
  const old = list.filter((t) => newest - (toDate(t.joinedAt)?.getTime() || 0) > 10 * 60_000);
  if (!old.length) { alert("Aucune ancienne tablette à retirer : installez d'abord la nouvelle."); return; }
  if (!confirm(`Retirer ${old.length} fiche(s) d'ancienne tablette de la famille de ${f.name} ?`)) return;
  btn.disabled = true;
  try {
    for (const t of old) await deleteDoc(t.ref);
    btn.textContent = 'Ancienne tablette retirée';
  } catch (err) {
    console.error(err);
    alert('Le retrait a échoué.');
    btn.disabled = false;
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
    li.innerHTML = `<div class="family-head"><span class="dot"></span><strong></strong><code></code></div><dl></dl>
      <div class="replace"><button type="button" class="link small members-btn">Gérer les membres</button><div class="members-out" hidden></div></div>
      <div class="replace"><button type="button" class="link small replace-btn">Tablette de remplacement</button><p class="replace-out small" hidden></p></div>`;
    li.querySelector('.replace-btn').addEventListener('click', () => prepareReplacement(f, li));
    li.querySelector('.members-btn').addEventListener('click', () => toggleMembers(f, li));
    showPending(f, li);
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
