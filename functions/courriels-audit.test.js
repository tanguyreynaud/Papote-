// Garde-fous de l'audit des e-mails du 11/11/2026 (rien n'est envoyé, rien ne sort sur internet).
//  1. Chaque e-mail de mail.js a au moins une scène dans la galerie (outils/galerie/emails.js) : sans scène, il
//     échappe à la relecture, aux captures et aux balayages Gmail / Outlook / mode sombre de la CI.
//  2. Chaque lien d'un e-mail est absolu, en https (ou mailto), vers une adresse connue ; un lien dont le texte
//     affiche un nom de domaine pointe bien vers ce domaine (sinon les boîtes y voient de l'hameçonnage).
//  3. Chaque e-mail a un objet, une version texte, et le lien du bouton est aussi dans la version texte.
//  4. Aucun e-mail client ne s'adresse à « undefined », « null », « NaN » ou « [object Object] ».
//  5. À faire (attend l'accord de Tanguy) : tout e-mail avec « Se désinscrire » porte l'en-tête List-Unsubscribe.
const test = require('node:test');
const assert = require('node:assert');
const mail = require('./mail');
const { scenes } = require('../outils/galerie/emails');

const OUTILS = ['message', 'envoyer', 'surChaqueEnvoi', 'echapper', 'euros', 'dateEnClair', 'sansBalises'];
const SCENES = scenes(mail).filter((s) => s.contenu);
const HOTES = [
  'app.mapapote.fr', 'mapapote.fr',
  'europe-west1-papote-famille.cloudfunctions.net', // désinscription, reprise de commande
  'www.mondialrelay.fr', 'panel.sendcloud.sc', // suivi du colis, étiquette de retour
  'console.cloud.google.com', // e-mail interne du coupe-circuit
];
const liens = (html) => [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
  .map((m) => ({ href: m[1].replace(/&amp;/g, '&'), texte: mail.sansBalises(m[2]) }));

test('chaque e-mail de mail.js a une scène dans la galerie', () => {
  const vus = new Set(SCENES.map((s) => s.fonction));
  const sans = Object.keys(mail).filter((k) => !OUTILS.includes(k) && typeof mail[k] === 'function' && !vus.has(k));
  assert.deepStrictEqual(sans, [], `e-mails sans scène dans outils/galerie/emails.js : ${sans.join(', ')}`);
});

test('liens : absolus, https ou mailto, vers une adresse connue, texte et cible du même domaine', () => {
  for (const s of SCENES) {
    for (const { href, texte } of liens(s.contenu.html)) {
      if (href.startsWith('mailto:')) continue;
      let u;
      assert.doesNotThrow(() => { u = new URL(href); }, `${s.titre} : lien invalide « ${href} »`);
      assert.strictEqual(u.protocol, 'https:', `${s.titre} : lien sans https « ${href} »`);
      assert.ok(HOTES.includes(u.hostname), `${s.titre} : lien vers une adresse inconnue « ${u.hostname} »`);
      const domaine = (texte.match(/\b([a-z0-9-]+\.)+(fr|com|net|org)\b/i) || [])[0];
      if (domaine) assert.ok(u.hostname === domaine.toLowerCase() || u.hostname.endsWith(`.${domaine.toLowerCase()}`), `${s.titre} : le texte « ${texte} » pointe vers ${u.hostname}`);
    }
  }
});

test('objet, version texte, et lien du bouton dans la version texte', () => {
  for (const s of SCENES) {
    const { subject, html, text } = s.contenu;
    assert.ok(subject && subject.trim().length >= 8, `${s.titre} : objet vide ou trop court`);
    assert.ok(!/[\r\n]/.test(subject), `${s.titre} : retour à la ligne dans l'objet`);
    assert.ok(text && text.length > 40, `${s.titre} : version texte absente`);
    assert.ok(!/<[a-z][^>]*>/i.test(text), `${s.titre} : balise HTML dans la version texte`);
    const bouton = (html.match(/<a href="([^"]+)" style="display:inline-block/) || [])[1];
    if (bouton) assert.ok(text.includes(bouton.replace(/&amp;/g, '&')), `${s.titre} : le lien du bouton manque dans la version texte`);
  }
});

test('aucune valeur vide affichée (undefined, null, NaN, [object Object], Invalid Date)', () => {
  for (const s of SCENES) {
    for (const partie of [s.contenu.subject, s.contenu.text]) {
      assert.doesNotMatch(partie, /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|Invalid Date/, `${s.titre} : valeur vide affichée`);
    }
  }
});

// Aujourd'hui seul l'e-mail d'information (campagne) le porte ; les relances de panier, « Être prévenu » et
// l'ouverture des commandes ont le lien « Se désinscrire » mais pas l'en-tête (bouton « Se désabonner » de Gmail).
test('tout e-mail avec « Se désinscrire » porte l\'en-tête List-Unsubscribe', { todo: 'attend l\'accord de Tanguy (audit e-mails 11/11)' }, () => {
  for (const s of SCENES.filter((x) => /Se désinscrire/.test(x.contenu.text))) {
    assert.ok(s.contenu.headers && s.contenu.headers['List-Unsubscribe'], `${s.titre} : pas d'en-tête List-Unsubscribe`);
  }
});
