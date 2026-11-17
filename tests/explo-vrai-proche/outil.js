// Outils du testeur « vrai proche » : captures numérotées + texte de chaque écran, connexion Google (émulateur).
const fs = require('node:fs');
const path = require('node:path');
const banc = require('../app-famille/banc');
const g = require('../app-famille/gestes');
const SORTIE = process.env.SORTIE || '/mnt/project-files/audit/app-famille-vrai-proche-17-11/captures';
const MOT = (banc.WEBKIT ? 'ios' : 'and') + (process.env.PREFIXE || '');
let n = 0;
const journal = [];
fs.mkdirSync(SORTIE, { recursive: true });
async function cap(t, nom, { plein = true } = {}) {
  n += 1;
  const fichier = `${MOT}-${String(n).padStart(3, '0')}-${t.nom}-${nom}`.replace(/[^\w.-]+/g, '_') + '.png';
  await t.page.waitForTimeout(400);
  await t.page.screenshot({ path: path.join(SORTIE, fichier), fullPage: plein }).catch((e) => journal.push(`capture ratée ${fichier}: ${e.message}`));
  const vue = await g.vue(t).catch(() => '?');
  const texte = await t.page.evaluate(() => {
    const el = [...document.querySelectorAll('.dialog-back:not(.closing) .dialog, .sheet:not([hidden]), .intro-back, .guide-back')].filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed');
    const corps = document.body.innerText;
    return (el.length ? '[FENÊTRE] ' + el.map((e) => e.innerText).join(' | ') + '\n' : '') + corps;
  }).catch(() => '');
  journal.push(`\n### ${fichier} (vue ${vue}, url ${t.page.url().replace(/^https?:\/\/[^/]+/, '')})\n${texte.replace(/\n{2,}/g, '\n').slice(0, 2500)}`);
  return fichier;
}
function note(x) { journal.push(`\n>>> ${x}`); console.log(`>>> ${x}`); }
function ecrireJournal(nom) {
  fs.writeFileSync(path.join(SORTIE, `..`, `journal-${MOT}-${nom}.md`), journal.join('\n'));
}
/** Téléphone dont « Continuer avec Google » choisit le compte window.__google (fenêtre Google simulée :
 *  apis.google.com est inaccessible ici ; l'émulateur accepte un jeton Google non signé). */
async function telephone(nom, opts) {
  const t = await banc.telephone(nom, opts);
  const au = banc.hote('FIREBASE_AUTH_EMULATOR_HOST');
  const corps = `
      export * from './vrai/firebase-auth.js';
      import { getAuth as _get, initializeAuth as _init, connectAuthEmulator, signInWithCredential, linkWithCredential, GoogleAuthProvider } from './vrai/firebase-auth.js';
      const _branches = (globalThis.__papoteBranches ||= new WeakSet());
      const _brancher = (a) => { if (!_branches.has(a)) { _branches.add(a); connectAuthEmulator(a, 'http://${au.h}:${au.p}', { disableWarnings: true }); } return a; };
      export function getAuth(...a) { return _brancher(_get(...a)); }
      export function initializeAuth(...a) { return _brancher(_init(...a)); }
      const _cred = () => { const c = window.__google; if (!c) { const e = new Error('fermée'); e.code = 'auth/popup-closed-by-user'; throw e; }
        return GoogleAuthProvider.credential(JSON.stringify({ sub: c.sub, email: c.email, email_verified: true, name: c.nom })); };
      export async function signInWithPopup(auth) { await new Promise((r) => setTimeout(r, 600)); return signInWithCredential(auth, _cred()); }
      export async function linkWithPopup(user) { return linkWithCredential(user, _cred()); }`;
  await t.context.route('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }, body: corps }));
  return t;
}
/** Connexion « Continuer avec Google » par la fenêtre de l'émulateur Auth (compte choisi ou ajouté). */
async function google(t, { email, nom, sub }) {
  await t.page.evaluate((c) => { window.__google = c; }, { email, nom, sub: sub || 'g-' + email.replace(/\W/g, '') });
  await t.page.click('#btn-google');
  t.email = email;
}
async function googleEmu(t, { email, nom }) {
  const [popup] = await Promise.all([t.context.waitForEvent('page'), t.page.click('#btn-google')]);
  await popup.waitForLoadState();
  await popup.waitForTimeout(800);
  // compte déjà connu dans l'émulateur ?
  const existant = popup.locator('li', { hasText: email });
  if (await existant.count()) { await existant.first().click(); }
  else {
    await popup.locator('#add-account-button, button:has-text("Add new account")').first().click();
    await popup.waitForTimeout(400);
    if (await popup.locator('#autogen-button').count()) {
      await popup.fill('#email-input', email).catch(() => {});
      await popup.fill('#display-name-input', nom).catch(() => {});
      await popup.locator('#sign-in').click();
    }
  }
  await popup.waitForEvent('close', { timeout: 15000 }).catch(() => {});
  t.email = email;
}
module.exports = { telephone, cap, note, ecrireJournal, google, journal };
