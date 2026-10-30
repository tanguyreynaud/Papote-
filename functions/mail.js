// E-mails envoyés aux clients (colis parti, rappels de jumelage), par SMTP.
// Gmail au départ (mot de passe d'application) ; Brevo plus tard en changeant MAIL_SMTP dans .env.
// Mot de passe dans Secret Manager (MAIL_MOT_DE_PASSE), jamais dans le dépôt.

const APPLI = 'https://app.mapapote.fr';
// Lien vers l'appli qui garde le code de commande : la famille créée s'y rattache toute seule.
const lienAppli = (code) => (code ? `${APPLI}/?commande=${encodeURIComponent(code)}` : APPLI);

function echapper(t) {
  return String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Espaces insécables avant : ; ! ? € % » et après « (le texte seul, pas les balises) :
// « 20 € » ou « limite : 25 novembre » ne se coupent plus en fin de ligne.
const insecables = (h) => h.split(/(<[^>]*>)/).map((m) => (m.startsWith('<') ? m
  : m.replace(/ ([:;!?€%»])/g, '&nbsp;$1').replace(/« /g, '«&nbsp;'))).join('');

// Mise en page commune, aux couleurs du site.
// options.pied : petite ligne sous le bouton (désinscription) ; options.interne : e-mail pour Papote, sans « Une question ? ».
function page(titre, paragraphes, bouton, options = {}) {
  const corps = paragraphes.map((p) => `<p style="margin:0 0 16px">${insecables(p)}</p>`).join('');
  const btn = bouton
    ? `<p style="margin:24px 0"><a href="${echapper(bouton.lien)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:999px">${echapper(bouton.texte)}</a></p>`
    : '';
  const question = options.interne ? '' : '<p style="margin:32px 0 0;font-size:14px;color:#5f5a6b">Une question&nbsp;? Répondez simplement à cet e-mail.</p>';
  const pied = options.pied ? `<p style="margin:24px 0 0;font-size:13px;color:#5f5a6b">${options.pied}</p>` : '';
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#fdfaf5;color:#24212f;font:17px/1.6 Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
<p style="margin:0 0 24px;font-weight:bold;font-size:20px;color:#4f46e5">Papote</p>
<h1 style="margin:0 0 20px;font-size:26px;line-height:1.2">${insecables(echapper(titre))}</h1>
${corps}${btn}${question}${pied}
</div></body></html>`;
}

function texteBrut(titre, paragraphes, bouton, options = {}) {
  const sansBalises = (h) => h.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  return [titre, '', ...paragraphes.map(sansBalises), bouton ? `${bouton.texte} : ${bouton.lien}` : '', '',
    ...(options.interne ? [] : ['Une question ? Répondez simplement à cet e-mail.']),
    ...(options.pied ? ['', sansBalises(options.pied)] : [])].join('\n');
}

function message(titre, paragraphes, bouton, options) {
  return { subject: titre, html: page(titre, paragraphes, bouton, options), text: texteBrut(titre, paragraphes, bouton, options) };
}

function relaisEnTexte(r) {
  if (!r) return '';
  return [r.nom, r.adresse, [r.cp, r.ville].filter(Boolean).join(' ')].filter(Boolean).map(echapper).join(', ');
}

function colisParti({ nom, suivi, lien, relais, code }) {
  return message('Votre tablette Papote est en route', [
    `Bonjour${nom ? ` ${echapper(nom)}` : ''},`,
    `Votre tablette vient de partir. Vous recevrez un message de Mondial Relay dès qu'elle sera disponible${relais ? ` au point relais <b>${relaisEnTexte(relais)}</b>` : ' au point relais choisi'}.`,
    `Numéro de suivi : <b>${echapper(suivi)}</b>.`,
    `À son arrivée : branchez la tablette et allumez-la, puis <a href="${echapper(lienAppli(code))}" style="color:#4f46e5">ouvrez l'appli Papote</a> sur votre téléphone et scannez le code affiché sur la tablette. L'appli vous guide ensuite pas à pas.`,
  ].filter(Boolean), { texte: 'Suivre mon colis', lien });
}

// Tablette remise en main propre par Tanguy (A1) : pas de colis à suivre, elle est déjà chez le client.
function tabletteRemise({ nom, code }) {
  return message('Votre tablette Papote est chez vous', [
    `Bonjour${nom ? ` ${echapper(nom)}` : ''},`,
    'Votre tablette Papote vous a été remise en main propre : elle est prête.',
    `Branchez la tablette et allumez-la, puis <a href="${echapper(lienAppli(code))}" style="color:#4f46e5">ouvrez l'appli Papote</a> sur votre téléphone et scannez le code affiché sur la tablette. L'appli vous guide ensuite pas à pas.`,
    // Plus de « 30 jours pour changer d'avis » (Tanguy, 2026-10-29) : même règle que l'e-mail de commande, les CGV couvrent le droit.
  ], { texte: 'Ouvrir l\'appli Papote', lien: lienAppli(code) });
}

// Offre unique depuis le 29/10/2026 (Tanguy) : un seul prix, carte SIM toujours fournie.
const OFFRE = '25 € par mois, tout compris (carte SIM incluse)';

// Un seul délai annoncé, quel que soit le stock (Tanguy, 29/10/2026 : « expédié sous 3 à 5 jours ouvrés ») :
// Tanguy tient le stock de tablettes et de cartes SIM pour le respecter.
const DELAI = 'Je prépare et vérifie votre tablette moi-même, avec sa carte SIM : elle est expédiée sous 3 à 5 jours ouvrés';

// reprise : abonnement repris après une résiliation, tablette restée chez le proche (C3) : pas de mise en service,
// pas de délai pour changer d'avis.
function commandeConfirmee({ nom, code, relais, formule, dejaInstallee, reprise }) {
  // Offre unique (29/10/2026) : la formule n'est plus lue, les anciennes commandes Wi-Fi n'étaient que des essais.
  const mensuel = OFFRE;
  // Abonnement pris dans l'appli, tablette déjà installée : ni envoi ni installation à annoncer.
  if (dejaInstallee) {
    return message(reprise ? 'Votre abonnement Papote reprend' : 'Merci pour votre abonnement Papote', [
      `Bonjour${nom ? ` ${echapper(nom)}` : ''},`,
      `Merci, votre abonnement Papote ${reprise ? 'reprend' : 'est pris'} !${code ? ` Son numéro : <b>${echapper(code)}</b>.` : ''} La tablette fonctionne déjà, il n'y a rien d'autre à faire.`,
      reprise
        ? `Votre abonnement : ${mensuel}, payés une fois chaque mois écoulé, sans engagement. Rien n'est réglé aujourd'hui : le premier mois est prélevé dans 30 jours.`
        : `Réglé aujourd'hui : 60 € de mise en service. Votre abonnement : ${mensuel}, payés une fois chaque mois écoulé, sans engagement. Le premier mois est prélevé dans 30 jours. D'ici là, vous pouvez changer d'avis : rien à payer et les 60 € remboursés.`,
    ], { texte: 'Ouvrir l\'appli Papote', lien: APPLI });
  }
  return message('Merci pour votre commande Papote', [
    `Bonjour${nom ? ` ${echapper(nom)}` : ''},`,
    `Merci pour votre commande !${code ? ` Son numéro : <b>${echapper(code)}</b>.` : ''}`,
    // Plus de « vous pouvez annuler à tout moment avant » (Tanguy, 2026-10-27, A2) : les CGV couvrent le droit,
    // l'e-mail n'invite pas à reculer. « Une question ? Répondez à cet e-mail » reste en pied.
    `${DELAI}. Vous recevrez un e-mail dès qu'elle part.`,
    relais && relais.transporteur
      ? `Livraison offerte au point relais <b>${relaisEnTexte(relais)}</b>${relais.destinataire ? `, à retirer par <b>${echapper(relais.destinataire)}</b>` : ''}.`
      : 'Livraison offerte à l\'adresse indiquée.',
    '<b>En attendant, installez l\'appli Papote sur votre téléphone</b> avec le bouton ci-dessous. Vous n\'avez pas encore de code, c\'est normal : il s\'affichera sur l\'écran de la tablette quand vous l\'allumerez. Vous le scannerez avec votre téléphone, et l\'appli vous guidera.',
    `Réglé aujourd'hui : 60 € de mise en service. Votre abonnement : ${mensuel}, payés une fois chaque mois écoulé à partir de la réception, sans engagement. Vous avez 30 jours après la réception pour changer d'avis : rien à payer et les 60 € remboursés. La tablette est prêtée et configurée.`,
  ].filter(Boolean), { texte: 'Installer l\'appli Papote', lien: APPLI });
}

// Prévient Papote qu'une tablette est à préparer.
// Panier abandonné (functions/relances.js) : etape 1 (une heure après), 2 (lendemain soir), 3 (une semaine après).
function relancePanier({ etape = 1, nom, formule, lien, desinscription }) {
  const prix = OFFRE;
  const textes = {
    1: ['Votre commande Papote vous attend', [
      'Vous avez commencé une commande Papote sans la terminer. Elle est gardée de côté : vous pouvez la reprendre en un clic, avec le même point relais.',
      `Pour rappel : 60 € de mise en service à la commande, puis ${prix}, sans engagement, livraison offerte, et 30 jours pour changer d'avis. La tablette est prêtée et déjà configurée.`,
    ]],
    2: ['Une question avant de vous décider ?', [
      'Vous avez regardé Papote hier. Si quelque chose vous fait hésiter, répondez simplement à cet e-mail : nous vous répondons personnellement.',
      'La tablette arrive prête à brancher, votre proche n\'a rien à manipuler, et vous avez 30 jours après la réception pour changer d\'avis : rien à payer et les 60 € remboursés.',
    ]],
    3: ['Dernier rappel pour votre commande Papote', [
      'Votre commande Papote est toujours prête. C\'est notre dernier rappel : nous ne vous écrirons plus à ce sujet.',
      `Livraison offerte, 60 € de mise en service puis ${prix}, sans engagement, 30 jours pour changer d'avis, sans rien à installer pour votre proche.`,
    ]],
  };
  const [titre, corps] = textes[etape] || textes[1];
  return message(titre, [
    bonjour(nom),
    ...corps,
  ].filter(Boolean), { texte: 'Reprendre ma commande', lien }, {
    pied: desinscription ? `Vous recevez cet e-mail car vous avez accepté les nouvelles de Papote. <a href="${echapper(desinscription)}" style="color:#5f5a6b">Se désinscrire</a>.` : '',
  });
}

// Ouverture des commandes, pour la liste d'attente du site (lancementListeAttente).
function lancement({ prenom, desinscription }) {
  return message('Papote est disponible : vous pouvez commander', [
    bonjour(prenom),
    'Vous nous aviez demandé de vous prévenir : c\'est le moment, les commandes Papote sont ouvertes.',
    'La tablette arrive prête à brancher, en point relais près de chez vous ou de chez votre proche. Votre proche n\'a rien à régler : c\'est la famille qui envoie les photos et qui appelle, la tablette décroche toute seule.',
    `60 € de mise en service à la commande, puis ${OFFRE}, sans engagement. 30 jours pour changer d\'avis, livraison offerte, tablette prêtée.`,
    'Nous préparons les tablettes par petits lots : les premières commandes partent en premier.',
  ].filter(Boolean), { texte: 'Commander ma tablette', lien: 'https://mapapote.fr/commande.html' }, {
    pied: desinscription ? `Vous recevez cet e-mail car vous vous êtes inscrit à la liste d'attente de Papote. <a href="${echapper(desinscription)}" style="color:#5f5a6b">Se désinscrire</a>.` : '',
  });
}

function nouvelleCommande({ nom, email, telephone, code, relais, proche, formule, delai, dejaInstallee, reprise }) {
  const client = `Client : <b>${echapper(nom || '?')}</b>, ${echapper(email || 'sans e-mail')}${telephone ? `, ${echapper(telephone)}` : ''}.`;
  const offre = `Offre : ${OFFRE}.${dejaInstallee ? '' : ' Ligne SIM à ouvrir pour cette commande.'}`;
  if (dejaInstallee) {
    return message(`${reprise ? 'Abonnement repris' : 'Nouvel abonnement'} ${code || ''}`.trim(), [client, offre,
      reprise
        ? 'Abonnement repris après une résiliation, tablette restée chez le proche : rien à envoyer, pas de mise en service. Premier prélèvement dans 30 jours.'
        : 'Pris dans l\'appli, tablette déjà installée chez le proche : rien à envoyer. Premier prélèvement dans 30 jours.'], null, { interne: true });
  }
  return message(`Nouvelle commande ${code || ''}`.trim(), [
    client,
    offre,
    relais && relais.transporteur
      ? `Point relais : <b>${relaisEnTexte(relais)}</b> (n° ${echapper(relais.id)}). Retrait par : <b>${echapper(relais.destinataire || nom || '?')}</b>.`
      : `Livraison : ${relaisEnTexte(relais) || 'adresse non trouvée, voir Stripe'}.`,
    proche ? `Chez le proche : <b>${echapper(proche.adresse)}</b>, 4G Bouygues ${/^commune:/.test(proche.couverture4g || '')
      ? `bonne ou très bonne sur ${echapper(proche.couverture4g.slice(8))} % de la commune (adresse exacte inconnue)`
      : { TBC: 'très bonne', BC: 'bonne', CL: 'limitée' }[proche.couverture4g] || 'inconnue'} (carte ARCEP).` : null,
    `Stock : ${{ stock: 'tablette en stock', precommande: 'plus de tablette en stock, à préparer vite (expédition promise sous 3 à 5 jours ouvrés)', long: 'plus de 10 commandes au-delà du stock, à préparer vite (expédition promise sous 3 à 5 jours ouvrés)' }[delai] || 'tablette en stock'}.`,
    'Tablette à préparer, puis à marquer « envoyée » dans le tableau de bord.',
  ].filter(Boolean), null, { interne: true });
}

function rappelJumelage({ nom, numero, code }) {
  const titre = numero === 1 ? 'Votre tablette Papote vous attend' : 'Besoin d\'un coup de main avec Papote ?';
  return message(titre, [
    `Bonjour${nom ? ` ${echapper(nom)}` : ''},`,
    numero === 1
      ? 'Votre tablette Papote devrait être arrivée au point relais, mais elle n\'est pas encore reliée à votre famille. Cela prend deux minutes :'
      : 'Votre tablette Papote n\'est toujours pas reliée à votre famille. Si quelque chose bloque, répondez à cet e-mail : nous vous aidons.',
    '1. Branchez la tablette et allumez-la.<br>2. Ouvrez l\'appli Papote sur votre téléphone.<br>3. Scannez le code affiché sur la tablette : l\'appli vous guide ensuite.',
  ].filter(Boolean), { texte: 'Ouvrir l\'appli Papote', lien: lienAppli(code) });
}

// ---------- Fin de contrat et retour de la tablette ----------

function dateEnClair(ms) {
  return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
}

function euros(centimes) {
  const e = centimes / 100;
  return `${Number.isInteger(e) ? e : e.toFixed(2).replace('.', ',')} €`;
}

const bonjour = (nom) => `Bonjour${nom ? ` ${echapper(nom)}` : ''},`;
const CARTON = 'Mettez la tablette, son support, son chargeur et son câble (et l\'enceinte si vous l\'avez reçue) dans un carton';
const COMMENT_RENDRE = `${CARTON}, collez l'étiquette dessus et déposez le colis dans n'importe quel point relais Mondial Relay. Inutile de l'effacer : nous nous en chargeons.`;
const COMMENT_RENDRE_QR = `${CARTON} et déposez-le dans n'importe quel point relais Mondial Relay en montrant ce QR code (sur votre téléphone, pas besoin d'imprimer). Inutile d'effacer la tablette : nous nous en chargeons.`;
// Où demander le QR code de retour : dans l'appli, au moment de déposer le colis (renvoyerTablette).
const DEMANDER_QR = 'Quand le colis est prêt, ouvrez l\'appli Papote, onglet Profil, et touchez « Je renvoie la tablette » : un QR code prépayé s\'affiche, à montrer au point relais Mondial Relay. Pas besoin d\'imprimer, et vous n\'avez rien à payer.';
const APPLI_RETOUR = { texte: 'Ouvrir l\'appli Papote', lien: `${APPLI}/?abonnement=1` };

// Abonnement terminé ou commande annulée après l'envoi : la tablette prêtée est attendue.
// retractation : montant remboursé au retour (centimes), sinon null.
function retourTablette({ nom, avant, retractation, montant }) {
  return message('Comment nous rendre la tablette Papote', [
    bonjour(nom),
    retractation != null
      ? 'Votre commande est bien annulée. Il reste à nous renvoyer la tablette.'
      : 'Votre abonnement Papote est terminé. Merci de nous avoir fait confiance ! La tablette est prêtée : il reste à nous la renvoyer.',
    DEMANDER_QR,
    `${CARTON}. Inutile de l'effacer : nous nous en chargeons. Date limite : <b>${dateEnClair(avant)}</b>.`,
    retractation != null && retractation > 0
      ? `Dès que la tablette nous parvient, nous vous remboursons <b>${euros(retractation)}</b> sur votre compte.`
      : `Sans retour à cette date, ${euros(montant)} seront prélevés sur votre compte. Chaque élément manquant est facturé : tablette 130 €, chargeur et câble 10 €, enceinte 10 € si elle était dans le colis.`,
  ], APPLI_RETOUR);
}

// Arrêt demandé (par le client dans l'appli, ou par Papote depuis l'admin) : confirmation écrite, avec la date
// d'arrêt et la suite (la loi demande de confirmer une résiliation sur un support durable).
function resiliationEnregistree({ nom, famille, le, tablettePretee, parPapote }) {
  return message(parPapote ? 'Papote arrête votre abonnement' : 'Votre résiliation Papote est enregistrée', [
    bonjour(nom),
    parPapote
      ? `Nous arrêtons l'abonnement Papote${famille ? ` de <b>${echapper(famille)}</b>` : ''}.`
      : `Votre demande de résiliation de l'abonnement Papote${famille ? ` de <b>${echapper(famille)}</b>` : ''} est bien enregistrée.`,
    `Tout continue de fonctionner jusqu'au <b>${dateEnClair(le)}</b>. Ce dernier mois est prélevé à l'arrêt, puis plus rien.`,
    tablettePretee
      ? 'La tablette est à nous renvoyer, gratuitement : un QR code prépayé, rien à imprimer. Vous pouvez le faire dès maintenant (dans l\'appli Papote, onglet Profil, « Je renvoie la tablette »), ou attendre ce jour-là : vous recevrez alors le mode d\'emploi par e-mail.'
      : 'La tablette est à vous : vous n\'avez rien à renvoyer.',
    parPapote ? '' : 'Vous changez d\'avis d\'ici là ? Dans l\'appli Papote, onglet Profil, touchez « Garder mon abonnement ».',
  ].filter(Boolean), APPLI_RETOUR);
}

// Résiliation annulée (« Garder mon abonnement ») : rien ne change.
function resiliationAnnulee({ nom, famille }) {
  return message('Votre abonnement Papote continue', [
    bonjour(nom),
    `La résiliation de l'abonnement Papote${famille ? ` de <b>${echapper(famille)}</b>` : ''} est annulée : tout continue comme avant, sans rien à faire.`,
  ], APPLI_RETOUR);
}

// fin : abonnement terminé ou commande annulée (le seul e-mail de retour, avec le mode d'emploi) ;
// sinon remplacement d'un élément du kit. qr : lien vers le QR code à montrer au point relais (sans impression).
function etiquetteRetour({ nom, lien, qr, avant, fin, retractation, montant }) {
  if (qr) {
    return message('Votre QR code pour nous rendre la tablette', [
      bonjour(nom),
      'Voici le QR code prépayé pour nous renvoyer la tablette : vous n\'avez rien à payer. Il est aussi dans l\'appli Papote, onglet Profil.',
      `${COMMENT_RENDRE_QR}${avant ? ` Date limite : <b>${dateEnClair(avant)}</b>.` : ''}`,
      fin && retractation != null && retractation > 0
        ? `Dès que la tablette nous parvient, nous vous remboursons <b>${euros(retractation)}</b> sur votre compte.` : '',
    ].filter(Boolean), { texte: 'Afficher le QR code', lien });
  }
  return message(fin ? 'Comment nous rendre la tablette Papote' : 'Votre étiquette de retour Papote', [
    bonjour(nom),
    fin ? (retractation != null
      ? 'Votre commande est bien annulée. Il reste à nous renvoyer la tablette.'
      : 'Votre abonnement Papote est terminé. Merci de nous avoir fait confiance ! La tablette est prêtée : il reste à nous la renvoyer.') : '',
    `Voici l'étiquette prépayée pour nous renvoyer ${fin ? 'la tablette' : 'l\'élément à remplacer'} : vous n'avez rien à payer. Imprimez-la avec le bouton ci-dessous (un point relais peut aussi l'imprimer pour vous si vous montrez cet e-mail).`,
    fin
      ? `${COMMENT_RENDRE}${avant ? ` Date limite : <b>${dateEnClair(avant)}</b>.` : ''}`
      : 'Mettez-le dans un carton, collez l\'étiquette dessus et déposez le colis dans n\'importe quel point relais Mondial Relay. Gardez la tablette : elle continue de fonctionner.',
    fin && retractation != null && retractation > 0
      ? `Dès que la tablette nous parvient, nous vous remboursons <b>${euros(retractation)}</b> sur votre compte.` : '',
    fin && (retractation == null || retractation <= 0) && montant
      ? `Sans retour à cette date, ${euros(montant)} seront prélevés sur votre compte. Chaque élément manquant est facturé : tablette 130 €, chargeur et câble 10 €, enceinte 10 € si elle était dans le colis.` : '',
  ].filter(Boolean), { texte: 'Imprimer l\'étiquette', lien });
}

function rappelRestitution({ nom, avant, lien, qr, montant }) {
  return message('Pensez à nous rendre la tablette Papote', [
    bonjour(nom),
    `Nous n'avons pas encore reçu la tablette. Déposez-la dans un point relais Mondial Relay avant le <b>${dateEnClair(avant)}</b> : sans retour à cette date, ${euros(montant)} seront prélevés sur votre compte.`,
    lien ? `Votre ${qr ? 'QR code' : 'étiquette'} prépayé${qr ? '' : 'e'} est disponible avec le bouton ci-dessous.` : DEMANDER_QR,
    'Si vous avez déjà déposé le colis, ne tenez pas compte de ce message.',
  ], lien ? { texte: qr ? 'Afficher le QR code' : 'Imprimer l\'étiquette', lien } : APPLI_RETOUR);
}

// rembourse : montant remboursé (centimes), 0 ou null s'il n'y a rien à rembourser.
function tabletteRecue({ nom, rembourse }) {
  return message('Nous avons bien reçu la tablette', [
    bonjour(nom),
    'La tablette Papote est bien revenue chez nous. Merci !',
    rembourse ? `Nous venons de vous rembourser <b>${euros(rembourse)}</b> : la somme apparaît sur votre compte sous 5 à 10 jours.` : 'Vous n\'avez plus rien à faire, et plus rien ne sera prélevé.',
  ]);
}

// Commande annulée avant l'envoi de la tablette.
function commandeAnnulee({ nom, rembourse }) {
  return message('Votre commande Papote est annulée', [
    bonjour(nom),
    'C\'est fait : la commande est annulée et la tablette ne partira pas.',
    rembourse ? `Nous vous avons remboursé <b>${euros(rembourse)}</b> : la somme apparaît sur votre compte sous 5 à 10 jours.` : 'Rien ne vous a été prélevé.',
  ]);
}

// Prévient Papote qu'une commande pas encore partie est annulée : ne pas envoyer la tablette.
function annulationAvantEnvoi({ nom, email, code }) {
  return message(`Commande annulée ${code || ''}`.trim(), [
    `Client : <b>${echapper(nom || '?')}</b>, ${echapper(email || 'sans e-mail')}.`,
    'Le client a annulé sa commande avant l\'envoi et a été remboursé automatiquement. Ne pas envoyer la tablette.',
  ], null, { interne: true });
}

// Invitation d'un proche par e-mail, depuis l'appli famille (inviterParEmail).
function invitation({ prenom, tablette, lien, email }) {
  const qui = prenom ? echapper(prenom) : 'Un proche';
  return message(`${prenom || 'Un proche'} vous invite sur Papote`, [
    'Bonjour,',
    `${qui} vous invite à rejoindre la famille sur Papote, pour envoyer des photos et des messages à <b>${echapper(tablette || 'votre proche')}</b> et l'appeler en vidéo.`,
    `Touchez le bouton ci-dessous, puis connectez-vous avec cette adresse e-mail (<b>${echapper(email)}</b>) pour rejoindre la famille.`,
    'Rien à installer : l\'appli s\'ouvre dans le navigateur de votre téléphone.',
  ], { texte: 'Rejoindre la famille', lien });
}

// Demande pour rejoindre la famille, envoyée aux responsables (nouveauMembre).
function demandeRejoindre({ prenom, email, famille }) {
  const qui = `${echapper(prenom || 'Quelqu\'un')}${email ? ` (${echapper(email)})` : ''}`;
  return message(`${prenom || 'Quelqu\'un'} veut rejoindre la famille`, [
    'Bonjour,',
    `${qui} veut rejoindre la famille de <b>${echapper(famille || 'votre proche')}</b> sur Papote.`,
    'Ouvrez l\'appli pour accepter ou refuser. Tant que vous n\'avez pas accepté, cette personne ne peut rien envoyer à la tablette.',
  ], { texte: 'Ouvrir l\'appli Papote', lien: 'https://app.mapapote.fr' });
}

// Prélèvement SEPA de la commande refusé par la banque : commande annulée (papote : message pour Papote).
function sepaRefuse({ nom, email, papote }) {
  if (papote) {
    return message('Commande annulée : prélèvement SEPA refusé', [
      `Client : <b>${echapper(nom || '?')}</b>, ${echapper(email || 'sans e-mail')}.`,
      'La banque a refusé le prélèvement de la mise en service. La commande et l\'abonnement sont annulés : ne pas envoyer la tablette.',
    ], null, { interne: true });
  }
  return message('Votre paiement Papote n\'a pas abouti', [
    bonjour(nom),
    'Votre banque a refusé le prélèvement SEPA de votre commande Papote. La commande est donc annulée et rien ne vous a été prélevé.',
    'Vous pouvez recommander quand vous voulez, par carte bancaire ou avec un autre compte.',
  ], { texte: 'Commander à nouveau', lien: 'https://mapapote.fr/commande.html' });
}

// Prévient Papote d'une résiliation (ou d'une commande annulée après l'envoi) : la page de la commande en lien.
function resiliation({ nom, email, code, commande, retractation, suivi, lienSuivi }) {
  const qui = nom || email || 'Un client';
  return message(`${qui} a ${retractation != null ? 'annulé sa commande' : 'résilié son abonnement'}${code ? ` (commande ${code})` : ''}`, [
    `<b>${echapper(qui)}</b>${email && nom ? ` (${echapper(email)})` : ''} a ${retractation != null ? 'annulé sa commande après l\'envoi' : 'résilié son abonnement'}.`,
    lienSuivi
      ? `Le client a reçu le mode d'emploi et l'étiquette de retour. Suivi du colis de retour : <a href="${echapper(lienSuivi)}">${echapper(suivi || 'suivre le colis')}</a> (aussi sur la page de la commande).`
      : 'Le client reçoit par e-mail le mode d\'emploi du retour. Le suivi du colis apparaîtra sur la page de la commande.',
  ], { texte: 'Ouvrir la commande', lien: `https://app.mapapote.fr/admin.html#commande/${encodeURIComponent(commande)}` }, { interne: true });
}

// Paiement de l'abonnement échoué (C1) : la famille est prévenue par Papote, pas seulement par Stripe.
// pauseLe : date de la pause si rien n'est réglé (ms), lien : l'appli (Profil, Abonnement, « Gérer le paiement »).
function paiementEchoue({ nom, famille, pauseLe, lien }) {
  return message('Le paiement de Papote n\'a pas abouti', [
    bonjour(nom),
    `Le prélèvement de l'abonnement Papote${famille ? ` de <b>${echapper(famille)}</b>` : ''} a été refusé par la banque (carte expirée, compte insuffisant, prélèvement contesté…).`,
    `Tout continue de fonctionner pour l'instant. Sans règlement, la tablette se mettra en pause le <b>${dateEnClair(pauseLe)}</b>.`,
    'Pour régler : ouvrez l\'appli Papote, touchez Profil puis, sous Abonnement, « Régler le paiement ». Vous pouvez y changer de carte ou de compte bancaire ; le prélèvement est refait automatiquement.',
  ], { texte: 'Ouvrir l\'appli Papote', lien });
}

// Papote en pause (délai de grâce dépassé) : la tablette affiche « Papote est en pause, la famille a été prévenue ».
function papoteEnPause({ nom, famille, lien }) {
  return message('Papote est en pause', [
    bonjour(nom),
    `L'abonnement Papote${famille ? ` de <b>${echapper(famille)}</b>` : ''} n'a pas pu être prélevé, et le délai de sept jours est passé : la tablette est en pause. Elle n'affiche plus les photos ni les messages, et les appels sont coupés.`,
    'Dès que le paiement est réglé, tout revient automatiquement, sans rien toucher à la tablette.',
    'Pour régler : ouvrez l\'appli Papote, touchez Profil puis, sous Abonnement, « Régler le paiement ».',
  ], { texte: 'Ouvrir l\'appli Papote', lien });
}

// Appel ou SOS de la tablette qui n'a fait sonner aucun téléphone (D1) : tous les proches le savent par e-mail.
function appelSansTelephone({ nom, sos, lien }) {
  const qui = echapper(nom || 'Votre proche');
  return message(sos ? `SOS : ${nom || 'votre proche'} a appelé, aucun téléphone n'a sonné` : `${nom || 'Votre proche'} a appelé, aucun téléphone n'a sonné`, [
    'Bonjour,',
    sos
      ? `<b>${qui} a appuyé sur le bouton SOS</b> de sa tablette, mais aucun téléphone de la famille n'a pu sonner. Rappelez votre proche dès que possible.`
      : `${qui} a appelé depuis sa tablette, mais aucun téléphone de la famille n'a pu sonner.`,
    'Pour que les appels sonnent : ouvrez l\'appli Papote sur votre téléphone et autorisez les notifications (Profil, Notifications). Avec l\'appli Android Papote, le téléphone sonne comme pour un vrai appel.',
  ], { texte: 'Ouvrir l\'appli Papote', lien });
}

// Alerte à Papote (prélèvement refusé ou contesté…), avec le lien vers la commande dans l'admin.
function alerteAdmin({ titre, detail, commande }) {
  return message(titre, [echapper(detail)], commande
    ? { texte: 'Ouvrir la commande', lien: `https://app.mapapote.fr/admin.html#commande/${encodeURIComponent(commande)}` } : null, { interne: true });
}

// smtp : « hote:port:utilisateur » (MAIL_SMTP), expediteur : adresse affichée (MAIL_EXPEDITEUR).
let transport;
async function envoyer({ smtp, motDePasse, expediteur, a, contenu }) {
  if (!motDePasse || !expediteur) throw new Error('E-mails non configurés (MAIL_EXPEDITEUR, MAIL_MOT_DE_PASSE).');
  if (!transport) {
    const [hote, port, utilisateur] = smtp.split(':');
    transport = require('nodemailer').createTransport({
      host: hote, port: Number(port), secure: Number(port) === 465,
      auth: { user: utilisateur || expediteur, pass: motDePasse },
    });
  }
  await transport.sendMail({ from: `Papote <${expediteur}>`, replyTo: expediteur, to: a, ...contenu });
}

module.exports = {
  colisParti, tabletteRemise, paiementEchoue, papoteEnPause, appelSansTelephone, commandeConfirmee, nouvelleCommande, relancePanier, lancement, sepaRefuse, invitation, demandeRejoindre, rappelJumelage,
  retourTablette, etiquetteRetour, resiliationEnregistree, resiliationAnnulee, rappelRestitution, tabletteRecue, commandeAnnulee, annulationAvantEnvoi, resiliation, alerteAdmin,
  envoyer, echapper, euros, dateEnClair,
};
