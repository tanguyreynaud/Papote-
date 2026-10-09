// E-mails envoyés aux clients (colis parti, rappels de jumelage), par SMTP.
// Gmail au départ (mot de passe d'application) ; Brevo plus tard en changeant MAIL_SMTP dans .env.
// Mot de passe dans Secret Manager (MAIL_MOT_DE_PASSE), jamais dans le dépôt.

const nodemailer = require('nodemailer');

const APPLI = 'https://papote-famille.web.app';
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

module.exports = { colisParti, rappelJumelage, envoyer, echapper };
