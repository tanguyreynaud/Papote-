// Promesses faites aux clients (site, CGV, mentions, e-mails, chat d'aide) : elles doivent rester vraies.
// Audit « promesses » du 05/11/2026 : chaque phrase interdite ci-dessous a été trouvée fausse dans le code.
// Une phrase qui revient fait échouer ce test : corriger le texte, ou le code, avant de publier.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const mail = require('./mail');

const racine = path.join(__dirname, '..');
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8');
// Texte visible : sans balises ni espaces insécables, pour chercher des phrases.
const texte = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;| | /g, ' ').replace(/\\'/g, "'").replace(/\s+/g, ' ');

const SOURCES = {
  'vitrine/accueil.html': texte(lire('vitrine/accueil.html')),
  'vitrine/cgv.html': texte(lire('vitrine/cgv.html')),
  'vitrine/mentions.html': texte(lire('vitrine/mentions.html')),
  'vitrine/commande.html': texte(lire('vitrine/commande.html')),
  'vitrine/merci.html': texte(lire('vitrine/merci.html')),
  'functions/mail.js': texte(lire('functions/mail.js')),
  'functions/support-connaissances.md': texte(lire('functions/support-connaissances.md')),
  'functions/support.js': texte(lire('functions/support.js')),
};

// [motif, ce que fait vraiment le code]
const FAUX = [
  [/décroche(nt)? toute? seule?s?|décrochent seuls|décrochent tout seuls/i, "décroché seulement si un visage est vu 1,2 s (appels.js FACE_HOLD_MS) ou sur « Décrocher » ; jamais pour un appel téléphone (AppelGsm.java)"],
  [/23 ?h (à|-) ?7 ?h/, 'veille par défaut de 21 h à 6 h 30 (Veille.java, alertes.js VEILLE_DEFAUT, famille.js)'],
  [/(pas vue?|vu) de la matinée|depuis le matin|n'a pas été vue ce matin/i, "alerte « pas vue depuis deux jours », à 10 h, après 48 h (alertes.js PAS_VUE_MS)"],
  [/tout le monde à la fois|tous les proches à la fois/i, 'SOS par la carte SIM : un SMS à tous, puis appels un par un (tablette.js startSosTelephone)'],
  [/jusqu'à 3 ?h(eures)? en qualité réduite/i, 'forfait de 1 Go : ≈ 2 h pleine qualité puis ≈ 1 h 30 réduite (Forfait.java)'],
  [/onglet Famille/i, "pas d'onglet Famille : « Inviter » est en haut de l'accueil (web/index.html)"],
  [/Profil, puis Notifications/i, 'le réglage Notifications est dans Réglages, « Ce téléphone »'],
  [/appli Android Papote/i, "l'appli Android n'est pas publiée (famille.js PLAY_STORE_URL vide)"],
  [/touchez « Appeler »\. La tablette/i, "la tuile « Appeler » téléphone à la tablette (pas de décroché automatique) ; la visio, c'est « Appel vidéo »"],
  [/suppression immédiate dans « Vos données »/i, "« Vos données » n'a pas de bouton d'effacement"],
];

test('aucune promesse connue comme fausse ne revient', () => {
  const trouves = [];
  for (const [fichier, t] of Object.entries(SOURCES)) {
    for (const [motif, vrai] of FAUX) {
      const m = t.match(motif);
      if (m) trouves.push(`${fichier} : « ${m[0]} » (en vrai : ${vrai})`);
    }
  }
  assert.deepStrictEqual(trouves, []);
});

test('les heures de veille annoncées sont celles du code', () => {
  const src = lire('functions/alertes.js');
  const m = /VEILLE_DEFAUT = \{ de: (\d+), deMin: (\d+), a: (\d+), aMin: (\d+) \}/.exec(src);
  assert.ok(m, 'VEILLE_DEFAUT introuvable dans alertes.js');
  const h = (heure, min) => `${heure} h${Number(min) ? ` ${min}` : ''}`;
  const annonce = `${h(m[1], m[2])} à ${h(m[3], m[4])}`;
  assert.match(SOURCES['vitrine/accueil.html'], new RegExp(annonce));
  assert.match(SOURCES['functions/support-connaissances.md'], new RegExp(annonce));
});

test('l\'alerte « pas vue » annoncée a le délai du code', () => {
  const m = /PAS_VUE_MS = (\d+) \* 60 \* 60 \* 1000/.exec(lire('functions/alertes.js'));
  assert.ok(m, 'PAS_VUE_MS introuvable dans alertes.js');
  assert.strictEqual(Number(m[1]), 48, 'si le délai change, changer « deux jours » sur le site et dans le guide du chat');
  assert.match(SOURCES['vitrine/accueil.html'], /depuis deux jours/);
});

test('les CGV et les mentions disent que seules les 200 dernières photos et 40 dernières vidéos sont gardées', () => {
  for (const f of ['vitrine/cgv.html', 'vitrine/mentions.html']) {
    assert.match(SOURCES[f], /200 dernières photos et les 40 dernières vidéos/, f);
  }
});

test('e-mails rendus : bons noms de boutons de l\'appli, et la pause annonce que le SOS ne marche plus', () => {
  const fin = mail.installationFinie({ prenom: 'Julie', famille: 'Mamie Jeanne' }).text;
  assert.match(fin, /« Appel vidéo »/);
  assert.match(fin, /« Inviter », en haut de l'accueil/);
  const sansTel = mail.appelSansTelephone({ nom: 'Mamie Jeanne', sos: true, lien: 'https://x' }).text;
  assert.match(sansTel, /Réglages/);
  assert.match(sansTel, /écran d'accueil/);
  const pause = mail.papoteEnPause({ famille: 'Mamie Jeanne', lien: 'https://x' }).text;
  assert.match(pause, /SOS/);
});
