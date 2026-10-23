// Voix des messages sur la tablette (décidé avec Tanguy le 23/10) : chaque texte écrit par la famille est
// lu par une voix Google naturelle, créée UNE fois ici puis rejouée par la tablette autant qu'il faut.
//   Kore (femme, ou genre non renseigné) / Orus (homme), selon members/{auteur}.genre.
//   Fichier rangé par son contenu (voix + texte) dans le dossier de la famille (families/{fid}/voix/), effacé
//   avec elle : un rappel quotidien ou un même message ne se paie qu'une fois. Les annonces de prénom vont
//   dans voix-annonces/, communes à toutes les familles (lues par l'adresse à jeton, jamais listées).
//   Résultat écrit sur le document : voix = { url, texte, nom } ; la tablette le télécharge, sinon voix d'Android.
// Coût : Chirp 3 HD, 1 million de caractères gratuits par mois puis 30 $ le million (~0,09 $ par tablette
// et par mois à 50 messages de 60 caractères au-delà de la part gratuite).
const crypto = require('crypto');
const admin = require('firebase-admin');
const { BUCKET_STORAGE } = require('./base');

const VOIX = { femme: 'fr-FR-Chirp3-HD-Kore', homme: 'fr-FR-Chirp3-HD-Orus' };
const MAX = 200; // caractères lus au plus (légende 60, message 160, rappel)

function nomVoix(genre) {
  return genre === 'homme' ? VOIX.homme : VOIX.femme;
}

// fid absent : dossier commun voix-annonces/ (annonces « Prénom vous écrit : », partagées entre familles).
function cheminFichier(fid, nom, texte) {
  const h = crypto.createHash('sha1').update(nom + '|' + texte).digest('hex');
  return fid ? `families/${fid}/voix/${h}.mp3` : `voix-annonces/${h}.mp3`;
}

async function synthetiser(nom, texte) {
  const jeton = (await admin.credential.applicationDefault().getAccessToken()).access_token;
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + jeton, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text: texte },
      voice: { languageCode: 'fr-FR', name: nom },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Synthèse vocale : ' + JSON.stringify(j).slice(0, 300));
  return Buffer.from(j.audioContent, 'base64');
}

// Adresse de téléchargement Firebase (jeton), lisible par la tablette sans compte de service.
function adresse(bucket, chemin, jeton) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(chemin)}?alt=media&token=${jeton}`;
}

// Fichier son du texte (créé si besoin) : { url, nom }.
async function fichierVoix(fid, texte, genre) {
  const nom = nomVoix(genre);
  // Bucket des familles (Europe), pas celui par défaut du projet (ancien, aux États-Unis).
  const bucket = admin.storage().bucket(BUCKET_STORAGE);
  const chemin = cheminFichier(fid, nom, texte);
  const fichier = bucket.file(chemin);
  const [existe] = await fichier.exists();
  if (existe) {
    const [meta] = await fichier.getMetadata();
    const jeton = meta.metadata && meta.metadata.firebaseStorageDownloadTokens;
    if (jeton) return { url: adresse(bucket, chemin, String(jeton).split(',')[0]), nom };
  }
  const jeton = crypto.randomUUID();
  await fichier.save(await synthetiser(nom, texte), {
    contentType: 'audio/mpeg',
    metadata: { metadata: { firebaseStorageDownloadTokens: jeton } },
  });
  return { url: adresse(bucket, chemin, jeton), nom };
}

// Texte à lire pour un document (envoi ou rappel), ou '' si rien.
function texteDe(data, champ) {
  const t = typeof data[champ] === 'string' ? data[champ].trim() : '';
  return t.slice(0, MAX);
}

// Annonce dite avant le message (« Julie vous écrit : »), fichier à part : créée une seule fois par
// prénom et par voix dans un dossier commun, puis réutilisée pour tous les messages et par toutes les
// familles qui ont le même prénom (demande de Tanguy, 23/10 : chaque gain compte).
function texteAnnonce(prenom) {
  const p = typeof prenom === 'string' ? prenom.trim().slice(0, 40) : '';
  return p ? `${p} vous écrit :` : '';
}

// Ajoute (ou met à jour) data.voix sur le document si le texte a changé. db : base Firestore.
// annonce : prénom à annoncer avant le texte (messages et légendes), rien pour un rappel.
async function voixDocument(db, ref, data, champ, auteurUid, prenomAnnonce) {
  const texte = texteDe(data, champ);
  if (!texte) return null;
  const annonce = texteAnnonce(prenomAnnonce);
  // Déjà lu (et chaque écriture de la fonction ou de la tablette « vu », « bisou » redéclenche) : rien à faire,
  // sans même relire la fiche de l'auteur.
  if (data.voix && data.voix.texte === texte && (data.voix.annonceTexte || '') === annonce) return null;
  let genre = '';
  if (auteurUid) {
    const m = await db.doc(`${ref.parent.parent.path}/members/${auteurUid}`).get();
    genre = (m.exists && m.get('genre')) || '';
  }
  const fid = ref.parent.parent.id;
  const v = await fichierVoix(fid, texte, genre);
  const voix = { url: v.url, texte, nom: v.nom };
  if (annonce) {
    voix.annonce = (await fichierVoix(null, annonce, genre)).url;
    voix.annonceTexte = annonce;
  }
  await ref.update({ voix });
  return v;
}

module.exports = { nomVoix, cheminFichier, texteDe, texteAnnonce, voixDocument, fichierVoix, VOIX, MAX };
