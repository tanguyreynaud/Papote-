// La vraie tablette, sans tablette :
//   - son code Java de synchronisation (Sync.java et ses voisines, branche de la tablette) tourne sur l'ordinateur
//     (tablette-jvm/) et parle aux émulateurs Firebase avec les vraies règles ;
//   - son écran (tablette.html, tablette.js, appels.js) est ouvert dans un vrai navigateur, branché sur les mêmes
//     émulateurs pour les appels ;
//   - ce module fait le lien entre les deux, comme MainActivity entre Sync et la page sur la tablette.
// Ce qui reste imité : Android lui-même (sonnerie, volume, veille de l'écran, carte SIM, wifi) et la caméra.
//
//   const mamie = await tablette.allumer({ tab });   // tab : fiche stock d'acteurs.tablettePreparee() (facultatif)
//   await mamie.toucher('#overlay-ok') ; await mamie.pont('reglages') ; await mamie.reseau(false) ; await mamie.rallumer()

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const banc = require('../app-famille/banc');

const { s } = banc;
const ORIGIN = 'https://appassets.androidplatform.net';
const fichierPret = path.join(__dirname, '.tablette', 'pret.json');
if (!fs.existsSync(fichierPret)) throw new Error('Tablette pas préparée : lancez « npm test » (il la prépare).');
const PRET = JSON.parse(fs.readFileSync(fichierPret, 'utf8'));

// L'imitation d'Android écrite pour les essais de la tablette (android/tests/banc.js, sa branche) : reprise telle
// quelle, pour ne pas en tenir deux. Les ponts qui passent par Sync.java sont ensuite branchés sur le vrai code.
const IMITATION = (() => {
  const source = fs.readFileSync(PRET.banc, 'utf8');
  const m = /\nfunction imitation\(etat\) \{\n[\s\S]*?\n\}\n/.exec(source);
  if (!m) throw new Error('android/tests/banc.js : la fonction imitation(etat) a changé de forme, à reprendre ici.');
  return m[0];
})();

// Ce que la page demande à l'appli et qui arrive dans Sync.java (MainActivity, @JavascriptInterface).
const PONTS = ['ready', 'markSeen', 'sendHeart', 'reply', 'realtime', 'changed', 'morePhotos', 'touched', 'seen',
  'ackReminder', 'seenReminder', 'getCode', 'callsAccount', 'setTabletName', 'meteoChoose', 'meteoSkip', 'wifiDone',
  'confirmPairing', 'welcomeBack', 'welcomeSeen', 'cancelPairing', 'getPairing', 'firestoreDatabase'];

function brancherPonts(ponts) {
  const demander = (m, a) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/__pont', false); // l'appli répond tout de suite à la page, comme un pont Android
    x.send(JSON.stringify({ m, a }));
    if (x.status !== 200) throw new Error('pont ' + m + ' : ' + x.responseText);
    return JSON.parse(x.responseText).r;
  };
  ponts.forEach((m) => {
    window.PapoteAndroid[m] = (...a) => { window.__appels.push({ nom: m, args: a }); return demander(m, a); };
  });
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4a': 'audio/mp4',
};

const hote = (v) => process.env[v].replace(/^https?:\/\//, '').replace('localhost', '127.0.0.1');

// ---------- Le code Java de la tablette ----------

function lancerJava(dossier) {
  return new Promise((pret, echec) => {
    const attentes = new Map();
    let n = 0;
    const java = { evenements: [], ecouteurs: new Set(), sortie: '' };
    const serveur = net.createServer((sock) => {
      let reste = '';
      java.sock = sock;
      sock.setNoDelay(true);
      sock.on('data', (d) => {
        reste += d.toString('utf8');
        let i;
        while ((i = reste.indexOf('\n')) >= 0) {
          const ligne = reste.slice(0, i);
          reste = reste.slice(i + 1);
          if (!ligne.trim()) continue;
          const m = JSON.parse(ligne);
          if (m.evt === 'pret') { pret(java); continue; }
          if (m.evt) {
            const e = { nom: m.evt, data: m.data, le: Date.now() };
            java.evenements.push(e);
            java.ecouteurs.forEach((f) => f(e));
            continue;
          }
          const a = attentes.get(m.id);
          attentes.delete(m.id);
          if (a) (m.err ? a.echec(new Error(`Tablette (Java) : ${m.err}`)) : a.ok(m.res));
        }
      });
      sock.on('error', () => {});
    });
    serveur.listen(0, '127.0.0.1', () => {
      const port = serveur.address().port;
      const proc = spawn('java', [
        '-cp', PRET.classpath,
        `-Dpont.projet=${banc.PROJET}`,
        `-Dpont.firestore=${hote('FIRESTORE_EMULATOR_HOST')}`,
        `-Dpont.comptes=${hote('FIREBASE_AUTH_EMULATOR_HOST')}`,
        `-Dpont.fichiers=${hote('FIREBASE_STORAGE_EMULATOR_HOST')}`,
        ...(process.env.PAPOTE_BAVARD ? ['-Dpont.bavard=true'] : []),
        'com.papote.tablette.PontTablette', String(port), dossier,
      ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, JAVA_TOOL_OPTIONS: '' } });
      java.proc = proc;
      const noter = (d) => { java.sortie = (java.sortie + d.toString('utf8')).slice(-20000); if (process.env.PAPOTE_BAVARD) process.stderr.write(d); };
      proc.stdout.on('data', noter);
      proc.stderr.on('data', noter);
      proc.on('exit', (code) => {
        java.fini = true;
        attentes.forEach((a) => a.echec(new Error(`Tablette (Java) arrêtée (code ${code})\n${java.sortie}`)));
        echec(new Error(`Tablette (Java) arrêtée avant d'être prête (code ${code})\n${java.sortie}`));
      });
    });
    /** Pour comprendre une page figée : les demandes restées sans réponse et ce que fait chaque fil de l'appli. */
    java.figee = () => {
      const enCours = [...attentes.values()].map((a) => `${a.cmd} (${Math.round((Date.now() - a.depuis) / 1000)} s)`).join(', ') || 'aucune';
      let fils = '';
      try {
        fils = require('node:child_process').execFileSync('jstack', [String(java.proc.pid)], { encoding: 'utf8', timeout: 15_000 })
          .split('\n\n').filter((b) => /com\.papote\.tablette/.test(b)).map((b) => b.split('\n').slice(0, 14).join('\n')).join('\n\n');
      } catch (e) { fils = `(jstack : ${e.message})`; }
      return `Demandes de la page restées sans réponse : ${enCours}\nFils de l'appli :\n${fils}`;
    };
    java.commande = (cmd, ...args) => new Promise((ok, ko) => {
      if (java.fini) return ko(new Error('Tablette (Java) arrêtée'));
      n += 1;
      attentes.set(n, { ok, echec: ko, cmd, depuis: Date.now() });
      java.sock.write(`${JSON.stringify({ id: n, cmd, args })}\n`);
    });
    java.arreter = async () => {
      if (!java.fini) java.proc.kill();
      await new Promise((r) => serveur.close(r));
    };
  });
}

// ---------- La tablette entière ----------

const allumees = [];

/**
 * Allume une tablette neuve (écran Bienvenue), ou préparée à l'atelier si `tab` est donné : `tab` est la fiche
 * stock d'acteurs.tablettePreparee() ; la tablette prend son n° de série et sa clé est reliée à son vrai compte.
 * options : { tab, etat (imitation d'Android : reseau, secteur, telephone, forfait…), heure ('2026-11-12T10:00:00', heure de Paris) }
 */
async function allumer({ tab = null, etat = {}, heure = null } = {}) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-tablette-'));
  const java = await lancerJava(dossier);
  // Notée tout de suite : si la suite échoue, elle est quand même éteinte à la fin du scénario (sinon l'essai ne finit jamais).
  allumees.push({ java, dossier });
  const t = await banc.telephone('Tablette', { largeur: 1280, hauteur: 800 });
  t.java = java;
  t.dossier = dossier;
  t.evenements = java.evenements;
  t.pont = java.commande;
  t.horsLigne = false;

  if (tab) {
    await java.commande('serie', tab.serie);
    const comptes = await java.commande('compte');
    const cles = await s.db.collection('clesTablettes').where('serie', '==', tab.serie).get();
    for (const d of cles.docs) await d.ref.update({ tabletUid: comptes.uid });
    Object.assign(tab, { tabletUid: comptes.uid, callsUid: comptes.callsUid });
    t.tab = tab;
  }

  // Ce que l'appli envoie à la page (MainActivity.callPage), dans l'ordre.
  let file = Promise.resolve();
  const versPage = (e) => {
    if (e.nom === 'onRecharger' || e.nom === 'onDatabaseChanged') { file = file.then(() => t.page.reload().catch(() => {})); return; }
    if (!/^on(Status|Posts|Weather|Reminders|Family|FamilyLost)$/.test(e.nom)) return; // onNewArrival, onVolume : sons d'Android
    file = file.then(() => t.page.evaluate(([f, d]) => { if (window.Papote && window.Papote[f]) window.Papote[f](d); }, [e.nom, e.data]).catch(() => {}));
  };
  java.ecouteurs.add(versPage);

  await t.context.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__pont') {
      const { m, a } = JSON.parse(route.request().postData());
      try {
        const r = await java.commande(m, ...a);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ r: r === undefined ? null : r }) });
      } catch (e) {
        return route.fulfill({ status: 500, contentType: 'text/plain', body: String(e.message || e) });
      }
    }
    if (url.pathname.startsWith('/photos/')) {
      const f = path.join(dossier, 'files', 'photos', path.basename(decodeURIComponent(url.pathname)));
      if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ body: fs.readFileSync(f), contentType: TYPES[path.extname(f)] || 'application/octet-stream' });
    }
    const f = path.join(PRET.assets, decodeURIComponent(url.pathname));
    if (!f.startsWith(PRET.assets) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(f), contentType: TYPES[path.extname(f)] || 'application/octet-stream' });
  });
  // Sans réseau : plus rien ne sort de la page non plus (émulateurs compris).
  await t.context.route(/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/, (route) => (t.horsLigne ? route.abort('internetdisconnected') : route.fallback()));

  // Fonctions serveur appelées par la page (incident d'appel…) : en ligne elles acceptent toutes les origines ; le
  // banc de l'app ne le dit qu'à l'app. On répond ici ce que répond Google (en-têtes CORS), l'appel lui-même est réel.
  const CORS = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  await t.context.route(new RegExp(`^http://localhost:\\d+/${banc.PROJET}/[a-z0-9-]+/[A-Za-z0-9_]+$`), async (route) => {
    if (t.horsLigne) return route.abort('internetdisconnected');
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const r = await route.fetch();
    return route.fulfill({ response: r, headers: { ...r.headers(), ...CORS } });
  });

  // Chromium demande une permission avant de laisser une page https parler à l'ordinateur lui-même (les émulateurs).
  await t.context.grantPermissions(['local-network-access', 'camera', 'microphone'], { origin: ORIGIN })
    .catch(() => t.context.grantPermissions(['camera', 'microphone'], { origin: ORIGIN }));
  if (heure) await t.page.clock.install({ time: new Date(`${heure}+01:00`) });
  await t.page.addInitScript(`(${IMITATION.trim()})(${JSON.stringify(etat)}); (${brancherPonts.toString()})(${JSON.stringify(PONTS)});`);
  await java.commande('demarrer');
  // « domcontentloaded » : les scripts de la page ont tourné ; une image ou une police lente ne bloque pas l'essai.
  // Rare (3 démarrages sur 70 la nuit du 11/11, cause pas encore trouvée) : la page reste figée plus de 30 s au
  // démarrage. On note ce que faisait l'appli à ce moment-là (pour trouver la cause), puis on réessaie une fois.
  await t.page.goto(`${ORIGIN}/tablette.html`, { waitUntil: 'domcontentloaded' }).catch(async (e) => {
    console.log(`PAGE DE LA TABLETTE FIGÉE AU DÉMARRAGE (${e.message.split('\n')[0]})\n${java.figee()}`);
    await t.page.goto(`${ORIGIN}/tablette.html`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      .catch((e2) => { throw new Error(`La page de la tablette ne démarre pas (figée) : ${e2.message.split('\n')[0]}\n${java.figee()}`); });
  });

  Object.assign(t, {
    visible: (sel) => t.page.evaluate((x) => { const e = document.querySelector(x); return !!e && !e.hidden && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none'; }, sel),
    texte: (sel) => t.page.evaluate((x) => ((document.querySelector(x) || {}).textContent || '').replace(/ /g, ' '), sel),
    // Le doigt de Mamie : un vrai toucher au milieu du bouton (il doit être visible et pas recouvert).
    toucher: async (sel) => {
      const l = t.page.locator(sel).first();
      await l.waitFor({ state: 'visible', timeout: 30_000 });
      const b = await l.boundingBox();
      const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
      // Un bouton qui bat (« Décrocher ») reste touchable ; un bouton recouvert par un autre écran ne l'est pas.
      const dessus = await t.page.evaluate(([px, py, q]) => { const e = document.elementFromPoint(px, py); const but = document.querySelector(q); return e && (e === but || but.contains(e)) ? '' : (e ? e.id || String(e.className) || e.tagName : 'rien'); }, [x, y, sel]);
      if (dessus) throw new Error(`Écran de Mamie : « ${sel} » est recouvert par « ${dessus} ».`);
      await t.page.touchscreen.tap(x, y);
    },
    appels: (nom) => t.page.evaluate((x) => window.__appels.filter((a) => !x || a.nom === x), nom),
    // L'état d'Android (réseau, secteur…) survit à un redémarrage de la page, comme sur la tablette.
    etat: async (e) => {
      await t.context.addInitScript((x) => { if (window.__etat) Object.assign(window.__etat, x); }, e);
      return t.page.evaluate((x) => Object.assign(window.__etat, x), e);
    },
    /** Coupe ou rend le réseau : au code Java, à la page, et à ce qu'Android en dit (wifiStatus). */
    reseau: async (present) => {
      t.horsLigne = !present;
      await java.commande('reseau', present);
      await t.context.setOffline(!present).catch(() => {});
      await t.etat({ reseau: present ? { wifi: 'Box', internet: true, mobile: false, sim: false } : { wifi: '', internet: false, mobile: false, sim: false } }).catch(() => {});
      if (present) await java.commande('changed').catch(() => {});
    },
    /** Tablette éteinte puis rallumée (coupure de courant) : mêmes réglages, mêmes fichiers, appli et page relancées. */
    rallumer: async () => {
      await java.commande('redemarrer');
      await t.page.goto(`${ORIGIN}/tablette.html`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    },
    /** Attend un message de l'appli vers la page (onPosts, onStatus…) qui convient. */
    attendre: async (nom, convient = () => true, delai = 30_000) => {
      const debut = Date.now();
      for (;;) {
        const e = java.evenements.find((x) => x.nom === nom && !x.pris && convient(x.data));
        if (e) { e.pris = true; return e.data; }
        if (Date.now() - debut > delai) {
          throw new Error(`Tablette : « ${nom} » attendu en vain. Reçus : ${java.evenements.map((x) => x.nom).join(', ') || 'rien'}\n${(await java.commande('journal').catch(() => [])).slice(-15).join('\n')}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    /** Les derniers envois donnés à la page par l'appli. */
    envois: () => { const l = java.evenements.filter((x) => x.nom === 'onPosts'); return l.length ? l[l.length - 1].data : null; },
  });
  return t;
}

/** À la fin de chaque scénario : les tablettes s'éteignent ; une exception dans l'appli Java est une erreur. */
async function eteindreTout() {
  const erreurs = [];
  for (const t of allumees.splice(0)) {
    try {
      const plantages = await t.java.commande('plantages');
      plantages.forEach((p) => erreurs.push(`[Tablette] l'appli aurait planté : ${p}`));
    } catch (e) { erreurs.push(String(e.message || e)); }
    await t.java.arreter();
    fs.rmSync(t.dossier, { recursive: true, force: true });
  }
  return erreurs;
}

module.exports = { allumer, eteindreTout, ORIGIN, PRET };
