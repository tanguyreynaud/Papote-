// Banc « utilisateurs simulés » : des personnages joués par Claude essaient l'app famille (téléphone) et la tablette
// (écran de Mamie), geste par geste, sur les vrais écrans servis en local avec la fausse base de la galerie
// (outils/galerie : faux-firebase.js, fausse app Android). Rien ne touche Firebase ni une vraie famille.
//
// Chaque geste : capture de l'écran (avec un numéro sur chaque chose touchable) + liste de ces choses → l'acteur
// (Haiku par défaut) dit ce qu'il voit, ce qu'il ressent et ce qu'il fait. À la fin, un contrôleur sévère (Opus) relit
// le parcours et classe les défauts. Le coût est compté depuis les jetons ; au-delà du plafond, plus rien ne part.
//
//   node banc.js <lot> [--acteur haiku|sonnet] [--juge direct|lot|non] [--plafond 50] [--arret 45] [--sans-api]
//   node banc.js juger <lot>      (relance seulement le contrôleur sur les parcours déjà joués)
//
// Clé : variable d'environnement ANTHROPIC_API_KEY (jamais écrite dans le dépôt).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const G = path.join(__dirname, '..', 'galerie');
const { extraire, servir, fausseImage, fausseVideo, fauxVisage } = require(path.join(G, 'commun'));
const famille = require(path.join(G, 'famille'));
const tablette = require(path.join(G, 'tablette'));
const { PROCHES, TACHES_FAMILLE, MAMIES, SITUATIONS, LOTS } = require('./personnages');
const compteur = require('./compteur');

const MODELES = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const SOURCES = {
  famille: { ref: process.env.BANC_REF_FAMILLE || 'origin/claude/project-thread-dlattc', dossier: 'web' }, // une branche de corrections : BANC_REF_FAMILLE=origin/…
  tablette: { ref: process.env.BANC_REF_TABLETTE || 'origin/claude/project-thread-cmnwxy', dossier: 'android/app/src/main/assets' },
};
const MAX_GESTES = { famille: 18, tablette: 12 };
const FLOU = new Set(['sylvie', 'odette']);         // voient flou : la capture est floutée
const TREMBLE = new Set(['paul', 'rene']);          // touchent parfois à côté
const SANS_TEXTE = new Set(['lucienne']);           // ne lit pas : la liste ne donne pas les mots

function options(argv) {
  const o = { acteur: 'haiku', juge: 'lot', plafond: 50, arret: 45, sansApi: false, reste: [], parallele: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--acteur') o.acteur = argv[++i];
    else if (a === '--juge') o.juge = argv[++i];
    else if (a === '--plafond') o.plafond = Number(argv[++i]);
    else if (a === '--arret') o.arret = Number(argv[++i]);
    else if (a === '--parallele') o.parallele = Number(argv[++i]);
    else if (a === '--sans-api') o.sansApi = true;
    else o.reste.push(a);
  }
  return o;
}

// ------------------------------------------------------------------ API
let client = null;
function api() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) { console.error('Clé manquante : variable ANTHROPIC_API_KEY.'); process.exit(1); }
    const Anthropic = require('@anthropic-ai/sdk');
    client = new (Anthropic.default || Anthropic)();
  }
  return client;
}
class PlafondAtteint extends Error {}
function garde(o) {
  if (compteur.total() >= o.arret) throw new PlafondAtteint(`Arrêt : ${compteur.dollars(compteur.total())} dépensés (arrêt à ${o.arret} $).`);
}

// ------------------------------------------------------------------ l'écran vu par le personnage
// Numérote tout ce qui a l'air touchable et visible, pose une pastille sur chacun, renvoie la liste.
function listerTouchables(sansTexte) {
  document.querySelectorAll('[data-banc-n]').forEach((e) => e.removeAttribute('data-banc-n'));
  document.getElementById('__banc')?.remove();
  const W = innerWidth, H = innerHeight;
  const INTRINSEQUE = 'button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=checkbox], [role=switch], [role=radio], [role=option], [onclick], summary, label[for], [contenteditable=true]';
  const cands = new Set(document.querySelectorAll(INTRINSEQUE));
  let vus = 0;
  for (const e of document.querySelectorAll('body *')) {
    if (++vus > 4000) break;
    const cs = getComputedStyle(e);
    if (cs.cursor === 'pointer' && (!e.parentElement || getComputedStyle(e.parentElement).cursor !== 'pointer')) cands.add(e);
  }
  const garde = [];
  for (const e of cands) {
    if (e.closest('[data-banc-n]')) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.right <= 0 || r.top >= H || r.left >= W) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
    const cx = Math.min(Math.max(r.left + r.width / 2, 1), W - 1), cy = Math.min(Math.max(r.top + r.height / 2, 1), H - 1);
    const dessus = document.elementFromPoint(cx, cy);
    if (!dessus || !(e === dessus || e.contains(dessus) || dessus.contains(e))) continue;
    if (garde.some((g) => g.e.contains(e) || e.contains(g.e))) {
      // On garde le plus intérieur des deux s'il est un vrai bouton, sinon le plus extérieur.
      const autre = garde.find((g) => g.e.contains(e) || e.contains(g.e));
      if (autre.e.contains(e) && e.matches(INTRINSEQUE) && !autre.e.matches(INTRINSEQUE)) garde.splice(garde.indexOf(autre), 1);
      else continue;
    }
    garde.push({ e, r, cx, cy });
  }
  const calque = document.createElement('div');
  calque.id = '__banc';
  calque.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;filter:none';
  const liste = garde.slice(0, 60).map((g, i) => {
    const n = i + 1;
    g.e.setAttribute('data-banc-n', String(n));
    const b = document.createElement('div');
    b.textContent = n;
    b.style.cssText = `position:absolute;left:${Math.max(0, g.r.left)}px;top:${Math.max(0, g.r.top)}px;background:#e11d48;color:#fff;font:bold 11px/14px sans-serif;padding:0 3px;border-radius:3px;opacity:.9`;
    calque.appendChild(b);
    const e = g.e;
    const img = e.querySelector?.('img[alt]');
    let mots = (e.tagName === 'SELECT' ? '' : e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.title || (img && img.alt) || '').trim().replace(/\s+/g, ' ');
    if (mots.length > 70) mots = mots.slice(0, 67) + '…';
    const TYPES = { date: 'champ date (le téléphone ouvre un calendrier : action « ecrire » avec la date, ex. 26/11/2026)', time: 'champ heure (le téléphone ouvre une horloge : action « ecrire » avec l’heure, ex. 10:00)', 'datetime-local': 'champ date et heure (action « ecrire », ex. 26/11/2026 10:00)' };
    const type = e.tagName === 'INPUT' ? (TYPES[e.type] || `champ ${e.type}`) : e.tagName === 'TEXTAREA' ? 'champ texte' : e.tagName === 'SELECT' ? `liste déroulante (action « choisir » avec le texte d’un choix) : ${[...e.options].map((x) => (x.selected ? '●' : '') + '« ' + x.text.trim() + ' »').join(' / ')}` : e.tagName === 'A' ? 'lien' : 'bouton';
    if (e.tagName === 'SELECT') mots = `réglée sur « ${e.options[e.selectedIndex]?.text.trim() || ''} »`;
    return { n, type, mots: sansTexte ? '' : mots, x: Math.round(g.cx), y: Math.round(g.cy), l: Math.round(g.r.width), h: Math.round(g.r.height), inactif: !!(e.disabled || e.getAttribute('aria-disabled') === 'true') };
  });
  document.documentElement.appendChild(calque);
  return liste;
}

async function photo(page, flou) {
  if (flou) await page.evaluate(() => { document.body.style.filter = 'blur(2.2px)'; });
  const buf = await page.screenshot({ type: 'jpeg', quality: 60, scale: 'css', animations: 'allow' });
  if (flou) await page.evaluate(() => { document.body.style.filter = ''; });
  return buf;
}
const empreinte = async (page) => crypto.createHash('md5').update(await page.screenshot({ type: 'jpeg', quality: 30, scale: 'css' })).digest('hex');

// ------------------------------------------------------------------ l'acteur
const SCHEMA_ACTEUR = {
  type: 'object', additionalProperties: false,
  required: ['je_vois', 'je_pense', 'action', 'numero', 'x', 'y', 'texte', 'confusion'],
  properties: {
    je_vois: { type: 'string', description: "Ce que le personnage voit et comprend de l'écran, avec ses mots (1 phrase)." },
    je_pense: { type: 'string', description: 'Ce qu’il ressent ou se demande (1 phrase). Dire franchement si c’est confus, inquiétant, trop petit…' },
    action: { type: 'string', enum: ['toucher', 'toucher_point', 'appui_long', 'ecrire', 'choisir', 'tourner_telephone', 'defiler_bas', 'defiler_haut', 'retour', 'attendre', 'termine', 'abandonner'] },
    numero: { type: 'integer', description: 'Numéro de la pastille pour toucher/appui_long/ecrire, sinon 0.' },
    x: { type: 'integer', description: 'Pour toucher_point seulement (coordonnées de la capture), sinon 0.' },
    y: { type: 'integer' },
    texte: { type: 'string', description: 'Pour ecrire : le texte tapé. Pour choisir : le texte du choix. Pour abandonner : pourquoi. Sinon vide.' },
    confusion: { type: 'integer', description: '0 = tout est clair, 1 = petite hésitation, 2 = perdu ou inquiet, 3 = bloqué.' },
  },
};

function consignesActeur(parcours) {
  const tab = parcours.ecran === 'tablette';
  const perso = tab ? MAMIES[parcours.perso] : PROCHES[parcours.perso];
  const t = tab ? SITUATIONS[parcours.tache] : TACHES_FAMILLE[parcours.tache];
  return `Tu joues un VRAI utilisateur qui découvre un écran, pour un test d'utilisabilité. Tu n'es pas un testeur : tu ne connais pas l'application, tu ne cherches pas les bugs, tu essaies juste de faire ce que tu veux faire, comme le ferait cette personne, avec ses limites.

Personnage : ${perso.nom}. ${perso.qui}
${tab ? "L'appareil : la tablette Papote posée chez toi, toujours allumée, en paysage. Tu ne peux que toucher l'écran (pas de bouton retour, pas de clavier). Tu n'as rien installé, ta famille s'occupe de tout à distance." : "L'appareil : ton téléphone, avec l'app Papote que ta famille utilise pour envoyer des photos et des messages à la tablette de Mamie (une grand-mère qui n'a pas de smartphone)."}

Ce que tu veux faire : ${t.but}

Règles du jeu :
- À chaque tour tu reçois la capture de l'écran tel que TU le vois${FLOU.has(parcours.perso) ? ' (flou, à cause de ta vue)' : ''}. Chaque chose touchable porte une petite pastille rouge avec un numéro : ces pastilles n'existent pas pour toi, elles servent seulement à dire où tu touches. Ne lis pas l'écran mieux que ton personnage ne le pourrait.
- ${SANS_TEXTE.has(parcours.perso) ? "Tu ne sais PAS lire : ignore tous les mots, fie-toi aux images, aux visages, aux couleurs, aux symboles." : "Tu reçois aussi la liste des numéros avec les mots écrits dessus."}
- Une seule action par tour. « toucher » une pastille, « toucher_point » un endroit sans pastille (photo, fond…), « appui_long », « ecrire » (touche le champ et tape le texte), « choisir » (dans une liste déroulante : donne le texte du choix)${tab ? '' : ', « tourner_telephone » (tenir le téléphone couché, ou le remettre debout)'}, « defiler_bas/haut »${tab ? '' : ', « retour » (bouton retour du téléphone)'}, « attendre » (ne rien faire un moment), « termine » quand tu as fait ce que tu voulais, « abandonner » si tu n'y arrives pas ou si tu as peur de continuer (dis pourquoi).
- Agis comme la personne : si elle ne comprend pas, elle hésite, se trompe, touche au hasard, revient en arrière ou abandonne. Ne devine pas une astuce qu'elle ne trouverait pas.
- « je_vois » et « je_pense » : très courts, à la première personne, sincères (si c'est confus, inquiétant, trop petit, trop long, dis-le).
- Les photos sont des images de démonstration (dessins) : fais comme si c'étaient de vraies photos de famille.
- Si un code ou une information t'est demandé et que tu l'as (ex. un code famille donné dans ta tâche), utilise-le. Sinon invente une réponse plausible (prénom, numéro 06…).`;
}

function demandeActeur(parcours, histoire, liste, image, geste) {
  const tab = parcours.ecran === 'tablette';
  const passes = histoire.slice(-10).map((h) => `${h.geste}. ${h.resume}`).join('\n') || '(rien encore, tu découvres l’écran)';
  const elements = liste.length ? liste.map((e) => `[${e.n}] ${e.type}${e.mots ? ` « ${e.mots} »` : ''}${e.inactif ? ' (grisé)' : ''} (${e.x},${e.y}, ${e.l}×${e.h})`).join('\n') : '(aucune pastille : rien ne semble touchable)';
  return [
    { type: 'text', text: `Tour ${geste} sur ${MAX_GESTES[parcours.ecran]} au plus.\nCe que tu as fait jusqu'ici :\n${passes}\n\nChoses touchables à l'écran${tab ? '' : ' (taille en points, un doigt fait environ 45 points)'} :\n${elements}\n\nVoici l'écran maintenant. Que fais-tu ?` },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.toString('base64') } },
  ];
}

async function acteur(o, parcours, histoire, liste, image, geste) {
  if (o.sansApi) {
    const e = liste[Math.floor(Math.random() * liste.length)];
    return geste >= 4 ? { je_vois: '(sans API)', je_pense: '', action: 'termine', numero: 0, x: 0, y: 0, texte: '', confusion: 0 }
      : { je_vois: '(sans API)', je_pense: '', action: e ? 'toucher' : 'attendre', numero: e ? e.n : 0, x: 0, y: 0, texte: '', confusion: 0 };
  }
  garde(o);
  const modele = MODELES[o.acteur];
  const r = await api().messages.create({
    model: modele, max_tokens: 600,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA_ACTEUR } },
    system: [{ type: 'text', text: consignesActeur(parcours), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: demandeActeur(parcours, histoire, liste, image, geste) }],
  });
  const d = compteur.ajouter(modele, r.usage);
  const texte = r.content.find((c) => c.type === 'text')?.text || '{}';
  let dec;
  try { dec = JSON.parse(texte); } catch { dec = { je_vois: '', je_pense: 'réponse illisible', action: 'attendre', numero: 0, x: 0, y: 0, texte: '', confusion: 0 }; }
  dec.cout = d; dec.jetons = r.usage;
  return dec;
}

// ------------------------------------------------------------------ le monde autour (tablette : la famille « répond »)
function reactions() {
  const prevues = []; // { dans, faire }
  return {
    async apres(page, geste) {
      const nouveaux = await page.evaluate(() => { const a = window.__android || []; const n = a.slice(window.__bancVu || 0); window.__bancVu = a.length; return n; }).catch(() => []);
      const notes = [];
      for (const m of nouveaux) {
        if (/^(touched|pouls|logError|identite|fenetre|gardeFou|setDim|setSleep|ready|inCall|logAppel|phoneState|phoneReady|wifiStatus|isCharging|sosEnCours|carillonStop|carillonEnCours|stopSpeaking|stopVoice|redemarrageAffiche|redemarrageNon|qrCode|morePhotos)$/.test(m)) continue;
        notes.push(m);
        if (m === 'phoneCall') { prevues.push({ dans: geste + 1, faire: (p) => p.evaluate(() => window.Papote.onGsm({ etat: 'appel' })) }); prevues.push({ dans: geste + 2, faire: (p) => p.evaluate(() => window.Papote.onGsm({ etat: 'enLigne' })) }); }
        if (m === 'phoneAnswer') prevues.push({ dans: geste, faire: (p) => p.evaluate(() => window.Papote.onGsm({ etat: 'enLigne' })) });
        if (m === 'phoneHangup') prevues.push({ dans: geste, faire: (p) => p.evaluate(() => window.Papote.onGsm({ etat: 'fin', cause: 'raccroche' })) });
        if (m === 'papoteCallFamily') { prevues.push({ dans: geste, faire: (p) => p.evaluate(() => window.__appelEnCours?.onState('ringing', { names: ['Julie', 'Thomas', 'Anne'] })) }); prevues.push({ dans: geste + 2, faire: (p) => p.evaluate(() => window.__appelEnCours?.onState('connected', { uid: 'u-julie', name: 'Julie' })) }); }
      }
      for (const r of prevues.filter((x) => x.dans <= geste)) { prevues.splice(prevues.indexOf(r), 1); await r.faire(page).catch(() => {}); await page.waitForTimeout(500); }
      return notes;
    },
  };
}

// ------------------------------------------------------------------ un parcours
async function ouvrirDepart(browser, base, parcours, video, exemples) {
  const tab = parcours.ecran === 'tablette';
  const def = tab ? SITUATIONS[parcours.tache] : TACHES_FAMILLE[parcours.tache];
  const scenes = tab ? tablette.SCENES : famille.SCENES;
  const scene = scenes.find((s) => s.titre === def.depart);
  if (!scene) throw new Error(`Écran de départ introuvable dans la galerie : « ${def.depart} »`);
  const taille = { ...(tab ? tablette.TAILLES[0] : famille.TAILLES[0]) }; // copie : « tourner_telephone » la modifie (bug du 21/11 : les parcours suivants partaient couchés)
  const sc = { ...scene, heure: def.heure || scene.heure };
  const { ctx, page, erreurs } = await (tab ? tablette : famille).ouvrir(browser, base, sc, taille, video);
  const notes = [];
  page.on('dialog', async (d) => { notes.push(`Fenêtre du navigateur (${d.type()}) : « ${d.message()} »`); await d.accept().catch(() => {}); });
  page.on('filechooser', async (fc) => {
    const video = /video/.test(await fc.element().getAttribute('accept').catch(() => '') || '');
    await fc.setFiles(video ? exemples.video : exemples.photo).catch(() => {});
    notes.push(video ? 'La galerie du téléphone s’ouvre : la vidéo du petit Léo est choisie.' : 'La galerie du téléphone s’ouvre : la photo d’hier est choisie.');
  });
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|net::ERR|Failed to load resource/.test(m.text())) erreurs.push('console : ' + m.text().slice(0, 200)); });
  if (tab && def.telephones) {
    // Les proches ont un numéro (obligatoire depuis le 29/10) : la tablette montre « Appeler ».
    const proches = [['u-julie', 'Julie'], ['u-thomas', 'Thomas'], ['u-anne', 'Anne']].map(([uid, name], i) => ({ uid, name, tel: ['0612345678', '0687654321', '0756781234'][i], responsable: i === 0 }));
    const faces = Object.fromEntries(proches.map((x, i) => [x.uid, fauxVisage(x.name, i)]));
    await page.evaluate(({ people, faces }) => window.Papote.onFamily({ people, faces, birthdays: [] }), { people: proches, faces });
    await page.waitForTimeout(800);
  }
  if (parcours.reseau === 'lent') await ctx.route('**/*', async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); r.fallback(); });
  return { ctx, page, erreurs, notes, taille };
}

async function jouer(o, browser, bases, parcours, dossier, video, exemples) {
  const tab = parcours.ecran === 'tablette';
  const rep = path.join(dossier, parcours.id);
  fs.mkdirSync(rep, { recursive: true });
  const { ctx, page, erreurs, notes, taille } = await ouvrirDepart(browser, bases[parcours.ecran], parcours, video, exemples);
  const monde = reactions();
  const histoire = [];
  let fin = 'limite de gestes', cout = 0;
  try {
    for (let geste = 1; geste <= MAX_GESTES[parcours.ecran]; geste++) {
      const avant = await empreinte(page);
      const liste = await page.evaluate(listerTouchables, SANS_TEXTE.has(parcours.perso));
      const image = await photo(page, FLOU.has(parcours.perso));
      await page.evaluate(() => document.getElementById('__banc')?.remove());
      fs.writeFileSync(path.join(rep, `${String(geste).padStart(2, '0')}.jpg`), image);
      const nErr = erreurs.length, nNotes = notes.length;
      // Premier geste imposé par la situation (ex. SOS touché par erreur en nettoyant l'écran).
      const def = tab ? SITUATIONS[parcours.tache] : TACHES_FAMILLE[parcours.tache];
      let dec;
      if (geste === 1 && def.premier) {
        dec = { je_vois: '', je_pense: '(geste imposé par la situation)', action: 'toucher_point', numero: 0, x: 0, y: 0, texte: '', confusion: 0, impose: def.premier.selecteur };
      } else {
        dec = await acteur(o, parcours, histoire, liste, image, geste);
      }
      cout += dec.cout || 0;
      let quoi = '', decale = '';
      const cible = liste.find((e) => e.n === dec.numero);
      const point = async (x, y) => {
        if (TREMBLE.has(parcours.perso) && Math.random() < 0.3) { x += Math.round((Math.random() - 0.5) * 24); y += Math.round((Math.random() - 0.5) * 24); decale = ' (le doigt a un peu glissé)'; }
        await page.touchscreen.tap(x, y);
      };
      try {
        if (dec.impose) { const b = await page.locator(dec.impose).first().boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); quoi = `a touché le bouton SOS par erreur`; }
        else if (dec.action === 'toucher' && cible) { await point(cible.x, cible.y); quoi = `a touché [${cible.n}]${cible.mots ? ` « ${cible.mots} »` : ''}`; }
        else if (dec.action === 'toucher_point' || (dec.action === 'toucher' && !cible)) { const x = dec.x || taille.width / 2, y = dec.y || taille.height / 2; await point(x, y); quoi = `a touché l'écran en (${x},${y})`; }
        else if (dec.action === 'appui_long' && cible) { await page.mouse.move(cible.x, cible.y); await page.mouse.down(); await page.waitForTimeout(1300); await page.mouse.up(); quoi = `a appuyé longtemps sur [${cible.n}]`; }
        else if (dec.action === 'ecrire' && cible) {
          const loc = page.locator(`[data-banc-n="${cible.n}"]`);
          const genre = await loc.evaluate((e) => (e.tagName === 'INPUT' ? e.type : '')).catch(() => '');
          if (/^(date|time|datetime-local)$/.test(genre)) {
            // Sélecteurs natifs du téléphone (calendrier, horloge) : invisibles dans le banc, la valeur est posée directement.
            const t = dec.texte || ''; const d = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); const h = t.match(/(\d{1,2})[:h](\d{2})?/);
            const date = d ? `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}` : '';
            const heure = h ? `${h[1].padStart(2, '0')}:${(h[2] || '00')}` : '';
            await point(cible.x, cible.y);
            await loc.fill(genre === 'date' ? date : genre === 'time' ? heure : `${date}T${heure}`);
            quoi = `a choisi « ${t} » dans le ${genre === 'time' ? 'sélecteur d’heure' : 'calendrier'} du téléphone [${cible.n}]`;
          } else { await point(cible.x, cible.y); await page.keyboard.type(dec.texte || '', { delay: 15 }); quoi = `a tapé « ${dec.texte} » dans [${cible.n}]`; }
        }
        else if (dec.action === 'choisir' && cible) {
          const loc = page.locator(`[data-banc-n="${cible.n}"]`);
          const opts = await loc.evaluate((e) => (e.options ? [...e.options].map((o) => o.text.trim()) : [])).catch(() => []);
          const voulu = opts.find((x) => x === (dec.texte || '').trim()) || opts.find((x) => x.toLowerCase().includes((dec.texte || '').toLowerCase().trim()));
          if (voulu) { await loc.selectOption({ label: voulu }); quoi = `a choisi « ${voulu} » dans la liste [${cible.n}]`; } else quoi = `voulait choisir « ${dec.texte} » dans [${cible.n}] (choix introuvable)`;
        }
        else if (dec.action === 'tourner_telephone' && !tab) {
          const v = page.viewportSize(); await page.setViewportSize({ width: v.height, height: v.width }); taille.width = v.height; taille.height = v.width;
          quoi = v.width < v.height ? 'a tourné le téléphone (couché)' : 'a remis le téléphone debout';
        }
        else if (dec.action === 'defiler_bas' || dec.action === 'defiler_haut') { await page.mouse.move(taille.width / 2, taille.height / 2); await page.mouse.wheel(0, (dec.action === 'defiler_bas' ? 1 : -1) * taille.height * 0.6); quoi = dec.action === 'defiler_bas' ? 'a fait défiler vers le bas' : 'a fait défiler vers le haut'; }
        else if (dec.action === 'retour' && !tab) { await page.goBack({ timeout: 3000 }).catch(() => page.evaluate(() => history.back())); quoi = 'a appuyé sur Retour'; }
        else if (dec.action === 'attendre') { await page.clock.runFor(tab ? 20000 : 12000).catch(() => {}); await page.waitForTimeout(1500); quoi = 'a attendu un moment'; }
        else if (dec.action === 'termine') { quoi = 'pense avoir fini'; fin = 'termine'; }
        else if (dec.action === 'abandonner') { quoi = `abandonne : ${dec.texte}`; fin = 'abandon'; }
        else { quoi = `voulait « ${dec.action} » (impossible ici)`; }
      } catch (e) { quoi += ` (geste impossible : ${e.message.split('\n')[0].slice(0, 120)})`; }
      if (fin !== 'limite de gestes') {
        histoire.push({ geste, ...nettoyer(dec), resume: quoi, changement: null, notes: notes.slice(nNotes), erreurs: erreurs.slice(nErr) });
        break;
      }
      await page.waitForTimeout(1000);
      const android = tab ? await monde.apres(page, geste) : [];
      const change = (await empreinte(page)) !== avant;
      histoire.push({ geste, ...nettoyer(dec), resume: `${quoi}${decale} → ${change ? "l'écran a changé" : 'rien ne semble avoir changé'}${notes.length > nNotes ? ` (${notes.slice(nNotes).join(' ; ')})` : ''}`, changement: change, android, notes: notes.slice(nNotes), erreurs: erreurs.slice(nErr) });
    }
  } finally {
    // Dernière image, telle que l'écran est à la fin.
    await page.screenshot({ path: path.join(rep, 'fin.jpg'), type: 'jpeg', quality: 60, scale: 'css' }).catch(() => {});
    await ctx.close().catch(() => {});
  }
  const journal = { ...parcours, acteur: MODELES[o.acteur], fin, gestes: histoire.length, cout, erreursPage: erreurs, histoire };
  fs.writeFileSync(path.join(rep, 'journal.json'), JSON.stringify(journal, null, 1));
  return journal;
}
const nettoyer = (d) => ({ je_vois: d.je_vois, je_pense: d.je_pense, action: d.action, numero: d.numero, texte: d.texte, confusion: d.confusion });

// ------------------------------------------------------------------ le contrôleur
const SCHEMA_JUGE = {
  type: 'object', additionalProperties: false, required: ['tache_reussie', 'note', 'resume', 'defauts'],
  properties: {
    tache_reussie: { type: 'boolean' },
    note: { type: 'integer', description: '1 = inutilisable pour ce personnage, 5 = parfait.' },
    resume: { type: 'string' },
    defauts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['gravite', 'ecran', 'probleme', 'gestes', 'piste', 'cause_banc'],
      properties: {
        gravite: { type: 'string', enum: ['grave', 'moyen', 'mineur'] },
        ecran: { type: 'string', description: "Quel écran / quel bouton, avec les mots de l'interface." },
        probleme: { type: 'string', description: 'Le défaut, concret, vu du personnage.' },
        gestes: { type: 'array', items: { type: 'integer' }, description: 'Numéros des gestes qui le prouvent.' },
        piste: { type: 'string', description: 'Correction proposée, dans les règles du projet.' },
        cause_banc: { type: 'boolean', description: 'true si le défaut vient probablement du banc (fausse base, appel simulé, acteur qui se trompe tout seul) et pas de l’app.' },
      } } },
  },
};

const REGLES_PROJET = `Papote : une tablette pour seniors (écran de Mamie, aucune manipulation attendue d'elle : « zéro clic ») et une app web pour la famille (envoyer photos, vidéos, messages, appels vidéo, rappels, réglages de la tablette). Règles du projet à respecter dans tes pistes : public senior, gros boutons de même taille, rien d'anxiogène, jamais de fenêtre confirm/alert du navigateur, aucun élément touchable sans effet visible immédiat, un double toucher ne fait jamais deux envois, texte trop long coupé par « … », pas d'orange, pas de commande vocale, pas de zoom sur les photos, pas de Bluetooth. N'invente pas de fonction contraire à ces choix.`;
const LIMITES_BANC = `Limites connues du banc (ne pas les compter comme des défauts de l'app, mettre cause_banc=true si c'est ça) : la base de données est fausse (données de démonstration, réponses du serveur simulées), il n'y a ni vraie caméra ni vrai son, les appels sont simulés (sur la tablette, « ça sonne » puis « en ligne » sont envoyés automatiquement 1 à 2 gestes après le lancement ; dans l'app, l'autre côté ne décroche jamais), les pastilles rouges numérotées sont ajoutées par le banc, l'heure est simulée, les photos et vidéos sont des dessins de démonstration (paysage, soleil, « photo 1 · paysage »), les factures, le prix et la formule affichés viennent de fausses données (ancienne formule « Wi-Fi à 20 € »), le code famille et le nom de la tablette ne sont pas vérifiés par un vrai serveur, la connexion Google n'existe pas (le personnage commence déjà connecté). Les fenêtres natives du téléphone (calendrier, horloge, liste déroulante, galerie de photos) ne sont pas dessinées : le banc pose directement la valeur choisie. Pendant un appel vidéo, l'écran d'appel de l'app est volontairement tourné d'un quart de tour quand le téléphone est debout (sur Android le téléphone passe tout seul à l'horizontale en plein écran, sur iPhone on tourne le téléphone) : ce n'est un défaut que si rien n'invite à tourner le téléphone. L'acteur est un modèle d'IA : s'il fait une erreur qu'aucun humain de ce profil ne ferait, ce n'est pas un défaut de l'app.`;

function demandeJuge(j, dossier) {
  const tab = j.ecran === 'tablette';
  const perso = tab ? MAMIES[j.perso] : PROCHES[j.perso];
  const t = tab ? SITUATIONS[j.tache] : TACHES_FAMILLE[j.tache];
  const lignes = j.histoire.map((h) => `${h.geste}. [confusion ${h.confusion}] vois : ${h.je_vois} | pense : ${h.je_pense} | ${h.resume}${h.android?.length ? ` | la tablette a appelé Android : ${h.android.join(', ')}` : ''}${h.erreurs?.length ? ` | ERREUR DE PAGE : ${h.erreurs.join(' ; ')}` : ''}`).join('\n');
  // Images : les gestes les plus confus ou sans effet, et la fin (4 au plus).
  const choix = j.histoire.filter((h) => h.confusion >= 2 || h.changement === false).map((h) => h.geste);
  const images = [...new Set([1, ...choix])].slice(0, 3);
  const contenu = [{ type: 'text', text: `Personnage : ${perso.nom}. ${perso.qui}\nCe qu'il voulait : ${t.but}\nRéussite attendue : ${t.reussite}\nFin du parcours : ${j.fin} après ${j.gestes} gestes.${j.erreursPage.length ? `\nErreurs de page : ${j.erreursPage.slice(0, 8).join(' ; ')}` : ''}\n\nJournal geste par geste :\n${lignes}\n\nCaptures jointes : ${images.map((g) => `geste ${g} (avant le geste)`).join(', ')}, puis l'écran final.` }];
  for (const g of images) {
    const f = path.join(dossier, j.id, `${String(g).padStart(2, '0')}.jpg`);
    if (fs.existsSync(f)) contenu.push({ type: 'text', text: `Geste ${g} :` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(f).toString('base64') } });
  }
  const fin = path.join(dossier, j.id, 'fin.jpg');
  if (fs.existsSync(fin)) contenu.push({ type: 'text', text: 'Écran final :' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(fin).toString('base64') } });
  return contenu;
}

const SYSTEME_JUGE = `Tu es un contrôleur d'utilisabilité très sévère mais juste. On te donne le parcours d'un utilisateur simulé (personnage précis) sur un écran de Papote, geste par geste, avec ce qu'il voyait et pensait, et quelques captures. Ton travail : dire si la tâche a réussi, noter de 1 à 5 l'expérience POUR CE PERSONNAGE, et lister les vrais défauts de l'interface (pas de l'acteur).

Gravité : « grave » = le personnage est bloqué, se trompe d'action avec une conséquence (envoi raté, appel non voulu, argent, données), ou est inquiet / perdu durablement ; « moyen » = il y arrive mais avec une vraie hésitation ou un détour évitable ; « mineur » = gêne légère. Sois concret (quel écran, quels mots), cite les gestes qui le prouvent, propose une piste simple. Pas de défaut inventé : s'il n'y a rien, liste vide.

${REGLES_PROJET}

${LIMITES_BANC}`;

async function juger(o, journaux, dossier) {
  const aJuger = journaux.filter((j) => !fs.existsSync(path.join(dossier, j.id, 'avis.json')));
  if (!aJuger.length || o.juge === 'non' || o.sansApi) return;
  garde(o);
  const modele = MODELES.opus;
  const requete = (j) => ({
    model: modele, max_tokens: 6000, output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA_JUGE } },
    system: [{ type: 'text', text: SYSTEME_JUGE, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: demandeJuge(j, dossier) }],
  });
  const enregistrer = (j, msg, lot) => {
    const d = compteur.ajouter(modele, msg.usage, lot);
    let avis;
    try { avis = JSON.parse(msg.content.find((c) => c.type === 'text')?.text || ''); } catch { avis = { erreur: 'avis illisible', brut: msg.content }; }
    avis.cout = d;
    fs.writeFileSync(path.join(dossier, j.id, 'avis.json'), JSON.stringify(avis, null, 1));
  };
  if (o.juge === 'direct') {
    for (const j of aJuger) { garde(o); enregistrer(j, await api().messages.create(requete(j)), false); console.log(`  avis ${j.id} (total ${compteur.dollars(compteur.total())})`); }
    return;
  }
  const lot = await api().messages.batches.create({ requests: aJuger.map((j) => ({ custom_id: j.id, params: requete(j) })) });
  fs.writeFileSync(path.join(dossier, 'lot-juge.json'), JSON.stringify({ id: lot.id, ids: aJuger.map((j) => j.id) }));
  console.log(`Contrôleur en lot : ${lot.id} (${aJuger.length} parcours), attente…`);
  await resultatsLot(lot.id, journaux, dossier, enregistrer);
}

async function resultatsLot(id, journaux, dossier, enregistrer) {
  for (;;) {
    const b = await api().messages.batches.retrieve(id);
    if (b.processing_status === 'ended') break;
    await new Promise((ok) => setTimeout(ok, 30000));
  }
  for await (const r of await api().messages.batches.results(id)) {
    const j = journaux.find((x) => x.id === r.custom_id);
    if (r.result.type === 'succeeded') enregistrer(j, r.result.message, true);
    else console.warn(`  avis ${r.custom_id} : ${r.result.type}`);
  }
}

// ------------------------------------------------------------------ rapport du lot
function rapport(nom, dossier, journaux) {
  const lignes = [`# Banc utilisateurs — lot « ${nom} »`, '', `Coût total du banc à ce jour : ${compteur.dollars(compteur.total())}`, ''];
  const defauts = [];
  for (const j of journaux) {
    let avis = null;
    try { avis = JSON.parse(fs.readFileSync(path.join(dossier, j.id, 'avis.json'), 'utf8')); } catch { /* pas encore */ }
    lignes.push(`## ${j.id} — ${j.fin}, ${j.gestes} gestes, acteur ${compteur.dollars(j.cout)}${avis ? `, note ${avis.note}/5, ${avis.tache_reussie ? 'réussi' : 'RATÉ'}` : ''}`);
    if (avis?.resume) lignes.push('', avis.resume);
    lignes.push('', ...j.histoire.map((h) => `${h.geste}. (${h.confusion}) ${h.je_pense} — ${h.resume}`), '');
    for (const d of avis?.defauts || []) defauts.push({ ...d, parcours: j.id });
  }
  const ordre = { grave: 0, moyen: 1, mineur: 2 };
  defauts.sort((a, b) => (a.cause_banc - b.cause_banc) || (ordre[a.gravite] - ordre[b.gravite]));
  const tete = ['## Défauts trouvés', '', ...defauts.map((d) => `- **${d.gravite}**${d.cause_banc ? ' (probablement le banc)' : ''} · ${d.parcours} · ${d.ecran} : ${d.probleme} → ${d.piste} (gestes ${d.gestes.join(', ')})`), ''];
  fs.writeFileSync(path.join(dossier, 'rapport.md'), [...lignes.slice(0, 4), ...tete, ...lignes.slice(4)].join('\n'));
  fs.writeFileSync(path.join(dossier, 'defauts.json'), JSON.stringify(defauts, null, 1));
  return defauts;
}

// ------------------------------------------------------------------ main
async function main() {
  const o = options(process.argv.slice(2));
  const [cmd, arg] = o.reste;
  const nom = cmd === 'juger' ? arg : cmd;
  const liste = LOTS[nom];
  if (!liste) { console.error(`Lot inconnu. Lots : ${Object.keys(LOTS).join(', ')}`); process.exit(1); }
  const dossier = path.join(__dirname, 'resultats', `${nom}${o.acteur !== 'haiku' ? '-' + o.acteur : ''}`);
  fs.mkdirSync(dossier, { recursive: true });
  console.log(`Lot ${nom} : ${liste.length} parcours, acteur ${MODELES[o.acteur]}, contrôleur ${o.juge}. Déjà dépensé : ${compteur.dollars(compteur.total())} (arrêt à ${o.arret} $).`);

  let journaux = [];
  if (cmd !== 'juger') {
    const ecrans = [...new Set(liste.map((p) => p.ecran))];
    const bases = {}, serveurs = [];
    for (const e of ecrans) {
      const { dir, version } = extraire(SOURCES[e].ref, SOURCES[e].dossier);
      const s = await servir(dir); serveurs.push(s); bases[e] = s.url;
      console.log(`  ${e} : ${version}`);
      fs.writeFileSync(path.join(dossier, `version-${e}.txt`), version);
    }
    const browser = await chromium.launch({ ...(process.env.BANC_CHROME || fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: process.env.BANC_CHROME || '/opt/pw-browsers/chromium' } : {}), env: { ...process.env, LANG: 'fr_FR.UTF-8', LANGUAGE: 'fr' }, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--lang=fr-FR'] });
    const video = await fausseVideo(browser);
    // Une photo et une vidéo « de la galerie du téléphone ».
    const ex = path.join(__dirname, 'resultats', 'exemples'); fs.mkdirSync(ex, { recursive: true });
    const p0 = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await p0.setContent(`<body style="margin:0"><img src="${fausseImage(1, 800, 600)}">`);
    await p0.screenshot({ path: path.join(ex, 'photo.png') });
    await p0.close();
    fs.writeFileSync(path.join(ex, 'video.webm'), await fausseVideo(browser, 640, 360, 3000));
    const exemples = { photo: path.join(ex, 'photo.png'), video: path.join(ex, 'video.webm') };

    const file = liste.filter((p) => !fs.existsSync(path.join(dossier, p.id, 'journal.json')));
    for (const p of liste) if (!file.includes(p)) journaux.push(JSON.parse(fs.readFileSync(path.join(dossier, p.id, 'journal.json'), 'utf8')));
    let arret = null;
    async function ouvrier() {
      for (let p = file.shift(); p && !arret; p = file.shift()) {
        try {
          const j = await jouer(o, browser, bases, p, dossier, video, exemples);
          journaux.push(j);
          console.log(`  ${p.id} : ${j.fin}, ${j.gestes} gestes, ${compteur.dollars(j.cout)} (total ${compteur.dollars(compteur.total())})`);
        } catch (e) {
          if (e instanceof PlafondAtteint) { arret = e.message; break; }
          console.warn(`  ${p.id} : ÉCHEC du banc : ${e.message.split('\n')[0]}`);
        }
      }
    }
    await Promise.all(Array.from({ length: o.parallele }, ouvrier));
    await browser.close();
    serveurs.forEach((s) => s.close());
    if (arret) console.log(arret);
  } else {
    for (const p of liste) { const f = path.join(dossier, p.id, 'journal.json'); if (fs.existsSync(f)) journaux.push(JSON.parse(fs.readFileSync(f, 'utf8'))); }
  }
  try { await juger(o, journaux, dossier); } catch (e) { console.warn(e instanceof PlafondAtteint ? e.message : `Contrôleur : ${e.message}`); }
  const defauts = rapport(nom, dossier, journaux);
  console.log(`Rapport : ${path.join(dossier, 'rapport.md')} — ${defauts.filter((d) => !d.cause_banc).length} défauts (hors banc). Total dépensé : ${compteur.dollars(compteur.total())}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
