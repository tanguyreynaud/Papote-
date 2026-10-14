// E-mails envoyés aux clients (colis parti, rappels de jumelage), par SMTP.
// Gmail au départ (mot de passe d'application) ; Brevo plus tard en changeant MAIL_SMTP dans .env.
// Mot de passe dans Secret Manager (MAIL_MOT_DE_PASSE), jamais dans le dépôt.

const nodemailer = require('nodemailer');

const APPLI = 'https://app.mapapote.fr';
// Lien vers l'appli qui garde le code de commande : la famille créée s'y rattache toute seule.
const lienAppli = (code) => (code ? `${APPLI}/?commande=${encodeURIComponent(code)}` : APPLI);

function echapper(t) {
  return String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Mise en page commune, aux couleurs du site.
function page(titre, paragraphes, bouton) {
  const corps = paragraphes.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join('');
  const btn = bouton
    ? `<p style="margin:24px 0"><a href="${echapper(bouton.lien)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:999px">${echapper(bouton.texte)}</a></p>`
    : '';
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#fdfaf5;color:#24212f;font:17px/1.6 Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
<p style="margin:0 0 24px;font-weight:bold;font-size:20px;color:#4f46e5">Papote</p>
<h1 style="margin:0 0 20px;font-size:26px;line-height:1.2">${echapper(titre)}</h1>
${corps}${btn}
<p style="margin:32px 0 0;font-size:14px;color:#5f5a6b">Une question ? Répondez simplement à cet e-mail.</p>
</div></body></html>`;
}

function texteBrut(titre, paragraphes, bouton) {
  const sansBalises = (h) => h.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  return [titre, '', ...paragraphes.map(sansBalises), bouton ? `${bouton.texte} : ${bouton.lien}` : '', '',
    'Une question ? Répondez simplement à cet e-mail.'].join('\n');
}

function message(titre, paragraphes, bouton) {
  return { subject: titre, html: page(titre, paragraphes, bouton), text: texteBrut(titre, paragraphes, bouton) };
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
    `À son arrivée : branchez la tablette, donnez-lui un nom, puis <a href="${echapper(lienAppli(code))}" style="color:#4f46e5">ouvrez l'appli Papote</a> sur votre téléphone avec la même adresse e-mail que pour la commande, et scannez le QR code affiché sur la tablette.`,
    code ? `Si vous utilisez une autre adresse e-mail, votre code de commande est <b>${echapper(code)}</b>.` : '',
  ].filter(Boolean), { texte: 'Suivre mon colis', lien });
}

function commandeConfirmee({ nom, code, relais, formule }) {
  return message('Votre commande Papote est confirmée', [
    `Bonjour${nom ? ` ${echapper(nom)}` : ''},`,
    'Merci pour votre commande ! Nous préparons votre tablette à la main et vous prévenons par e-mail dès qu\'elle part.',
    relais && relais.transporteur
      ? `Livraison offerte au point relais <b>${relaisEnTexte(relais)}</b>${relais.destinataire ? `, à retirer par <b>${echapper(relais.destinataire)}</b>` : ''}.`
      : 'Livraison offerte à l\'adresse indiquée.',
    `Votre abonnement : ${formule === 'sim' ? '30 € par mois, internet inclus' : '20 € par mois'}, après vos 15 jours d'essai gratuit. La tablette est prêtée et configurée.`,
    code ? `Votre code de commande : <b>${echapper(code)}</b>.` : '',
  ].filter(Boolean));
}

// Prévient Papote qu'une tablette est à préparer.
function nouvelleCommande({ nom, email, telephone, code, relais, formule }) {
  return message(`Nouvelle commande ${code || ''}`.trim(), [
    `Client : <b>${echapper(nom || '?')}</b>, ${echapper(email || 'sans e-mail')}${telephone ? `, ${echapper(telephone)}` : ''}.`,
    `Formule : ${formule === 'sim' ? '30 € par mois, internet inclus (SIM)' : '20 € par mois (wifi)'}.`,
    relais && relais.transporteur
      ? `Point relais : <b>${relaisEnTexte(relais)}</b> (n° ${echapper(relais.id)}). Retrait par : <b>${echapper(relais.destinataire || nom || '?')}</b>.`
      : `Livraison : ${relaisEnTexte(relais) || 'adresse non trouvée, voir Stripe'}.`,
    'Tablette à préparer, puis à marquer « envoyée » dans le tableau de bord.',
  ]);
}

function rappelJumelage({ nom, numero, code }) {
  const titre = numero === 1 ? 'Votre tablette Papote vous attend' : 'Besoin d\'un coup de main avec Papote ?';
  return message(titre, [
    `Bonjour${nom ? ` ${echapper(nom)}` : ''},`,
    numero === 1
      ? 'Votre tablette Papote devrait être arrivée au point relais, mais elle n\'est pas encore reliée à votre famille. Cela prend deux minutes :'
      : 'Votre tablette Papote n\'est toujours pas reliée à votre famille. Si quelque chose bloque, répondez à cet e-mail : nous vous aidons.',
    '1. Branchez la tablette et donnez-lui un nom.<br>2. Ouvrez l\'appli Papote sur votre téléphone, avec la même adresse e-mail que pour la commande.<br>3. Scannez le QR code affiché sur la tablette.',
    code ? `Avec une autre adresse e-mail, touchez « J'ai déjà payé sur le site » et tapez votre code de commande : <b>${echapper(code)}</b>.` : '',
    'Rappel : vos 15 jours d\'essai gratuit ont commencé à la commande.',
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
const COMMENT_RENDRE = 'Mettez la tablette et son chargeur dans un carton, collez l\'étiquette dessus et déposez le colis dans n\'importe quel point relais Mondial Relay. Inutile de l\'effacer : nous nous en chargeons.';

// Abonnement terminé ou commande annulée après l'envoi : la tablette prêtée est attendue.
// retractation : montant remboursé au retour (centimes), sinon null.
function retourTablette({ nom, avant, retractation }) {
  return message('Comment nous rendre la tablette Papote', [
    bonjour(nom),
    retractation != null
      ? 'Votre commande est bien annulée. Il reste à nous renvoyer la tablette.'
      : 'Votre abonnement Papote est terminé. Merci de nous avoir fait confiance ! La tablette est prêtée : il reste à nous la renvoyer.',
    'Nous vous envoyons par e-mail, sous deux jours ouvrés, une étiquette de retour prépayée : vous n\'avez rien à payer.',
    `${COMMENT_RENDRE} Date limite : <b>${dateEnClair(avant)}</b>.`,
    retractation != null && retractation > 0
      ? `Dès que la tablette nous parvient, nous vous remboursons <b>${euros(retractation)}</b> sur votre carte.`
      : 'Sans retour à cette date, 120 € seront prélevés sur votre carte.',
  ]);
}

function etiquetteRetour({ nom, lien, avant }) {
  return message('Votre étiquette de retour Papote', [
    bonjour(nom),
    'Voici l\'étiquette prépayée pour nous renvoyer la tablette. Imprimez-la avec le bouton ci-dessous (un point relais peut aussi l\'imprimer pour vous si vous montrez cet e-mail).',
    `${COMMENT_RENDRE}${avant ? ` Date limite : <b>${dateEnClair(avant)}</b>.` : ''}`,
  ], { texte: 'Imprimer l\'étiquette', lien });
}

function rappelRestitution({ nom, avant, lien }) {
  return message('Pensez à nous rendre la tablette Papote', [
    bonjour(nom),
    `Nous n'avons pas encore reçu la tablette. Déposez-la dans un point relais Mondial Relay avant le <b>${dateEnClair(avant)}</b> : sans retour à cette date, 120 € seront prélevés sur votre carte.`,
    lien ? 'Votre étiquette prépayée est disponible avec le bouton ci-dessous.' : 'Vous n\'avez pas reçu l\'étiquette de retour ? Répondez à cet e-mail : nous vous la renvoyons.',
    'Si vous avez déjà déposé le colis, ne tenez pas compte de ce message.',
  ], lien ? { texte: 'Imprimer l\'étiquette', lien } : undefined);
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
  ]);
}

// Prévient Papote qu'une étiquette de retour est à créer.
function retourAPreparer({ nom, email, telephone, code, relais, avant, retractation }) {
  return message(`Retour à préparer ${code || ''}`.trim(), [
    `Client : <b>${echapper(nom || '?')}</b>, ${echapper(email || 'sans e-mail')}${telephone ? `, ${echapper(telephone)}` : ''}.`,
    retractation != null ? `Rétractation : ${euros(retractation)} à rembourser au retour (automatique).` : 'Fin d\'abonnement.',
    relais && relais.transporteur ? `Point relais d'origine : ${relaisEnTexte(relais)}.` : '',
    `Tablette attendue avant le ${dateEnClair(avant)}. Créez l'étiquette de retour prépayée, puis collez son lien dans le tableau de bord (« Étiquette de retour »).`,
  ].filter(Boolean));
}

// smtp : « hote:port:utilisateur » (MAIL_SMTP), expediteur : adresse affichée (MAIL_EXPEDITEUR).
let transport;
async function envoyer({ smtp, motDePasse, expediteur, a, contenu }) {
  if (!motDePasse || !expediteur) throw new Error('E-mails non configurés (MAIL_EXPEDITEUR, MAIL_MOT_DE_PASSE).');
  if (!transport) {
    const [hote, port, utilisateur] = smtp.split(':');
    transport = nodemailer.createTransport({
      host: hote, port: Number(port), secure: Number(port) === 465,
      auth: { user: utilisateur || expediteur, pass: motDePasse },
    });
  }
  await transport.sendMail({ from: `Papote <${expediteur}>`, replyTo: expediteur, to: a, ...contenu });
}

module.exports = {
  colisParti, commandeConfirmee, nouvelleCommande, rappelJumelage,
  retourTablette, etiquetteRetour, rappelRestitution, tabletteRecue, commandeAnnulee, annulationAvantEnvoi, retourAPreparer,
  envoyer, echapper, euros,
};
