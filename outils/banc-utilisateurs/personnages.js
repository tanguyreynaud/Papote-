// Personnages et tâches du banc « utilisateurs simulés ».
// Chaque parcours = un personnage + une tâche + un écran de départ (une scène de la galerie, rejouée sans ses gestes).
'use strict';

// ------------------------------------------------------------------ app famille (téléphone)
const PROCHES = {
  julie: { nom: 'Julie, 42 ans', qui: "Fille de Mamie Jeanne, infirmière de nuit, toujours pressée. Android, utilise WhatsApp tous les jours. Lit vite, en diagonale, touche le premier bouton qui ressemble à ce qu'elle cherche. Abandonne vite si c'est long." },
  thomas: { nom: 'Thomas, 38 ans', qui: "Fils de Mamie, commercial, sur iPhone, ouvre l'app entre deux rendez-vous dans la voiture (à l'arrêt). Veut que ça marche du premier coup, s'agace des écrans d'explication." },
  lea: { nom: 'Léa, 15 ans', qui: "Petite-fille. Très à l'aise avec les téléphones, ne lit jamais les textes, essaie tout, touche deux fois quand ça ne réagit pas assez vite. Trouve vite ringard ce qui est trop expliqué." },
  sylvie: { nom: 'Sylvie, 67 ans', qui: "Belle-sœur de Mamie, jeune retraitée, voit mal de près (lunettes souvent oubliées : l'écran lui paraît flou), lit lentement chaque mot. A peur de « faire une bêtise » ou de payer sans le vouloir. Ne touche rien qu'elle ne comprend pas." },
  nadia: { nom: 'Nadia, 45 ans', qui: "Belle-fille de Mamie, méfiante avec les applis : se demande qui voit ses photos, ce que ça coûte, si on va la démarcher. Lit les petites lignes, cherche les pièges." },
  marc: { nom: 'Marc, 50 ans', qui: "Gendre, malentendant appareillé, utilise le téléphone surtout par écrit. Pressé, peu patient avec les menus. Il a un vieux téléphone Android à petit écran." },
  paul: { nom: 'Paul, 74 ans', qui: "Frère de Mamie, découvre les applis, tremble un peu (il peut toucher à côté), ne connaît pas les mots « onglet », « notification », « paramètres ». Lit tout à voix haute, lentement." },
  ines: { nom: 'Inès, 31 ans', qui: "Petite-fille, vit à l'étranger, réseau souvent mauvais dans le métro. Veut envoyer vite une photo de son bébé à Mamie." },
};

// Les tâches : ce que la personne veut faire, avec ses mots à elle, et l'écran où elle commence.
const TACHES_FAMILLE = {
  photo: { depart: 'Accueil', but: "Envoyer à Mamie une photo prise hier (elle est dans la galerie du téléphone) avec un petit mot.", reussite: "La photo est envoyée (l'app dit que c'est envoyé ou la montre dans les envois)." },
  video: { depart: 'Accueil', but: "Envoyer à Mamie une courte vidéo du petit Léo déjà enregistrée dans le téléphone.", reussite: "La vidéo est envoyée." },
  message: { depart: 'Accueil', but: "Écrire à Mamie qu'on passera la voir dimanche midi.", reussite: "Le message est envoyé." },
  appeler: { depart: 'Accueil', but: "Appeler Mamie en vidéo pour lui dire bonjour.", reussite: "L'appel est lancé (ça sonne chez Mamie)." },
  rappel: { depart: 'Accueil', but: "Faire en sorte que la tablette rappelle à Mamie son rendez-vous chez le docteur Martin jeudi prochain à 10 h.", reussite: "Le rappel est enregistré dans l'agenda." },
  inviter: { depart: 'Accueil', but: "Faire venir ton frère dans la famille Papote pour qu'il puisse aussi envoyer des photos.", reussite: "Tu as un moyen de l'inviter (lien, code ou message prêt à envoyer)." },
  etat: { depart: 'Tablette qui ne répond plus (plus de 1 h 10)', but: "Tu as l'impression que la tablette de Mamie ne marche plus. Comprendre ce qui se passe et quoi faire.", reussite: "Tu sais ce qui se passe et ce que tu dois faire." },
  nuit: { depart: 'Accueil', but: "Mamie se plaint que la tablette s'allume trop tôt le matin : qu'elle reste éteinte jusqu'à 8 h.", reussite: "L'heure du réveil de la tablette est réglée à 8 h." },
  nom: { depart: 'Le nom à donner (tablette pas encore arrivée)', but: "Tu viens de commander Papote pour ta mère. Fais ce que l'app te demande.", reussite: "Le nom est donné et l'app dit que la tablette est en route." },
  reglages: { depart: 'Réglons la tablette (famille toute neuve)', but: "La tablette vient d'arriver chez Mamie. Règle-la comme il faut pour elle (elle se couche à 21 h, entend mal).", reussite: "Les réglages sont finis (écran « c'est prêt » ou retour à l'accueil)." },
  abonnement: { depart: 'Accueil', but: "Savoir combien tu paies chaque mois et où trouver tes factures.", reussite: "Tu as vu le prix ou les factures." },
  luminosite: { depart: 'Accueil', but: "Mamie trouve l'écran de sa tablette trop sombre en journée. Rends-le plus lumineux, depuis ton téléphone.", reussite: "La luminosité de jour de la tablette est augmentée et enregistrée." },
  petitsRappels: { depart: 'Accueil', but: "Ton téléphone t'envoie de temps en temps « Une photo pour Mamie ? ». Ça t'agace : arrête ces petits rappels, sur ton téléphone seulement.", reussite: "« Petits rappels » est désactivé pour ce téléphone." },
  medicament: { depart: 'Accueil', but: "Fais en sorte que la tablette rappelle à Mamie de prendre son cachet tous les matins à 8 h.", reussite: "Un rappel de médicament tous les jours à 8 h est enregistré." },
  numero: { depart: 'Accueil', but: "Ton numéro de portable a changé, c'est maintenant le 06 11 22 33 44. Mets-le à jour pour que la tablette de Mamie puisse t'appeler.", reussite: "Le nouveau numéro est enregistré dans ton profil." },
  premierLancement: { depart: 'Vos informations (premier lancement, numéro vide)', but: "Tu viens d'installer Papote. Remplis ce que l'app te demande pour commencer à l'utiliser.", reussite: "Les informations demandées sont remplies et validées, l'app passe à la suite." },
  reglerNeuve: { depart: 'Réglons la tablette (famille toute neuve)', but: "La tablette de Mamie vient d'être installée. Règle-la pour que l'écran s'éteigne la nuit et que le son ne soit pas trop fort.", reussite: "La nuit et le son sont réglés et enregistrés." },
  mamieAppelle: { depart: 'Mamie appelle', but: "Ton téléphone sonne : c'est Mamie qui t'appelle depuis sa tablette. Réponds-lui.", reussite: "L'appel est décroché." },
  dejaRepondu: { depart: 'Mamie appelle : un autre proche a déjà répondu', but: "Mamie t'appelait il y a un instant. Regarde ce qui se passe et fais ce qu'il faut.", reussite: "Tu comprends qu'un autre proche a déjà répondu à Mamie." },
  procheReglage: { depart: 'Accueil d’un proche (pas propriétaire)', but: "Mamie se plaint que la tablette s'allume trop tôt le matin. Change l'heure de réveil de l'écran.", reussite: "L'heure est changée, ou l'app explique clairement qui peut le faire." },
  enPause: { depart: 'Papote en pause (proche, pas responsable)', but: "Envoie à Mamie une photo prise hier.", reussite: "La photo est envoyée, ou l'app explique clairement pourquoi ce n'est pas possible et qui contacter." },
  invitationMail: { depart: 'Invitation reçue par e-mail', but: "Ta cousine t'a invité par e-mail dans la famille Papote de Mamie. Rejoins la famille.", reussite: "Tu as rejoint la famille ou demandé à la rejoindre." },
  quiAVu: { depart: 'Accueil', but: "Tu as envoyé une photo à Mamie ce matin. Vérifie si elle l'a vue.", reussite: "Tu sais si Mamie a vu la photo." },
  annulerCommande: { depart: 'Abonnement et paiement : annuler ma commande (14 jours)', but: "Tu as commandé Papote il y a 3 jours mais tu as changé d'avis. Annule la commande.", reussite: "La commande est annulée (ou la demande est envoyée)." },
  quitter: { depart: 'Accueil d’un proche (pas propriétaire)', but: "Tu ne veux plus faire partie de la famille Papote de Mamie. Quitte la famille.", reussite: "Tu as quitté la famille (ou confirmé que tu veux la quitter)." },
  rejoindre: { depart: 'Rejoindre ou installer', but: "Ta sœur t'a dit d'installer Papote et t'a envoyé le code ABCD2345 pour rejoindre la famille de Mamie.", reussite: "Tu as demandé à rejoindre la famille avec le code." },
};

// ------------------------------------------------------------------ tablette (écran de Mamie)
const MAMIES = {
  jeanne: { nom: 'Mamie Jeanne, 86 ans', qui: "Vit seule, toute sa tête, mais n'a jamais eu ni smartphone ni ordinateur. Voit correctement avec ses lunettes. A peur de casser la tablette. Ne connaît aucun mot d'informatique." },
  odette: { nom: 'Odette, 91 ans', qui: "Très malvoyante (DMLA) : l'écran lui paraît flou, elle ne lit que les très gros mots et reconnaît les couleurs et les visages. Touche ce qui est gros et contrasté." },
  rene: { nom: 'René, 88 ans', qui: "Malentendant (n'entend pas les sons de la tablette), ne lit plus beaucoup. Mains qui tremblent : il lui arrive de toucher à côté ou d'appuyer longtemps." },
  simone: { nom: 'Simone, 83 ans', qui: "Début de troubles de la mémoire : oublie ce qu'elle faisait il y a une minute, se méfie de ce qu'elle ne reconnaît pas, peut toucher plusieurs fois au hasard quand elle est perdue." },
  marcel: { nom: 'Marcel, 79 ans', qui: "Ancien artisan, curieux, touche à tout pour voir ce que ça fait, appuie fort et longtemps. Lit bien mais n'aime pas qu'on lui « parle comme à un enfant »." },
  lucienne: { nom: 'Lucienne, 94 ans', qui: "Ne sait plus lire (ou ne lit pas le français) : elle ne comprend que les images, les visages, les couleurs et les symboles très connus (téléphone vert/rouge). Ne lit AUCUN texte à l'écran." },
};

const SITUATIONS = {
  photo: { depart: 'Photo en largeur avec un mot', but: "La tablette vient de sonner doucement et quelque chose est apparu. Regarde et fais ce qui te semble naturel.", reussite: "La photo est vue puis l'écran revient au calme (accueil ou diaporama)." },
  message: { depart: 'Message moyen', but: "Il y a quelque chose d'écrit à l'écran. Lis-le (si tu peux) et fais ce qui te semble naturel.", reussite: "Le message est lu et refermé." },
  appelEntrant: { depart: 'Julie appelle la tablette par téléphone', but: "La tablette sonne. Tu veux parler à la personne qui appelle.", reussite: "Tu as décroché." },
  appelerJulie: { depart: 'Accueil avec photos et météo', telephones: true, but: "Tu as envie d'appeler ta fille Julie pour lui raconter ta journée.", reussite: "L'appel vers Julie est parti." },
  manque: { depart: 'Appel téléphone manqué : « Julie a appelé »', but: "Tu reviens de la cuisine et tu vois quelque chose sur la tablette.", reussite: "Tu as compris que Julie a appelé et tu l'as rappelée ou tu as refermé." },
  rappel: { depart: 'Rappel à l’heure', heure: '12:00', but: "La tablette te montre quelque chose. Fais ce qui te semble naturel.", reussite: "Tu as compris qu'il faut prendre ton cachet et tu as fermé le rappel." },
  sosErreur: { depart: 'Accueil avec photos et météo', telephones: true, but: "Tu nettoies l'écran avec la main et tu touches par erreur le bouton rouge SOS. Tu ne veux PAS déranger toute la famille : annule.", premier: { action: 'toucher_selecteur', selecteur: '#sos-btn' }, reussite: "L'alerte est annulée avant de partir." },
  perdue: { depart: 'Diaporama : photo en largeur', telephones: true, but: "Tu ne sais pas trop ce qu'il y a à l'écran. Tu voudrais revenir à « l'écran normal », avec l'heure.", reussite: "L'accueil (heure, météo) est affiché." },
  nuit: { depart: 'La nuit, un toucher rallume l’écran 2 minutes', heure: '23:30', but: "Tu te lèves la nuit et tu veux savoir l'heure sur la tablette.", reussite: "Tu as vu l'heure." },
};

// ------------------------------------------------------------------ lots
// Un parcours : { id, ecran: 'famille'|'tablette', perso, tache }.
function p(ecran, perso, tache, extra = {}) { return { id: `${ecran[0]}-${tache}-${perso}`, ecran, perso, tache, ...extra }; }

const LOTS = {
  // Essai (~0,50 $) : vérifier le coût réel et que tout s'enchaîne.
  essai: [p('famille', 'julie', 'photo'), p('famille', 'paul', 'message'), p('tablette', 'jeanne', 'photo'), p('tablette', 'lucienne', 'appelEntrant')],
  // Réglage du modèle acteur : les mêmes parcours joués par Haiku puis par Sonnet.
  reglage: [p('famille', 'sylvie', 'rappel'), p('famille', 'lea', 'video'), p('famille', 'paul', 'appeler'), p('tablette', 'odette', 'manque'), p('tablette', 'simone', 'sosErreur')],
  'famille-1': [
    p('famille', 'julie', 'video'), p('famille', 'thomas', 'photo'), p('famille', 'lea', 'message'), p('famille', 'sylvie', 'photo'),
    p('famille', 'nadia', 'abonnement'), p('famille', 'marc', 'appeler'), p('famille', 'paul', 'photo'), p('famille', 'ines', 'photo', { reseau: 'lent' }),
    p('famille', 'julie', 'nom'), p('famille', 'thomas', 'reglages'), p('famille', 'sylvie', 'inviter'), p('famille', 'paul', 'rejoindre'),
    p('famille', 'julie', 'etat'), p('famille', 'nadia', 'nuit'), p('famille', 'marc', 'rappel'), p('famille', 'lea', 'inviter'),
  ],
  'tablette-1': [
    p('tablette', 'odette', 'photo'), p('tablette', 'rene', 'appelEntrant'), p('tablette', 'simone', 'message'), p('tablette', 'marcel', 'appelerJulie'),
    p('tablette', 'lucienne', 'appelerJulie'), p('tablette', 'jeanne', 'rappel'), p('tablette', 'rene', 'sosErreur'), p('tablette', 'simone', 'perdue'),
    p('tablette', 'odette', 'nuit'), p('tablette', 'lucienne', 'manque'), p('tablette', 'marcel', 'photo'), p('tablette', 'jeanne', 'appelEntrant'),
  ],
  'tablette-2': [
    p('tablette', 'marcel', 'appelerJulie'), p('tablette', 'lucienne', 'appelerJulie'), p('tablette', 'odette', 'appelerJulie'), p('tablette', 'simone', 'appelerJulie'),
    p('tablette', 'rene', 'photo'), p('tablette', 'lucienne', 'photo'), p('tablette', 'odette', 'message'), p('tablette', 'marcel', 'rappel'),
    p('tablette', 'simone', 'manque'), p('tablette', 'jeanne', 'perdue'), p('tablette', 'lucienne', 'sosErreur'), p('tablette', 'marcel', 'nuit'),
  ],
  // Preuve des corrections du 19/11 : les parcours qui avaient trouvé les défauts corrigés, rejoués sur les branches de corrections.
  preuve: [
    p('famille', 'thomas', 'reglages'), p('famille', 'julie', 'etat'), p('famille', 'paul', 'rejoindre'), p('famille', 'julie', 'video'),
    p('famille', 'thomas', 'photo'), p('famille', 'lea', 'inviter'), p('famille', 'nadia', 'nuit'),
    p('tablette', 'rene', 'sosErreur'), p('tablette', 'rene', 'appelEntrant'), p('tablette', 'odette', 'photo'),
  ],
  // Nuit du 19/11 : combinaisons pas encore jouées, sur les branches de corrections.
  'famille-3': [
    p('famille', 'ines', 'rappel'), p('famille', 'marc', 'photo'), p('famille', 'nadia', 'video'), p('famille', 'lea', 'photo'),
    p('famille', 'julie', 'message'), p('famille', 'thomas', 'appeler'), p('famille', 'paul', 'nom'), p('famille', 'sylvie', 'etat'),
    p('famille', 'ines', 'inviter', { reseau: 'lent' }), p('famille', 'marc', 'reglages'), p('famille', 'lea', 'nuit'), p('famille', 'nadia', 'rejoindre'),
  ],
  'tablette-3': [
    p('tablette', 'jeanne', 'message'), p('tablette', 'odette', 'rappel'), p('tablette', 'rene', 'manque'), p('tablette', 'simone', 'photo'),
    p('tablette', 'marcel', 'sosErreur'), p('tablette', 'lucienne', 'nuit'), p('tablette', 'jeanne', 'sosErreur'), p('tablette', 'odette', 'perdue'),
    p('tablette', 'rene', 'message'), p('tablette', 'simone', 'rappel'), p('tablette', 'marcel', 'appelEntrant'), p('tablette', 'lucienne', 'message'),
  ],
  // Lot 4 : seulement des combinaisons jamais jouées, loin des problèmes déjà notés (nuit, hors ligne, vidéo depuis l'accueil).
  'famille-4': [
    p('famille', 'lea', 'abonnement'), p('famille', 'sylvie', 'abonnement'), p('famille', 'marc', 'abonnement'), p('famille', 'ines', 'appeler'),
    p('famille', 'nadia', 'appeler'), p('famille', 'sylvie', 'nom'), p('famille', 'ines', 'nom'), p('famille', 'nadia', 'message'),
    p('famille', 'ines', 'message'), p('famille', 'thomas', 'rappel'), p('famille', 'lea', 'rappel'), p('famille', 'nadia', 'inviter'),
  ],
  'tablette-4': [
    p('tablette', 'jeanne', 'nuit'), p('tablette', 'jeanne', 'appelerJulie'), p('tablette', 'odette', 'appelEntrant'), p('tablette', 'odette', 'sosErreur'),
    p('tablette', 'rene', 'appelerJulie'), p('tablette', 'rene', 'rappel'), p('tablette', 'rene', 'perdue'), p('tablette', 'simone', 'appelEntrant'),
    p('tablette', 'simone', 'nuit'), p('tablette', 'marcel', 'message'), p('tablette', 'marcel', 'perdue'), p('tablette', 'lucienne', 'rappel'),
  ],
  // Après publication du lot (Tanguy, 20/11) : vérifier les corrections en vrai code publié, sans rejouer les
  // problèmes déjà notés. ~12 parcours, ~0,50 $. Sources : BANC_REF_FAMILLE=origin/main ou la branche publiée.
  'apres-publication': [
    p('famille', 'thomas', 'reglages'), p('famille', 'paul', 'photo'), p('famille', 'sylvie', 'etat'), p('famille', 'ines', 'rejoindre'),
    p('famille', 'marc', 'video'), p('famille', 'lea', 'inviter'), p('famille', 'nadia', 'nom'),
    p('tablette', 'rene', 'appelEntrant'), p('tablette', 'simone', 'sosErreur'), p('tablette', 'marcel', 'appelerJulie'),
    p('tablette', 'odette', 'photo'), p('tablette', 'lucienne', 'appelEntrant'),
  ],
  'apres-lot-e': [
    p('famille', 'julie', 'luminosite'), p('famille', 'sylvie', 'luminosite'), p('famille', 'marc', 'petitsRappels'), p('famille', 'thomas', 'petitsRappels'),
    p('famille', 'lea', 'medicament'), p('famille', 'nadia', 'medicament'), p('famille', 'ines', 'numero'), p('famille', 'paul', 'numero'),
    p('tablette', 'jeanne', 'appelEntrant'), p('tablette', 'marcel', 'appelEntrant'), p('tablette', 'odette', 'manque'), p('tablette', 'simone', 'rappel'),
  ],
  'famille-2': [
    p('famille', 'thomas', 'video'), p('famille', 'marc', 'message'), p('famille', 'ines', 'video', { reseau: 'lent' }), p('famille', 'nadia', 'photo'),
    p('famille', 'paul', 'rappel'), p('famille', 'lea', 'appeler'), p('famille', 'sylvie', 'video'), p('famille', 'julie', 'rappel'),
    p('famille', 'marc', 'inviter'), p('famille', 'thomas', 'message'), p('famille', 'paul', 'inviter'), p('famille', 'sylvie', 'message'),
  ],
};

// Grand tour (Tanguy, 20/11, 25 $) — étape 1 : chaque tâche de l'app par 5 proches différents (tournant), chaque
// situation de la tablette par les 6 Mamies. Joué sur la version publiée.
{
  const proches = Object.keys(PROCHES);
  const t1 = [];
  Object.keys(TACHES_FAMILLE).forEach((tache, i) => { for (let k = 0; k < 5; k++) t1.push(p('famille', proches[(i * 3 + k) % proches.length], tache)); });
  Object.keys(SITUATIONS).forEach((sit) => { for (const m of Object.keys(MAMIES)) t1.push(p('tablette', m, sit)); });
  LOTS['tour-1'] = t1;
}

// Étape 1 rejouée téléphone debout (bug du banc du 21/11 : 61 parcours famille sur 80 partaient couchés), sans « nom »
// ni « rejoindre », qui butent sur le faux serveur (nom non enregistré, code non vérifié).
LOTS['tour-1-debout'] = LOTS['tour-1'].filter((x) => ["f-abonnement-ines", "f-abonnement-julie", "f-abonnement-lea", "f-abonnement-paul", "f-abonnement-thomas", "f-appeler-marc", "f-etat-lea", "f-etat-marc", "f-etat-nadia", "f-etat-paul", "f-etat-sylvie", "f-inviter-ines", "f-inviter-julie", "f-inviter-lea", "f-inviter-sylvie", "f-inviter-thomas", "f-luminosite-lea", "f-luminosite-marc", "f-luminosite-nadia", "f-luminosite-sylvie", "f-luminosite-thomas", "f-medicament-ines", "f-medicament-julie", "f-medicament-lea", "f-medicament-sylvie", "f-medicament-thomas", "f-nuit-ines", "f-nuit-julie", "f-nuit-marc", "f-nuit-paul", "f-nuit-thomas", "f-numero-lea", "f-numero-marc", "f-numero-nadia", "f-numero-paul", "f-numero-sylvie", "f-petitsRappels-ines", "f-petitsRappels-julie", "f-petitsRappels-marc", "f-petitsRappels-nadia", "f-petitsRappels-paul", "f-rappel-ines", "f-rappel-julie", "f-rappel-marc", "f-rappel-nadia", "f-rappel-paul", "f-reglages-ines", "f-reglages-marc", "f-reglages-nadia", "f-reglages-paul", "f-reglages-sylvie"].includes(x.id));

// Étape 2 du grand tour : cas difficiles, sur les tâches les plus courantes. Petit téléphone Android (360 × 640),
// mode sombre, réseau lent, téléphone couché dès le départ ; tablette la nuit et par des Mamies peu à l'aise.
{
  const PETIT = { dimensions: { width: 360, height: 640 } };
  const t2 = [];
  const courantes = ['photo', 'video', 'message', 'appeler', 'rappel', 'medicament', 'inviter', 'etat', 'nuit', 'luminosite', 'numero', 'abonnement'];
  const proches = Object.keys(PROCHES);
  courantes.forEach((tache, i) => {
    t2.push(p('famille', proches[i % 8], tache, PETIT));
    t2.push(p('famille', proches[(i + 3) % 8], tache, { sombre: true }));
    t2.push(p('famille', proches[(i + 5) % 8], tache, { reseau: 'lent' }));
  });
  ['photo', 'video', 'message', 'appeler', 'rappel', 'etat'].forEach((tache, i) => t2.push(p('famille', proches[(i + 2) % 8], tache, { couche: true })));
  // Identifiants uniques : la variante dans l'id.
  t2.forEach((x) => { x.id += x.dimensions ? '-petit' : x.sombre ? '-sombre' : x.reseau ? '-lent' : x.couche ? '-couche' : ''; });
  LOTS['tour-2'] = t2;
}

// Étape 3 du grand tour : ce qui n'avait jamais été testé (premier lancement, réglage d'une famille neuve, appel de
// Mamie vers l'app, proche non responsable, pause, invitation, « a-t-elle vu ? », annulation, quitter).
{
  const proches = Object.keys(PROCHES);
  const t3 = [];
  ['premierLancement', 'reglerNeuve', 'mamieAppelle', 'dejaRepondu', 'procheReglage', 'enPause', 'invitationMail', 'quiAVu', 'annulerCommande', 'quitter']
    .forEach((tache, i) => { for (let k = 0; k < 5; k++) t3.push(p('famille', proches[(i * 3 + k) % 8], tache)); });
  LOTS['tour-3'] = t3;
}

// Étape 4a : preuves sur le lot h publié (date du rappel en lettres, fenêtres petit écran, luminosité, assistant).
LOTS['preuve-lot-h'] = [
  p('famille', 'marc', 'rappel'), p('famille', 'paul', 'rappel'), p('famille', 'nadia', 'rappel'), p('famille', 'sylvie', 'rappel'),
  p('famille', 'julie', 'medicament', { dimensions: { width: 360, height: 640 } }), p('famille', 'thomas', 'medicament'),
  p('famille', 'marc', 'luminosite', { dimensions: { width: 360, height: 640 } }), p('famille', 'sylvie', 'luminosite'),
  p('famille', 'sylvie', 'etat', { dimensions: { width: 360, height: 640 } }), p('famille', 'nadia', 'etat'),
  p('famille', 'julie', 'abonnement'), p('famille', 'ines', 'abonnement'),
].map((x) => ({ ...x, id: x.id + (x.dimensions ? '-petit' : '') }));

// Étape 4b : vérification finale du lot i (A1 abonnement, P1 pause, P3 volumes, P4 « Que faire ? » à distance,
// T1 appel manqué, T2 « C'est fait ») ; médicament en 360 × 640 rejoué pour voir si l'Agenda sous le pli revient.
{
  const PETIT = { dimensions: { width: 360, height: 640 } };
  LOTS['preuve-lot-i'] = [
    p('famille', 'julie', 'abonnement'), p('famille', 'ines', 'abonnement'), p('famille', 'thomas', 'abonnement'), p('famille', 'nadia', 'abonnement'),
    p('famille', 'julie', 'annulerCommande'), p('famille', 'thomas', 'annulerCommande'), p('famille', 'lea', 'annulerCommande'),
    p('famille', 'ines', 'enPause'), p('famille', 'julie', 'enPause'), p('famille', 'thomas', 'enPause'),
    p('famille', 'sylvie', 'reglerNeuve'), p('famille', 'ines', 'reglerNeuve'),
    p('famille', 'ines', 'etat'), p('famille', 'lea', 'etat'),
    p('famille', 'nadia', 'quitter'), p('famille', 'ines', 'quitter'),
    p('famille', 'paul', 'medicament', PETIT), p('famille', 'marc', 'medicament', PETIT), p('famille', 'lea', 'rappel', PETIT),
    p('tablette', 'rene', 'manque'), p('tablette', 'lucienne', 'manque'), p('tablette', 'odette', 'manque'),
    p('tablette', 'simone', 'rappel'), p('tablette', 'lucienne', 'rappel'),
  ].map((x) => ({ ...x, id: x.id + (x.dimensions ? '-petit' : '') }));
}

// Tour final (21/11 soir) : tout l'étape 1 sur la version finale, sans « nom » ni « rejoindre » (faux serveur).
LOTS['tour-final'] = LOTS['tour-1'].filter((x) => x.tache !== 'nom' && x.tache !== 'rejoindre');

// Fin du soir (21/11) : chaque tâche de l'app dans les 4 cas difficiles, personnages tournants ; puis la tablette.
{
  const proches = Object.keys(PROCHES);
  const VAR = [['petit', { dimensions: { width: 360, height: 640 } }], ['sombre', { sombre: true }], ['lent', { reseau: 'lent' }], ['couche', { couche: true }]];
  const taches = Object.keys(TACHES_FAMILLE).filter((t) => !['nom', 'rejoindre', 'mamieAppelle'].includes(t));
  const l = [];
  taches.forEach((t, i) => VAR.forEach(([nom, o], k) => l.push({ ...p('famille', proches[(i + k * 2 + 1) % 8], t, o), id: `f-${t}-${proches[(i + k * 2 + 1) % 8]}-${nom}` })));
  Object.keys(SITUATIONS).forEach((sit) => { for (const m of Object.keys(MAMIES)) l.push(p('tablette', m, sit)); });
  LOTS['soir-rares'] = l;
}

module.exports = { PROCHES, TACHES_FAMILLE, MAMIES, SITUATIONS, LOTS };

// Derniers crédits (21/11, 23 h 30) : ce qui compte le plus (envoyer, débloquer hors ligne) + T1/T2 tablette.
{
  const proches = Object.keys(PROCHES);
  const VAR = [['', {}], ['petit', { dimensions: { width: 360, height: 640 } }]];
  const l = [];
  ['photo', 'video', 'rappel', 'medicament', 'etat'].forEach((t, i) => { for (let k = 0; k < 7; k++) { const [nom, o] = VAR[k % 2]; const pr = proches[(i + k * 3) % 8]; l.push({ ...p('famille', pr, t, o), id: `f-${t}-${pr}${nom ? '-' + nom : ''}` }); } });
  for (const m of Object.keys(MAMIES)) l.push(p('tablette', m, 'manque'));
  for (const m of Object.keys(MAMIES)) l.push(p('tablette', m, 'rappel'));
  LOTS['derniers-credits'] = l;
}
module.exports = { PROCHES, TACHES_FAMILLE, MAMIES, SITUATIONS, LOTS };
