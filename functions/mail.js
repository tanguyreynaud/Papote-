// E-mails envoyés aux clients (commande, colis parti, rappels, abonnement, retour de la tablette) et à Papote,
// par SMTP. Gmail au départ (mot de passe d'application) ; Brevo plus tard en changeant MAIL_SMTP dans .env.
// Mot de passe dans Secret Manager (MAIL_MOT_DE_PASSE), jamais dans le dépôt.
//
// Tous les e-mails passent par message(titre, blocs, bouton, options) : une seule mise en page (page()),
// aux couleurs du site, qui tient sur un téléphone et dans Gmail, Outlook et Apple Mail (tableaux et styles
// en ligne, pas de police à charger). Un bloc est un paragraphe (texte HTML) ou un objet :
//   { fiche: [[libellé, valeur], …] }   encadré clair avec les infos à retenir (numéro, date, montant)
//   { etapes: ['…', '…'] }               liste numérotée (brancher, ouvrir l'appli, scanner…)
//   { encadre: '…' }                     phrase importante, mise en avant (date limite, somme prélevée)
//   { section: { titre, items } }        titre + liste à puces (e-mails internes : récap, livres)
//   { petit: '…' }                       ligne discrète
//   { html: '…' }                        HTML tel quel (texte brut : balises retirées)
// outils/galerie (emails.js) affiche chaque e-mail de ce fichier dans la galerie des écrans.

const APPLI = 'https://app.mapapote.fr';
const SITE = 'https://mapapote.fr';
const ADMIN = 'https://app.mapapote.fr/admin.html';
// Lien vers l'appli qui garde le code de commande : la famille créée s'y rattache toute seule.
const lienAppli = (code) => (code ? `${APPLI}/?commande=${encodeURIComponent(code)}` : APPLI);
const lienCommandeAdmin = (commande) => `${ADMIN}#commande/${encodeURIComponent(commande)}`;

function echapper(t) {
  return String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Espaces insécables avant : ; ! ? € % » et après « (le texte seul, pas les balises) :
// « 20 € » ou « limite : 25 novembre » ne se coupent plus en fin de ligne.
const insecables = (h) => h.split(/(<[^>]*>)/).map((m) => (m.startsWith('<') ? m
  : m.replace(/ ([:;!?€%»])/g, '&nbsp;$1').replace(/« /g, '«&nbsp;'))).join('');

const sansBalises = (h) => String(h == null ? '' : h).replace(/<br\s*\/?>/g, '\n').replace(/<\/(p|li|tr|h\d)>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/[ \t]+\n/g, '\n').trim();

// ---------- Mise en page commune ----------

const C = {
  fond: '#fdfaf5', carte: '#ffffff', texte: '#24212f', doux: '#5f5a6b', ligne: '#e7e1d6',
  indigo: '#4f46e5', indigoDoux: '#eef2ff', indigoFonce: '#3730a3',
};
const POLICE = "'Atkinson Hyperlegible', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const POLICE_TITRE = "'Bricolage Grotesque', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const P = `margin:0 0 16px;font-family:${POLICE};font-size:17px;line-height:1.6;color:${C.texte}`;

// Un bloc en HTML.
function blocHtml(b) {
  if (b == null || b === '') return '';
  if (typeof b === 'string') return `<p style="margin:0 0 16px">${insecables(b)}</p>`;
  if (b.html) return b.html;
  if (b.petit) return `<p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:${C.doux}">${insecables(b.petit)}</p>`;
  if (b.encadre) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;border-collapse:separate">
<tr><td style="background:${C.indigoDoux};border-left:4px solid ${C.indigo};border-radius:0 12px 12px 0;padding:14px 16px;font-family:${POLICE};font-size:17px;line-height:1.5;color:${C.texte}">${insecables(b.encadre)}</td></tr></table>`;
  }
  if (b.fiche) {
    const lignes = b.fiche.filter((l) => l && l[1] != null && l[1] !== '');
    if (!lignes.length) return '';
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:${C.fond};border:1px solid ${C.ligne};border-radius:12px;border-collapse:separate">
${lignes.map(([k, v], i) => `<tr><td style="padding:${i === 0 ? 14 : 8}px 16px ${i === lignes.length - 1 ? 14 : 8}px;font-family:${POLICE};${i ? `border-top:1px solid ${C.ligne};` : ''}">
<div style="font-size:13px;line-height:1.3;letter-spacing:.04em;text-transform:uppercase;color:${C.doux}">${insecables(echapper(k))}</div>
<div style="font-size:17px;line-height:1.45;font-weight:bold;color:${C.texte};word-break:break-word">${insecables(v)}</div></td></tr>`).join('\n')}
</table>`;
  }
  if (b.etapes) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px;border-collapse:separate">
${b.etapes.map((e, i) => `<tr><td valign="top" width="32" style="width:32px;padding:0 12px 12px 0"><div style="width:32px;height:32px;border-radius:50%;background:${C.indigo};color:#ffffff;font-family:${POLICE_TITRE};font-size:16px;font-weight:bold;line-height:32px;text-align:center">${i + 1}</div></td>
<td valign="top" style="padding:4px 0 12px;font-family:${POLICE};font-size:17px;line-height:1.5;color:${C.texte}">${insecables(e)}</td></tr>`).join('\n')}
</table>`;
  }
  if (b.section) {
    const { titre, items } = b.section;
    return `<h2 style="margin:22px 0 8px;font-family:${POLICE_TITRE};font-size:19px;line-height:1.3;color:${C.texte}">${insecables(echapper(titre))}</h2>
<ul style="margin:0 0 16px;padding-left:22px;font-family:${POLICE};font-size:16px;line-height:1.55;color:${C.texte}">${items.map((i) => `<li style="margin:0 0 6px">${insecables(i)}</li>`).join('')}</ul>`;
  }
  return '';
}

// Le même bloc en texte brut (clients sans HTML, aperçu dans la boîte de réception).
function blocTexte(b) {
  if (b == null || b === '') return null;
  if (typeof b === 'string') return sansBalises(b);
  if (b.html || b.petit || b.encadre) return sansBalises(b.html || b.petit || b.encadre);
  if (b.fiche) return b.fiche.filter((l) => l && l[1] != null && l[1] !== '').map(([k, v]) => `${k} : ${sansBalises(v)}`).join('\n');
  if (b.etapes) return b.etapes.map((e, i) => `${i + 1}. ${sansBalises(e)}`).join('\n');
  if (b.section) return [b.section.titre.toUpperCase(), ...b.section.items.map((i) => `- ${sansBalises(i)}`)].join('\n');
  return null;
}

// Première phrase visible dans la boîte de réception (sous l'objet), avant d'ouvrir l'e-mail.
function apercuDe(blocs, options) {
  if (options.apercu) return options.apercu;
  const premier = blocs.map(blocTexte).find((t) => t && !/^Bonjour\b[^\n]{0,60},?$/.test(t)) || '';
  const t = premier.split('\n')[0];
  return t.length > 140 ? `${t.slice(0, 137)}…` : t;
}

// options.interne : e-mail pour Papote (pied « message automatique », lien vers l'admin), sans « Une question ? » ;
// options.desinscription (lien) + options.pourquoi : e-mail envoyé avec l'accord de la personne (relances, nouvelles) ;
// options.apercu : texte d'aperçu dans la boîte de réception (sinon le premier paragraphe).
function page(titre, blocs, bouton, options = {}) {
  const corps = blocs.map(blocHtml).join('\n');
  const btn = bouton
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 10px;border-collapse:separate">
<tr><td align="center" style="background:${C.indigo};border-radius:999px"><a href="${echapper(bouton.lien)}" style="display:inline-block;padding:15px 28px;font-family:${POLICE};font-size:17px;font-weight:bold;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:999px">${insecables(echapper(bouton.texte))}&nbsp;→</a></td></tr></table>`
    : '';
  const question = options.interne ? '' : `<p style="margin:22px 0 0;font-size:15px;line-height:1.5;color:${C.doux}">Une question&nbsp;? Répondez simplement à cet e&#8209;mail, nous vous répondons personnellement.</p>`;
  const pourquoi = options.desinscription
    ? `<p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:${C.doux}">${insecables(echapper(options.pourquoi || 'Vous recevez cet e-mail car vous avez accepté les nouvelles de Papote.'))} <a href="${echapper(options.desinscription)}" style="color:${C.doux}">Se désinscrire</a>.</p>`
    : '';
  const pied = options.interne
    ? `Message automatique de Papote pour l'administrateur · <a href="${ADMIN}" style="color:${C.doux}">Espace admin</a>`
    : `Papote · <a href="${SITE}" style="color:${C.doux};text-decoration:none">mapapote.fr</a> · la tablette qui relie les familles`;
  const apercu = apercuDe(blocs, options);
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${echapper(titre)}</title>
<style>
body { margin:0; padding:0; background:${C.fond}; -webkit-text-size-adjust:100%; }
a { color:${C.indigo}; }
@media (max-width: 480px) {
  .enveloppe { padding:16px 10px 24px !important; }
  .carte { padding:22px 18px !important; border-radius:14px !important; }
  .titre { font-size:24px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${C.fond}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.fond};font-size:1px;line-height:1px">${echapper(apercu)}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.fond}">
<tr><td align="center" class="enveloppe" style="padding:28px 16px 32px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;border-collapse:separate">
<tr><td style="padding:0 6px 16px">
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate"><tr>
<td width="34" height="34" align="center" valign="middle" style="width:34px;height:34px;border-radius:9px;background:${C.indigo};color:#ffffff;font-family:${POLICE_TITRE};font-size:20px;font-weight:bold;line-height:34px;text-align:center">P</td>
<td style="padding-left:10px;font-family:${POLICE_TITRE};font-size:21px;font-weight:bold;line-height:1;color:${C.indigo}">Papote${options.interne ? `<span style="font-family:${POLICE};font-size:14px;font-weight:normal;color:${C.doux}"> · pour Tanguy</span>` : ''}</td>
</tr></table>
</td></tr>
<tr><td class="carte" style="background:${C.carte};border:1px solid ${C.ligne};border-radius:18px;padding:30px 28px 24px;font-family:${POLICE};font-size:17px;line-height:1.6;color:${C.texte}">
<h1 class="titre" style="margin:0 0 20px;font-family:${POLICE_TITRE};font-size:27px;line-height:1.2;color:${C.texte}">${insecables(echapper(titre))}</h1>
${corps}
${btn}
${question}
</td></tr>
<tr><td style="padding:18px 6px 0;font-family:${POLICE};font-size:13px;line-height:1.5;color:${C.doux}">${pied}${pourquoi}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function texteBrut(titre, blocs, bouton, options = {}) {
  return [titre, '', ...blocs.map(blocTexte).filter((t) => t != null).map((t) => `${t}\n`), bouton ? `${bouton.texte} : ${bouton.lien}` : '', '',
    ...(options.interne ? [`Espace admin : ${ADMIN}`] : ['Une question ? Répondez simplement à cet e-mail.']),
    ...(options.desinscription ? ['', `${options.pourquoi || 'Vous recevez cet e-mail car vous avez accepté les nouvelles de Papote.'}`, `Se désinscrire : ${options.desinscription}`] : [])]
    .join('\n').replace(/\n{3,}/g, '\n\n');
}

function message(titre, blocs, bouton, options = {}) {
  const b = blocs.filter((x) => x != null && x !== '');
  return { subject: titre, html: page(titre, b, bouton, options), text: texteBrut(titre, b, bouton, options) };
}

function relaisEnTexte(r) {
  if (!r) return '';
  return [r.nom, r.adresse, [r.cp, r.ville].filter(Boolean).join(' ')].filter(Boolean).map(echapper).join(', ');
}

function dateEnClair(ms) {
  return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
}

function euros(centimes) {
  const e = centimes / 100;
  return `${Number.isInteger(e) ? e : e.toFixed(2).replace('.', ',')} €`;
}

const bonjour = (nom) => `Bonjour${nom ? ` ${echapper(nom)}` : ''},`;
const lienHtml = (lien, texte) => `<a href="${echapper(lien)}" style="color:${C.indigo}">${texte}</a>`;

// Les trois gestes à l'arrivée de la tablette (colis parti, remise en main propre, rappels de jumelage).
// Parcours d'installation du 21/10/2026 : la carte SIM est déjà dans la tablette (pas de wifi à régler), le QR code
// se scanne avec l'appareil photo du téléphone (ou le code se tape sur app.mapapote.fr), puis l'appli demande le
// nom du proche, une première photo et fait le test du son.
const GESTES_ARRIVEE = (code) => ({ etapes: [
  'Branchez la tablette et allumez-la. La carte SIM est déjà dedans : rien à régler.',
  `Avec l'appareil photo de votre téléphone, scannez le QR code affiché sur la tablette (ou ${lienHtml(lienAppli(code), 'ouvrez app.mapapote.fr')} et tapez le code affiché).`,
  'L\'appli vous guide ensuite : le nom de votre proche, une première photo, le test du son. Deux minutes, et la tablette est prête.',
] });

// ---------- Commande et livraison ----------

function colisParti({ nom, suivi, lien, relais, code }) {
  return message('Votre tablette Papote est en route', [
    bonjour(nom),
    `Votre tablette vient de partir. Vous recevrez un message de Mondial Relay dès qu'elle sera disponible${relais ? ' au point relais' : ' au point relais choisi'}.`,
    { fiche: [['Numéro de suivi', echapper(suivi)], ['Point relais', relais ? relaisEnTexte(relais) : null]] },
    'À son arrivée, trois gestes :',
    GESTES_ARRIVEE(code),
  ], { texte: 'Suivre mon colis', lien });
}

// Tablette remise en main propre par Tanguy (A1) : pas de colis à suivre, elle est déjà chez le client.
function tabletteRemise({ nom, code }) {
  return message('Votre tablette Papote est chez vous', [
    bonjour(nom),
    'Votre tablette Papote vous a été remise en main propre : elle est prête. Trois gestes pour la relier à votre famille :',
    GESTES_ARRIVEE(code),
    // Plus de « 30 jours pour changer d'avis » (Tanguy, 2026-10-29) : même règle que l'e-mail de commande, les CGV couvrent le droit.
  ], { texte: 'Ouvrir l\'appli Papote', lien: lienAppli(code) });
}

// Offre unique depuis le 29/10/2026 (Tanguy) : un seul prix, carte SIM toujours fournie.
const OFFRE = '25 € par mois, tout compris (carte SIM incluse)';
const FICHE_OFFRE = [
  ['À la commande', '60 € de mise en service'],
  ['Ensuite', `${OFFRE}, sans engagement`],
  ['Livraison', 'offerte, en point relais'],
  ['Changer d\'avis', '30 jours après la réception : rien à payer, les 60 € remboursés'],
];

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
      bonjour(nom),
      `Merci, votre abonnement Papote ${reprise ? 'reprend' : 'est pris'} ! La tablette fonctionne déjà, il n'y a rien d'autre à faire.`,
      { fiche: [
        ['Numéro', code ? echapper(code) : null],
        ['Réglé aujourd\'hui', reprise ? 'rien' : '60 € de mise en service'],
        ['Abonnement', `${mensuel}, payés une fois chaque mois écoulé, sans engagement`],
        ['Premier mois', 'prélevé dans 30 jours'],
      ] },
      reprise ? null : 'D\'ici là, vous pouvez changer d\'avis : rien à payer et les 60 € remboursés.',
    ], { texte: 'Ouvrir l\'appli Papote', lien: APPLI });
  }
  return message('Merci pour votre commande Papote', [
    bonjour(nom),
    'Merci pour votre commande !',
    // Plus de « vous pouvez annuler à tout moment avant » (Tanguy, 2026-10-27, A2) : les CGV couvrent le droit,
    // l'e-mail n'invite pas à reculer. « Une question ? Répondez à cet e-mail » reste en pied.
    `${DELAI}. Vous recevrez un e-mail dès qu'elle part.`,
    { fiche: [
      ['Numéro de commande', code ? echapper(code) : null],
      ['Livraison', relais && relais.transporteur
        ? `offerte au point relais ${relaisEnTexte(relais)}${relais.destinataire ? `, à retirer par ${echapper(relais.destinataire)}` : ''}`
        : 'offerte à l\'adresse indiquée'],
      ['Réglé aujourd\'hui', '60 € de mise en service'],
      ['Abonnement', `${mensuel}, payés une fois chaque mois écoulé à partir de la réception, sans engagement`],
      ['Changer d\'avis', '30 jours après la réception : rien à payer et les 60 € remboursés'],
    ] },
    '<b>En attendant, installez l\'appli Papote sur votre téléphone</b> avec le bouton ci-dessous. Vous n\'avez pas encore de code, c\'est normal : il s\'affichera sur l\'écran de la tablette quand vous l\'allumerez. Vous le scannerez avec votre téléphone, et l\'appli vous guidera.',
    { petit: 'La tablette est prêtée et configurée : vous n\'avez rien à installer.' },
  ], { texte: 'Installer l\'appli Papote', lien: APPLI });
}

// Panier abandonné (functions/relances.js) : etape 1 (une heure après), 2 (lendemain soir), 3 (une semaine après).
function relancePanier({ etape = 1, nom, formule, lien, desinscription }) {
  const textes = {
    1: ['Votre commande Papote vous attend', [
      'Vous avez commencé une commande Papote sans la terminer. Elle est gardée de côté : vous pouvez la reprendre en un clic, avec le même point relais.',
      { fiche: FICHE_OFFRE },
      { petit: 'La tablette est prêtée et déjà configurée.' },
    ]],
    2: ['Une question avant de vous décider ?', [
      'Vous avez regardé Papote hier. Si quelque chose vous fait hésiter, répondez simplement à cet e-mail : nous vous répondons personnellement.',
      'La tablette arrive prête à brancher, votre proche n\'a rien à manipuler, et vous avez 30 jours après la réception pour changer d\'avis : rien à payer et les 60 € remboursés.',
    ]],
    3: ['Dernier rappel pour votre commande Papote', [
      'Votre commande Papote est toujours prête. C\'est notre dernier rappel : nous ne vous écrirons plus à ce sujet.',
      { fiche: FICHE_OFFRE },
      { petit: 'Rien à installer pour votre proche : la tablette arrive prête.' },
    ]],
  };
  const [titre, corps] = textes[etape] || textes[1];
  return message(titre, [bonjour(nom), ...corps], { texte: 'Reprendre ma commande', lien }, {
    desinscription: desinscription || '',
    pourquoi: 'Vous recevez cet e-mail car vous avez accepté les nouvelles de Papote.',
  });
}

// « Être prévenu » sur le site, à stock 0 (listeAttente) : la personne sait que c'est noté.
function listeAttenteConfirmee({ prenom, telephone, desinscription }) {
  return message('C\'est noté : nous vous prévenons dès qu\'une tablette est prête', [
    bonjour(prenom),
    'Toutes nos tablettes sont parties, nous en préparons de nouvelles. Dès que l\'une d\'elles est prête pour vous, vous recevez un e-mail avec le lien pour commander.',
    telephone ? `Vous nous avez aussi laissé le <b>${echapper(telephone)}</b> : Tanguy vous appelle directement si c\'est plus simple.` : null,
    { fiche: FICHE_OFFRE },
    'En attendant, votre proche n\'a rien à préparer : la tablette arrive configurée, prête à brancher.',
  ], { texte: 'Découvrir Papote', lien: SITE }, {
    desinscription: desinscription || '',
    pourquoi: 'Vous recevez cet e-mail car vous avez demandé à être prévenu dès qu\'une tablette Papote est disponible.',
  });
}

// Ouverture des commandes, pour la liste d'attente du site (lancementListeAttente).
function lancement({ prenom, desinscription }) {
  return message('Papote est disponible : vous pouvez commander', [
    bonjour(prenom),
    'Vous nous aviez demandé de vous prévenir : c\'est le moment, les commandes Papote sont ouvertes.',
    'La tablette arrive prête à brancher, en point relais près de chez vous ou de chez votre proche. Votre proche n\'a rien à régler : c\'est la famille qui envoie les photos et qui appelle, la tablette décroche toute seule.',
    { fiche: FICHE_OFFRE },
    'Nous préparons les tablettes par petits lots : les premières commandes partent en premier.',
  ], { texte: 'Commander ma tablette', lien: `${SITE}/commande.html` }, {
    desinscription: desinscription || '',
    pourquoi: 'Vous recevez cet e-mail car vous vous êtes inscrit à la liste d\'attente de Papote.',
  });
}

// Prévient Papote qu'une tablette est à préparer. commande : identifiant (page de la commande dans l'admin).
function nouvelleCommande({ nom, email, telephone, code, relais, proche, formule, delai, dejaInstallee, reprise, commande }) {
  const bouton = commande ? { texte: 'Ouvrir la commande', lien: lienCommandeAdmin(commande) } : null;
  const client = [['Client', echapper(nom || '?')], ['E-mail', echapper(email || 'sans e-mail')], ['Téléphone', telephone ? echapper(telephone) : null]];
  if (dejaInstallee) {
    return message(`${reprise ? 'Abonnement repris' : 'Nouvel abonnement'} ${code || ''}`.trim(), [
      { fiche: [...client, ['Offre', OFFRE]] },
      reprise
        ? 'Abonnement repris après une résiliation, tablette restée chez le proche : rien à envoyer, pas de mise en service. Premier prélèvement dans 30 jours.'
        : 'Pris dans l\'appli, tablette déjà installée chez le proche : rien à envoyer. Premier prélèvement dans 30 jours.',
    ], bouton, { interne: true });
  }
  const couverture = proche ? (/^commune:/.test(proche.couverture4g || '')
    ? `bonne ou très bonne sur ${echapper(proche.couverture4g.slice(8))} % de la commune (adresse exacte inconnue)`
    : { TBC: 'très bonne', BC: 'bonne', CL: 'limitée' }[proche.couverture4g] || 'inconnue') : null;
  return message(`Nouvelle commande ${code || ''}`.trim(), [
    { fiche: [
      ...client,
      ['Offre', `${OFFRE}. Ligne SIM à ouvrir pour cette commande`],
      relais && relais.transporteur
        ? ['Point relais', `${relaisEnTexte(relais)} (n° ${echapper(relais.id)})`]
        : ['Livraison', relaisEnTexte(relais) || 'adresse non trouvée, voir Stripe'],
      relais && relais.transporteur ? ['Retrait par', echapper(relais.destinataire || nom || '?')] : null,
      proche ? ['Chez le proche', `${echapper(proche.adresse)}<br>4G Bouygues ${couverture} (carte ARCEP)`] : null,
      ['Stock', { stock: 'tablette en stock', precommande: 'plus de tablette en stock, à préparer vite (expédition promise sous 3 à 5 jours ouvrés)', long: 'plus de 10 commandes au-delà du stock, à préparer vite (expédition promise sous 3 à 5 jours ouvrés)' }[delai] || 'tablette en stock'],
    ] },
    'Tablette à préparer, puis à marquer « envoyée » dans le tableau de bord.',
  ], bouton, { interne: true });
}

function rappelJumelage({ nom, numero, code }) {
  const titre = numero === 1 ? 'Votre tablette Papote vous attend' : 'Besoin d\'un coup de main avec Papote ?';
  return message(titre, [
    bonjour(nom),
    numero === 1
      ? 'Votre tablette Papote devrait être arrivée au point relais, mais elle n\'est pas encore reliée à votre famille. Cela prend deux minutes :'
      : 'Votre tablette Papote n\'est toujours pas reliée à votre famille. Si quelque chose bloque, répondez à cet e-mail : nous vous aidons. Pour la relier :',
    GESTES_ARRIVEE(code),
  ], { texte: 'Ouvrir l\'appli Papote', lien: lienAppli(code) });
}

// ---------- Famille ----------

// Invitation d'un proche par e-mail, depuis l'appli famille (inviterParEmail).
function invitation({ prenom, tablette, lien, email }) {
  const qui = prenom ? echapper(prenom) : 'Un proche';
  return message(`${prenom || 'Un proche'} vous invite sur Papote`, [
    'Bonjour,',
    `${qui} vous invite à rejoindre la famille sur Papote, pour envoyer des photos et des messages à <b>${echapper(tablette || 'votre proche')}</b> et l'appeler en vidéo.`,
    { etapes: [
      'Touchez le bouton « Rejoindre la famille » ci-dessous.',
      `Connectez-vous avec cette adresse e-mail : <b>${echapper(email)}</b>.`,
      'C\'est tout : vous pouvez envoyer votre première photo.',
    ] },
    { petit: 'Rien à installer : l\'appli s\'ouvre dans le navigateur de votre téléphone.' },
  ], { texte: 'Rejoindre la famille', lien });
}

// Demande pour rejoindre la famille, envoyée aux responsables (nouveauMembre).
function demandeRejoindre({ prenom, email, famille }) {
  return message(`${prenom || 'Quelqu\'un'} veut rejoindre la famille`, [
    'Bonjour,',
    `Quelqu'un demande à rejoindre la famille de <b>${echapper(famille || 'votre proche')}</b> sur Papote :`,
    { fiche: [['Prénom', echapper(prenom || 'non indiqué')], ['E-mail', email ? echapper(email) : null]] },
    'Ouvrez l\'appli pour accepter ou refuser. Tant que vous n\'avez pas accepté, cette personne ne peut rien envoyer à la tablette.',
  ], { texte: 'Ouvrir l\'appli Papote', lien: APPLI });
}

// Demande acceptée par un responsable : la personne peut entrer (membreAccepte).
function demandeAcceptee({ prenom, famille, lien }) {
  return message(`Bienvenue dans la famille de ${famille || 'votre proche'}`, [
    bonjour(prenom),
    `Votre demande est acceptée : vous faites maintenant partie de la famille de <b>${echapper(famille || 'votre proche')}</b> sur Papote.`,
    'Vous pouvez dès maintenant envoyer une photo ou un message à la tablette, et l\'appeler en vidéo : la tablette décroche toute seule.',
  ], { texte: 'Ouvrir l\'appli Papote', lien: lien || APPLI });
}

// Installation terminée (finirInstallation) : le mode d'emploi en trois lignes, à garder.
function installationFinie({ prenom, famille, lien }) {
  const qui = echapper(famille || 'votre proche');
  return message(`La tablette de ${famille || 'votre proche'} est prête`, [
    bonjour(prenom),
    `C'est fait : la tablette de <b>${qui}</b> est reliée à votre famille. Gardez cet e-mail, il résume l'essentiel.`,
    { etapes: [
      `<b>Envoyer une photo ou un message</b> : dans l'appli, touchez « Envoyer ». La tablette l'affiche tout de suite, avec un petit carillon.`,
      `<b>Appeler en vidéo</b> : touchez « Appeler ». La tablette décroche toute seule, ${qui} n'a rien à faire.`,
      '<b>Inviter la famille</b> : onglet Famille, « Inviter ». Chacun installe l\'appli sur son téléphone, rien de plus.',
      `<b>Rester rassuré</b> : si la tablette est débranchée ou si ${qui} appuie sur SOS, vous êtes prévenu sur votre téléphone.`,
    ] },
    'Si quelque chose ne marche pas comme prévu, répondez à cet e-mail : nous vous aidons.',
  ], { texte: 'Ouvrir l\'appli Papote', lien: lien || APPLI });
}

// Appel ou SOS de la tablette qui n'a fait sonner aucun téléphone (D1) : tous les proches le savent par e-mail.
function appelSansTelephone({ nom, sos, lien }) {
  const qui = echapper(nom || 'Votre proche');
  return message(sos ? `SOS : ${nom || 'votre proche'} a appelé, aucun téléphone n'a sonné` : `${nom || 'Votre proche'} a appelé, aucun téléphone n'a sonné`, [
    'Bonjour,',
    sos
      ? { encadre: `<b>${qui} a appuyé sur le bouton SOS</b> de sa tablette, mais aucun téléphone de la famille n'a pu sonner. Rappelez votre proche dès que possible.` }
      : `${qui} a appelé depuis sa tablette, mais aucun téléphone de la famille n'a pu sonner.`,
    'Pour que les appels sonnent la prochaine fois :',
    { etapes: [
      'Ouvrez l\'appli Papote sur votre téléphone.',
      'Touchez Profil, puis Notifications, et autorisez-les.',
      'Avec l\'appli Android Papote, le téléphone sonne comme pour un vrai appel.',
    ] },
  ], { texte: 'Ouvrir l\'appli Papote', lien });
}

// ---------- Abonnement ----------

// Paiement de l'abonnement échoué (C1) : la famille est prévenue par Papote, pas seulement par Stripe.
// pauseLe : date de la pause si rien n'est réglé (ms), lien : l'appli (Profil, Abonnement, « Régler le paiement »).
function paiementEchoue({ nom, famille, pauseLe, lien }) {
  return message('Le paiement de Papote n\'a pas abouti', [
    bonjour(nom),
    `Le prélèvement de l'abonnement Papote${famille ? ` de <b>${echapper(famille)}</b>` : ''} a été refusé par la banque (carte expirée, compte insuffisant, prélèvement contesté…).`,
    { encadre: `Tout continue de fonctionner pour l'instant. Sans règlement, la tablette se mettra en pause le <b>${dateEnClair(pauseLe)}</b>.` },
    'Pour régler :',
    { etapes: [
      'Ouvrez l\'appli Papote et touchez Profil.',
      'Sous Abonnement, touchez « Régler le paiement ».',
      'Changez de carte ou de compte bancaire si besoin : le prélèvement est refait automatiquement.',
    ] },
  ], { texte: 'Régler le paiement', lien });
}

// Papote en pause (délai de grâce dépassé) : la tablette affiche « Papote est en pause, la famille a été prévenue ».
function papoteEnPause({ nom, famille, lien }) {
  return message('Papote est en pause', [
    bonjour(nom),
    `L'abonnement Papote${famille ? ` de <b>${echapper(famille)}</b>` : ''} n'a pas pu être prélevé, et le délai de sept jours est passé : la tablette est en pause. Elle n'affiche plus les photos ni les messages, et les appels sont coupés.`,
    { encadre: 'Dès que le paiement est réglé, tout revient automatiquement, sans rien toucher à la tablette.' },
    'Pour régler : ouvrez l\'appli Papote, touchez Profil puis, sous Abonnement, « Régler le paiement ».',
  ], { texte: 'Régler le paiement', lien });
}

// Hospitalisation du proche (pauseHospitalisation) : prélèvements en pause jusqu'à une date, puis repris.
function pausePrelevements({ nom, famille, jusqua }) {
  return message('Vos prélèvements Papote sont en pause', [
    bonjour(nom),
    `Comme convenu, les prélèvements de l'abonnement Papote${famille ? ` de <b>${echapper(famille)}</b>` : ''} sont en pause : rien ne sera prélevé pendant cette période.`,
    { encadre: `Les prélèvements reprennent le <b>${dateEnClair(jusqua)}</b>. La tablette continue de fonctionner normalement d'ici là.` },
    'Si la situation change avant cette date, répondez à cet e-mail : nous adaptons.',
  ], { texte: 'Ouvrir l\'appli Papote', lien: `${APPLI}/?abonnement=1` });
}

function reprisePrelevements({ nom, famille }) {
  return message('Vos prélèvements Papote reprennent', [
    bonjour(nom),
    `La pause de l'abonnement Papote${famille ? ` de <b>${echapper(famille)}</b>` : ''} est terminée : les prélèvements reprennent normalement, ${OFFRE}, sans engagement.`,
    'Rien à faire de votre côté. Nous espérons que tout va bien.',
  ], { texte: 'Ouvrir l\'appli Papote', lien: `${APPLI}/?abonnement=1` });
}

// Prélèvement SEPA de la commande refusé par la banque : commande annulée (papote : message pour Papote).
function sepaRefuse({ nom, email, papote, commande }) {
  if (papote) {
    return message('Commande annulée : prélèvement SEPA refusé', [
      { fiche: [['Client', echapper(nom || '?')], ['E-mail', echapper(email || 'sans e-mail')]] },
      'La banque a refusé le prélèvement de la mise en service. La commande et l\'abonnement sont annulés : ne pas envoyer la tablette.',
    ], commande ? { texte: 'Ouvrir la commande', lien: lienCommandeAdmin(commande) } : null, { interne: true });
  }
  return message('Votre paiement Papote n\'a pas abouti', [
    bonjour(nom),
    'Votre banque a refusé le prélèvement SEPA de votre commande Papote. La commande est donc annulée et rien ne vous a été prélevé.',
    'Vous pouvez recommander quand vous voulez, par carte bancaire ou avec un autre compte.',
  ], { texte: 'Commander à nouveau', lien: `${SITE}/commande.html` });
}

// ---------- Fin de contrat et retour de la tablette ----------

const CARTON = 'Mettez la tablette, son support, son chargeur et son câble (et l\'enceinte si vous l\'avez reçue) dans un carton';
const CARTON_ETAPE = `${CARTON}. Inutile d'effacer la tablette : nous nous en chargeons.`;
const ETAPES_RETOUR_QR = [
  'Dans l\'appli Papote, onglet Profil, touchez « Je renvoie la tablette » : un QR code prépayé s\'affiche.',
  CARTON_ETAPE,
  'Déposez le colis dans n\'importe quel point relais Mondial Relay en montrant le QR code sur votre téléphone. Rien à payer, rien à imprimer.',
];
const APPLI_RETOUR = { texte: 'Ouvrir l\'appli Papote', lien: `${APPLI}/?abonnement=1` };
const MANQUANTS = 'Chaque élément manquant est facturé : tablette 130 €, chargeur et câble 10 €, enceinte 10 € si elle était dans le colis.';

// Abonnement terminé ou commande annulée après l'envoi : la tablette prêtée est attendue.
// retractation : montant remboursé au retour (centimes), sinon null.
function retourTablette({ nom, avant, retractation, montant }) {
  return message('Comment nous rendre la tablette Papote', [
    bonjour(nom),
    retractation != null
      ? 'Votre commande est bien annulée. Il reste à nous renvoyer la tablette, en trois gestes :'
      : 'Votre abonnement Papote est terminé. Merci de nous avoir fait confiance ! La tablette est prêtée : il reste à nous la renvoyer, en trois gestes :',
    { etapes: ETAPES_RETOUR_QR },
    { encadre: `Date limite : <b>${dateEnClair(avant)}</b>.${retractation != null && retractation > 0
      ? ` Dès que la tablette nous parvient, nous vous remboursons <b>${euros(retractation)}</b> sur votre compte.`
      : ` Sans retour à cette date, ${euros(montant)} seront prélevés sur votre compte.`}` },
    retractation != null && retractation > 0 ? null : { petit: MANQUANTS },
  ], APPLI_RETOUR);
}

// fin : abonnement terminé ou commande annulée (le seul e-mail de retour, avec le mode d'emploi) ;
// sinon remplacement d'un élément du kit. qr : lien vers le QR code à montrer au point relais (sans impression).
function etiquetteRetour({ nom, lien, qr, avant, fin, retractation, montant }) {
  const rembourse = fin && retractation != null && retractation > 0
    ? `Dès que la tablette nous parvient, nous vous remboursons <b>${euros(retractation)}</b> sur votre compte.` : '';
  if (qr) {
    return message('Votre QR code pour nous rendre la tablette', [
      bonjour(nom),
      'Voici le QR code prépayé pour nous renvoyer la tablette : vous n\'avez rien à payer. Il est aussi dans l\'appli Papote, onglet Profil.',
      { etapes: [
        CARTON_ETAPE,
        'Déposez le colis dans n\'importe quel point relais Mondial Relay en montrant ce QR code sur votre téléphone (pas besoin d\'imprimer).',
      ] },
      avant ? { encadre: `Date limite : <b>${dateEnClair(avant)}</b>.${rembourse ? ` ${rembourse}` : ''}` } : (rembourse || null),
    ], { texte: 'Afficher le QR code', lien });
  }
  return message(fin ? 'Comment nous rendre la tablette Papote' : 'Votre étiquette de retour Papote', [
    bonjour(nom),
    fin ? (retractation != null
      ? 'Votre commande est bien annulée. Il reste à nous renvoyer la tablette.'
      : 'Votre abonnement Papote est terminé. Merci de nous avoir fait confiance ! La tablette est prêtée : il reste à nous la renvoyer.') : null,
    `Voici l'étiquette prépayée pour nous renvoyer ${fin ? 'la tablette' : 'l\'élément à remplacer'} : vous n'avez rien à payer. Imprimez-la avec le bouton ci-dessous (un point relais peut aussi l'imprimer pour vous si vous montrez cet e-mail).`,
    { etapes: fin ? [
      CARTON_ETAPE,
      'Collez l\'étiquette dessus et déposez le colis dans n\'importe quel point relais Mondial Relay.',
    ] : [
      'Mettez l\'élément à remplacer dans un carton et collez l\'étiquette dessus.',
      'Déposez le colis dans n\'importe quel point relais Mondial Relay.',
      'Gardez la tablette : elle continue de fonctionner.',
    ] },
    fin && avant ? { encadre: `Date limite : <b>${dateEnClair(avant)}</b>.${rembourse ? ` ${rembourse}` : (montant ? ` Sans retour à cette date, ${euros(montant)} seront prélevés sur votre compte.` : '')}` } : (rembourse || null),
    fin && !rembourse && montant ? { petit: MANQUANTS } : null,
  ], { texte: 'Imprimer l\'étiquette', lien });
}

function rappelRestitution({ nom, avant, lien, qr, montant }) {
  return message('Pensez à nous rendre la tablette Papote', [
    bonjour(nom),
    'Nous n\'avons pas encore reçu la tablette.',
    { encadre: `Déposez-la dans un point relais Mondial Relay avant le <b>${dateEnClair(avant)}</b> : sans retour à cette date, ${euros(montant)} seront prélevés sur votre compte.` },
    lien ? `Votre ${qr ? 'QR code' : 'étiquette'} prépayé${qr ? '' : 'e'} est disponible avec le bouton ci-dessous.` : 'Pour obtenir le QR code prépayé :',
    lien ? null : { etapes: ETAPES_RETOUR_QR },
    { petit: 'Si vous avez déjà déposé le colis, ne tenez pas compte de ce message.' },
  ], lien ? { texte: qr ? 'Afficher le QR code' : 'Imprimer l\'étiquette', lien } : APPLI_RETOUR);
}

// rembourse : montant remboursé (centimes), 0 ou null s'il n'y a rien à rembourser.
// manquants : noms des éléments absents du colis, montant : ce qu'ils ont coûté (centimes), echec : prélèvement refusé.
function tabletteRecue({ nom, rembourse, manquants, montant, echec }) {
  const liste = manquants && manquants.length ? manquants.map(echapper).join(', ') : '';
  return message('Nous avons bien reçu la tablette', [
    bonjour(nom),
    'La tablette Papote est bien revenue chez nous. Merci !',
    liste
      ? { encadre: `Il manquait dans le colis : <b>${liste}</b>.${echec
        ? ` Le prélèvement de ${euros(montant)} prévu pour cela n'a pas abouti : nous revenons vers vous.`
        : ` Comme prévu, <b>${euros(montant)}</b> ont été prélevés sur votre compte.`}` }
      : null,
    rembourse ? `Nous venons de vous rembourser <b>${euros(rembourse)}</b> : la somme apparaît sur votre compte sous 5 à 10 jours.`
      : (liste ? 'À part cela, vous n\'avez plus rien à faire, et plus rien ne sera prélevé.' : 'Vous n\'avez plus rien à faire, et plus rien ne sera prélevé.'),
  ]);
}

// Tablette jamais rendue dans les 30 jours (restitutions) : le matériel prêté est prélevé.
function materielNonRendu({ nom, montant, avant }) {
  return message('Tablette non rendue : le matériel a été prélevé', [
    bonjour(nom),
    `Nous n'avons pas reçu la tablette Papote avant le <b>${dateEnClair(avant)}</b>, comme annoncé dans nos précédents e-mails.`,
    { encadre: `<b>${euros(montant)}</b> ont été prélevés sur votre compte pour le matériel prêté (tablette, chargeur et câble, enceinte si elle était dans le colis).` },
    'Si le colis est en route ou si vous pensez qu\'il y a une erreur, répondez à cet e-mail : nous regardons tout de suite.',
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
function annulationAvantEnvoi({ nom, email, code, commande }) {
  return message(`Commande annulée ${code || ''}`.trim(), [
    { fiche: [['Client', echapper(nom || '?')], ['E-mail', echapper(email || 'sans e-mail')]] },
    'Le client a annulé sa commande avant l\'envoi et a été remboursé automatiquement. Ne pas envoyer la tablette.',
  ], commande ? { texte: 'Ouvrir la commande', lien: lienCommandeAdmin(commande) } : null, { interne: true });
}

// Prévient Papote d'une résiliation (ou d'une commande annulée après l'envoi) : la page de la commande en lien.
function resiliation({ nom, email, code, commande, retractation, suivi, lienSuivi }) {
  const qui = nom || email || 'Un client';
  return message(`${qui} a ${retractation != null ? 'annulé sa commande' : 'résilié son abonnement'}${code ? ` (commande ${code})` : ''}`, [
    { fiche: [['Client', echapper(qui)], ['E-mail', email && nom ? echapper(email) : null], ['Commande', code ? echapper(code) : null]] },
    `Le client a ${retractation != null ? 'annulé sa commande après l\'envoi' : 'résilié son abonnement'}.`,
    lienSuivi
      ? `Le client a reçu le mode d'emploi et l'étiquette de retour. Suivi du colis de retour : <a href="${echapper(lienSuivi)}">${echapper(suivi || 'suivre le colis')}</a> (aussi sur la page de la commande).`
      : 'Le client reçoit par e-mail le mode d\'emploi du retour. Le suivi du colis apparaîtra sur la page de la commande.',
  ], { texte: 'Ouvrir la commande', lien: lienCommandeAdmin(commande) }, { interne: true });
}

// Alerte à Papote (prélèvement refusé ou contesté…), avec le lien vers la commande dans l'admin.
function alerteAdmin({ titre, detail, commande }) {
  return message(titre, [echapper(detail)], commande
    ? { texte: 'Ouvrir la commande', lien: lienCommandeAdmin(commande) } : null, { interne: true });
}

// ---------- Support du site ----------

// Le visiteur a laissé ses coordonnées au chat du site (demande de rappel) : il sait que c'est bien parti.
function rappelConfirme({ nom, telephone }) {
  return message('Bien reçu : nous vous rappelons', [
    bonjour(nom),
    `Votre demande est bien arrivée${telephone ? ` : nous vous rappelons au <b>${echapper(telephone)}</b>` : ''}, en général dans la journée (du lundi au samedi).`,
    'C\'est Tanguy, qui prépare les tablettes lui-même, qui vous appelle. Si c\'est plus simple, répondez à cet e-mail avec votre question.',
  ], { texte: 'Découvrir Papote', lien: SITE });
}

// Pour Papote : le visiteur veut être rappelé, avec la conversation du chat.
function demandeRappel({ nom, telephone, email, messages }) {
  return message(`Demande de rappel : ${[nom, telephone, email].filter(Boolean).join(' · ')}`, [
    { fiche: [['Visiteur', echapper(nom || '?')], ['Téléphone', telephone ? echapper(telephone) : null], ['E-mail', email ? echapper(email) : null]] },
    'L\'assistant n\'a pas su répondre. La conversation :',
    ...(messages || []).map((m) => `<b>${m.role === 'user' ? 'Visiteur' : 'Assistant'} :</b> ${echapper(m.content).replace(/\n/g, '<br>')}`),
  ], email ? { texte: 'Répondre par e-mail', lien: `mailto:${email}` } : null, { interne: true });
}

// Pour Papote, chaque semaine : les questions posées au chat, et celles restées sans réponse.
function bilanSupport({ questions, rappels, sansReponse }) {
  return message(`Support Papote : ${questions} questions cette semaine, ${sansReponse.length} sans réponse`, [
    { fiche: [['Questions au chat', String(questions)], ['Demandes de rappel', String(rappels)], ['Sans réponse', String(sansReponse.length)]] },
    sansReponse.length ? { section: { titre: 'Questions sans réponse', items: sansReponse.map(echapper) } } : 'Le chat a su répondre à tout.',
    'Pour que le chat sache y répondre, ajoutez la réponse dans functions/support-connaissances.md (ou donnez-la à Claude).',
  ], null, { interne: true });
}

// ---------- E-mails de l'admin ----------

// E-mail d'information (campagne) : texte saisi par l'admin (paragraphes séparés par une ligne vide), {prenom} remplacé.
function information({ objet, message: texte, nom, lienDesinscription }) {
  const prenom = nom ? String(nom).trim().split(/\s+/)[0] : '';
  const contenu = String(texte).replace(/\{prenom\}/g, prenom).replace(/ ,/g, ',');
  const paragraphes = contenu.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => echapper(p).replace(/\n/g, '<br>'));
  const m = message(String(objet).trim(), paragraphes, null, { desinscription: lienDesinscription, apercu: sansBalises(paragraphes[0] || '') });
  return { ...m, headers: { 'List-Unsubscribe': `<${lienDesinscription}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
}

// Récap du lundi pour Tanguy : lignes = [[titre, items], …] (Cette semaine, À faire, Franchise de TVA).
function recapSemaine({ lignes, aFaire }) {
  return message(aFaire ? `Papote : ${aFaire} chose${aFaire > 1 ? 's' : ''} à faire cette semaine` : 'Papote : tout est à jour',
    lignes.map(([titre, items]) => ({ section: { titre, items: items.map(echapper) } })),
    { texte: 'Ouvrir l\'espace admin', lien: ADMIN }, { interne: true, apercu: lignes[0] ? lignes[0][1].join(', ') : '' });
}

// Livres comptables du mois (fichiers joints par gestion.js) : resume = [[titre, items], …].
function livresComptables({ resume, titres }) {
  return message(`Papote : livres comptables de ${titres.join(', ')}`, [
    'Le livre des recettes et le registre des achats sont joints (fichiers à ouvrir avec Excel) et rangés dans l\'espace admin, rubrique Comptabilité. Gardez cet e-mail : ce sont les registres obligatoires de la micro-entreprise.',
    ...resume.map(([titre, items]) => ({ section: { titre, items: items.map(echapper) } })),
  ], { texte: 'Ouvrir la comptabilité', lien: `${ADMIN}#compta` }, { interne: true });
}

// Coupe-circuit de facturation Google Cloud (budget.js) : palier 'alerte' (30 €), 'avertissement' (100 €),
// 'coupure' (150 €, facturation désactivée) ; coupee = false si la coupure a échoué.
function budget({ palier, montant, paliers, coupee = true }) {
  const lien = 'https://console.cloud.google.com/billing';
  const bouton = { texte: 'Ouvrir la facturation Google Cloud', lien };
  if (palier === 'alerte') {
    return message(`Papote : la facture Google Cloud du mois atteint ${montant}`, [
      { fiche: [['Facture du mois', montant], ['Alerte', `à partir de ${paliers.alerte} €`], ['Coupure', `à ${paliers.coupure} €`]] },
      `Rien n'est coupé. Pour information, le coupe-circuit coupera tout à ${paliers.coupure} €.`,
    ], bouton, { interne: true });
  }
  if (palier === 'avertissement') {
    return message(`Attention : coupe-circuit bientôt, facture Google Cloud à ${montant}`, [
      { encadre: `Attention, la facture Google Cloud de Papote atteint <b>${montant}</b> ce mois-ci. Le coupe-circuit coupera tout à ${paliers.coupure} € : l'app famille, les tablettes et le site ne marcheront plus.` },
      'Si Papote a grandi et que c\'est normal, montez le seuil (PALIERS dans functions/budget.js et le budget dans la console). Sinon, regardez ce qui coûte.',
    ], bouton, { interne: true });
  }
  if (!coupee) {
    return message(`URGENT : facture Google Cloud à ${montant}, le coupe-circuit n'a pas pu couper`, [
      { encadre: `La facture Google Cloud de Papote a atteint <b>${montant}</b>, mais la facturation n'a pas pu être désactivée (rôle « Gestionnaire de facturation de projet » manquant ?).` },
      'Coupez-la vous-même : Facturation > Gestion des comptes > Papote > Désactiver la facturation.',
    ], bouton, { interne: true });
  }
  return message(`COUPE-CIRCUIT : facturation Google Cloud désactivée à ${montant}`, [
    { encadre: `La facture Google Cloud de Papote a atteint <b>${montant}</b> ce mois-ci : la facturation du projet a été désactivée.` },
    'Les fonctions, l\'app famille et les tablettes sont arrêtées ou limitées. Les données ne sont pas effacées.',
    { etapes: [
      'Trouvez ce qui a coûté (Rapports de facturation).',
      'Pour tout relancer : Facturation > Gestion des comptes > Papote > Associer un compte de facturation.',
    ] },
  ], bouton, { interne: true });
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
  // commande et livraison
  colisParti, tabletteRemise, commandeConfirmee, nouvelleCommande, relancePanier, listeAttenteConfirmee, lancement, rappelJumelage, sepaRefuse,
  // famille
  invitation, demandeRejoindre, demandeAcceptee, installationFinie, appelSansTelephone,
  // abonnement
  paiementEchoue, papoteEnPause, pausePrelevements, reprisePrelevements,
  // fin de contrat
  retourTablette, etiquetteRetour, rappelRestitution, tabletteRecue, materielNonRendu, commandeAnnulee, annulationAvantEnvoi, resiliation, alerteAdmin,
  // support et admin
  rappelConfirme, demandeRappel, bilanSupport, information, recapSemaine, livresComptables, budget,
  // outils
  message, envoyer, echapper, euros, dateEnClair, sansBalises,
};
