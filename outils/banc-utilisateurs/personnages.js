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
  'famille-2': [
    p('famille', 'thomas', 'video'), p('famille', 'marc', 'message'), p('famille', 'ines', 'video', { reseau: 'lent' }), p('famille', 'nadia', 'photo'),
    p('famille', 'paul', 'rappel'), p('famille', 'lea', 'appeler'), p('famille', 'sylvie', 'video'), p('famille', 'julie', 'rappel'),
    p('famille', 'marc', 'inviter'), p('famille', 'thomas', 'message'), p('famille', 'paul', 'inviter'), p('famille', 'sylvie', 'message'),
  ],
};

module.exports = { PROCHES, TACHES_FAMILLE, MAMIES, SITUATIONS, LOTS };
