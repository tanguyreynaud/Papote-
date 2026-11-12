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
  'vitrine/confidentialite.html': texte(lire('vitrine/confidentialite.html')),
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

// La veille de nuit est réglée par la famille (Tanguy, 05/11/2026) : le site et le chat ne citent pas d'heures.
test('la veille de nuit est annoncée sans heures fixes, réglée par la famille', () => {
  for (const f of ['vitrine/accueil.html', 'functions/support-connaissances.md']) {
    const t = SOURCES[f];
    const phrases = t.split(/(?<=[.!?])\s/).filter((p) => /veille la nuit|nuit il s'éteint|l'écran se met en veille/i.test(p));
    assert.ok(phrases.length, `${f} : la veille de nuit n'est plus expliquée`);
    for (const p of phrases) {
      assert.doesNotMatch(p, /\d+ ?h\b/, `${f} : heures fixes dans « ${p} »`);
      assert.match(p, /choisi/, `${f} : « ${p} » doit dire que la famille choisit les heures`);
    }
  }
});

test('l\'alerte « pas vue » annoncée a le délai du code', () => {
  const m = /PAS_VUE_MS = (\d+) \* 60 \* 60 \* 1000/.exec(lire('functions/alertes.js'));
  assert.ok(m, 'PAS_VUE_MS introuvable dans alertes.js');
  assert.strictEqual(Number(m[1]), 48, 'si le délai change, changer « deux jours » sur le site et dans le guide du chat');
  assert.match(SOURCES['vitrine/accueil.html'], /depuis deux jours/);
});

test('les CGV et la confidentialité disent que seules les 200 dernières photos et 40 dernières vidéos sont gardées', () => {
  for (const f of ['vitrine/cgv.html', 'vitrine/confidentialite.html']) {
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

// Audit données personnelles du 12/11 (P2, P3, P7) : la page de confidentialité doit dire ce que le code garde vraiment.
test('confidentialité : adresse du proche, empreinte de paiement, panier et prestataires déclarés', () => {
  const c = SOURCES['vitrine/confidentialite.html'];
  assert.doesNotMatch(c, /Seule la ville est gardée/, 'P2 : la rue et les coordonnées sont gardées (couverture.js metaProche, commandes.proche, paniers.requete)');
  assert.match(c, /adresse saisie .*gardés avec la commande, chez Stripe/);
  assert.match(c, /empreinte de la carte ou de l'IBAN/, 'P3 : commandes.empreinte (index.js verifierDoublon)');
  assert.match(c, /dès que vous ouvrez la page de paiement, nous notons/, 'P3 : panier noté même sans la case (index.js noterPanier)');
  for (const p of [/OVHcloud/, /Gmail/, /reCAPTCHA/, /connexion à l'appli et notifications, traitées aux États-Unis/]) assert.match(c, p, 'P7');
  assert.equal((c.match(/Vos droits/g) || []).length, 1, 'une seule partie « Vos droits »');
});

test('les pages du site renvoient vers la politique de confidentialité, plus vers mentions.html#confidentialite', () => {
  for (const f of ['vitrine/accueil.html', 'vitrine/cgv.html', 'vitrine/mentions.html', 'vitrine/chat-support.js']) {
    const s = lire(f);
    assert.match(s, /confidentialite\.html/, f);
    assert.doesNotMatch(s, /mentions\.html#confidentialite/, f);
  }
});
