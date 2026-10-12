// Chat IA de support : répond aux questions des visiteurs du site vitrine et de l'appli famille.
//
//   supportChat  POST {messages: [{role: 'user'|'assistant', content}]} → {reponse}
//
// Les réponses s'appuient sur le texte du site vitrine (FAQ, tarifs), relu au plus une fois
// par heure : modifier le site suffit pour mettre le chat à jour. Quand l'IA ne sait pas,
// elle renvoie vers l'e-mail de support.
// Clé Anthropic dans Secret Manager (outils/support/installer-support.bat), jamais dans le dépôt.
// Garde-fous de coût : 30 questions par jour et par visiteur, 2 000 par jour au total.

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const SITE_VITRINE = defineString('SITE_VITRINE', { default: 'https://papote.web.app' });

const MODELE = 'claude-haiku-5-5';
const EMAIL_SUPPORT = 'contact@mapapote.fr';
const QUOTA_VISITEUR = 30;
const QUOTA_TOTAL = 2000;
const MAX_MESSAGES = 12;
const MAX_CARACTERES = 1000;
const ORIGINES = [
  'https://papote.web.app',
  'https://papote-famille.web.app',
  'https://mapapote.fr',
  'https://www.mapapote.fr',
];

const CONSIGNES = `Tu es l'assistant de support de Papote, une tablette pour les seniors qui affiche les photos, vidéos et messages envoyés par leur famille depuis une appli sur téléphone, avec des appels vidéo qui décrochent tout seuls. Ton proche n'a rien à faire : « zéro clic pour Mamie ».

Tu parles à des familles et à des personnes âgées, en français, avec des phrases simples et chaleureuses. Réponds en trois ou quatre phrases au plus, sans titres, sans tableaux et sans jargon technique. Vouvoie la personne.

Appuie-toi uniquement sur le contenu du site ci-dessous. Si la réponse n'y est pas, si la question concerne une commande, un paiement, une livraison ou une panne précise, ou si la personne est mécontente, dis-le simplement et invite-la à écrire à ${EMAIL_SUPPORT} en précisant son code de commande si elle en a un. N'invente jamais un prix, un délai ou une fonction. Ne demande jamais de mot de passe ni de numéro de carte bancaire. Si la question n'a rien à voir avec Papote, réponds poliment que tu ne peux aider que sur Papote.`;

let client;
let site = { texte: '', lu: 0 };

// Texte du site vitrine, sans balises, gardé une heure en mémoire.
async function texteDuSite() {
  if (site.texte && Date.now() - site.lu < 3600e3) return site.texte;
  try {
    const html = await (await fetch(SITE_VITRINE.value() + '/')).text();
    const principal = (html.match(/<main[\s\S]*<\/main>/i) || [html])[0];
    const texte = principal
      .replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|h\d|li|summary|details|section|div)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'")
      .replace(/&euro;/g, '€').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
      .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    site = { texte, lu: Date.now() };
  } catch (e) {
    logger.warn('Site vitrine illisible, ancien texte gardé', e);
  }
  return site.texte;
}

// Conversation envoyée par la page : rôles alternés, commence et finit par l'utilisateur.
function nettoyer(messages) {
  if (!Array.isArray(messages)) return null;
  const liste = messages.slice(-MAX_MESSAGES)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_CARACTERES) }))
    .filter((m) => m.content);
  while (liste.length && liste[0].role !== 'user') liste.shift();
  if (!liste.length || liste[liste.length - 1].role !== 'user') return null;
  for (let i = 1; i < liste.length; i++) if (liste[i].role === liste[i - 1].role) return null;
  return liste;
}

// Compte une question ; false si le visiteur ou l'ensemble a dépassé son quota du jour.
async function quotaOk(ip) {
  const jour = new Date().toISOString().slice(0, 10);
  const visiteur = crypto.createHash('sha256').update(jour + ip).digest('hex').slice(0, 24);
  const db = admin.firestore();
  const refVisiteur = db.doc(`supportQuota/${jour}/visiteurs/${visiteur}`);
  const refJour = db.doc(`supportQuota/${jour}`);
  return db.runTransaction(async (t) => {
    const [v, j] = await Promise.all([t.get(refVisiteur), t.get(refJour)]);
    const nV = (v.get('n') || 0) + 1;
    const nJ = (j.get('n') || 0) + 1;
    if (nV > QUOTA_VISITEUR || nJ > QUOTA_TOTAL) return false;
    t.set(refVisiteur, { n: nV });
    t.set(refJour, { n: nJ, expire: new Date(Date.now() + 7 * 86400e3) });
    return true;
  });
}

exports.supportChat = onRequest(
  { secrets: [ANTHROPIC_API_KEY], cors: ORIGINES, maxInstances: 3, timeoutSeconds: 60 },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });
    const messages = nettoyer(req.body && req.body.messages);
    if (!messages) return res.status(400).json({ erreur: 'Conversation invalide' });

    if (!(await quotaOk(String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'inconnu'))) {
      return res.json({
        reponse: `Je ne peux plus répondre aujourd'hui. Écrivez-nous à ${EMAIL_SUPPORT}, nous vous répondrons rapidement.`,
      });
    }

    try {
      if (!client) client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const texte = await texteDuSite();
      const reponse = await client.messages.create({
        model: MODELE,
        max_tokens: 1024,
        output_config: { effort: 'low' },
        system: [
          { type: 'text', text: CONSIGNES },
          { type: 'text', text: `Contenu du site Papote :\n\n${texte}`, cache_control: { type: 'ephemeral' } },
        ],
        messages,
      });
      const texteReponse = reponse.stop_reason === 'refusal' ? ''
        : reponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      res.json({
        reponse: texteReponse || `Je ne sais pas répondre à cela. Écrivez-nous à ${EMAIL_SUPPORT}.`,
      });
    } catch (e) {
      logger.error('supportChat', e);
      res.status(502).json({
        reponse: `Je suis indisponible pour le moment. Écrivez-nous à ${EMAIL_SUPPORT}.`,
      });
    }
  });

exports._test = { nettoyer };
