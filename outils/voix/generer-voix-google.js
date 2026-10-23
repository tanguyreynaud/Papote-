// Génère les phrases fixes de la tablette avec la voix Google « Kore » (Chirp 3 HD, choisie par Tanguy
// le 23/10), une seule fois : les fichiers MP3 sont rangés dans l'app, les tablettes ne paient rien.
//   node outils/voix/generer-voix-google.js
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (synthèse vocale activée sur
// papote-famille). Les textes doivent rester identiques à ceux de bienvenue.js (sayGuide) et de
// tablette.js (MOTS) : la tablette retrouve le fichier par son texte, sinon la voix d'Android le lit.
const os = require('os');
const path = require('path');
const fs = require('fs');
const admin = require(path.join(__dirname, '..', 'admin', 'node_modules', 'firebase-admin'));

const VOIX = 'fr-FR-Chirp3-HD-Kore';
const assets = path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'assets');

const GUIDE = {
  'accueil': 'Bonjour, et bienvenue sur Papote ! Appuyez sur Commencer.',
  'wifi-choisir': 'Choisissez le wifi de votre box.',
  'wifi-ok': 'La tablette est connectée à internet. Appuyez sur Continuer.',
  'wifi-mdp': 'Tapez le mot de passe du wifi. Il est souvent écrit sous la box.',
  'code': "Dernière étape : avec votre téléphone, scannez le code affiché à l'écran.",
  'confirmer': "Quelqu'un veut relier cette tablette. C'est bien vous ?",
  'placer': 'Asseyez-vous là où la personne s’installe d’habitude, puis tournez doucement la tablette.',
};
// Mots par défaut d'une photo sans légende, dans l'ordre de MOTS (tablette.js).
const MOTS = ['Je pense fort à toi', 'Un petit coucou !', 'Gros bisous !', 'Une pensée pour toi',
  'Je t’embrasse fort', 'Plein de bisous !', 'Bonne journée !'];

(async () => {
  const cred = admin.credential.cert(require(path.join(os.homedir(), '.papote', 'cle-admin-firebase.json')));
  const jeton = (await cred.getAccessToken()).access_token;
  async function dire(texte, fichier) {
    const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + jeton, 'x-goog-user-project': 'papote-famille', 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { text: texte }, voice: { languageCode: 'fr-FR', name: VOIX }, audioConfig: { audioEncoding: 'MP3' } }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(fichier + ' : ' + JSON.stringify(j).slice(0, 300));
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    fs.writeFileSync(fichier, Buffer.from(j.audioContent, 'base64'));
    console.log(path.relative(assets, fichier));
  }
  for (const [cle, texte] of Object.entries(GUIDE)) await dire(texte, path.join(assets, 'bienvenue', 'voix', cle + '.mp3'));
  for (let i = 0; i < MOTS.length; i++) await dire(MOTS[i], path.join(assets, 'voix', 'mots', 'mot-' + i + '.mp3'));
})().catch((e) => { console.error(e.message); process.exit(1); });
