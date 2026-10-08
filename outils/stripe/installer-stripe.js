// Prépare le compte Stripe de Papote et range les clés dans Firebase (Secret Manager).
//
//  1. Tarifs : 20 €, 25 €, 30 €, 35 € par mois et la tablette à 100 €, retrouvés par
//     les fonctions grâce à leur « lookup key » (functions/abonnement.js).
//  2. Portail client : carte bancaire et factures (la résiliation passe par l'appli famille).
//  3. Webhook vers la fonction stripeWebhook (recréé à chaque lancement pour obtenir son secret).
//  4. firebase functions:secrets:set STRIPE_SECRET et STRIPE_WEBHOOK_SECRET.
//
// La clé secrète est demandée au clavier (ou variable STRIPE_SECRET) et n'est jamais écrite
// dans le dépôt. Commencez avec la clé de test (sk_test_...), puis relancez avec sk_live_...
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const Stripe = require('stripe');

const PROJET = 'papote-famille';
const URL_WEBHOOK = `https://europe-west1-${PROJET}.cloudfunctions.net/stripeWebhook`;
const EVENEMENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
];

const PRODUITS = [
  {
    nom: 'Papote Wifi',
    description: 'Tablette Papote reliée en wifi, appli famille illimitée.',
    tarifs: [
      { cle: 'papote_wifi_achetee', montant: 2000, nom: 'Tablette achetée' },
      { cle: 'papote_wifi_incluse', montant: 2500, nom: 'Tablette incluse' },
    ],
  },
  {
    nom: 'Papote partout (wifi + carte SIM)',
    description: 'Tablette Papote avec carte SIM, sans box internet.',
    tarifs: [
      { cle: 'papote_sim_achetee', montant: 3000, nom: 'Tablette achetée' },
      { cle: 'papote_sim_incluse', montant: 3500, nom: 'Tablette incluse' },
    ],
  },
  {
    nom: 'Tablette Papote',
    description: 'Tablette prête à brancher, achetée une fois.',
    tarifs: [{ cle: 'papote_tablette', montant: 10000, nom: 'Achat', unique: true }],
  },
];

function demander(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((ok) => rl.question(question, (r) => { rl.close(); ok(r.trim()); }));
}

async function tarifs(stripe) {
  const cles = PRODUITS.flatMap((p) => p.tarifs.map((t) => t.cle));
  const { data } = await stripe.prices.list({ lookup_keys: cles, active: true, limit: 20 });
  const existants = new Set(data.map((p) => p.lookup_key));
  for (const produit of PRODUITS) {
    const manquants = produit.tarifs.filter((t) => !existants.has(t.cle));
    if (!manquants.length) {
      console.log(`  ${produit.nom} : déjà prêt`);
      continue;
    }
    const prod = await stripe.products.create({ name: produit.nom, description: produit.description });
    for (const t of manquants) {
      await stripe.prices.create({
        product: prod.id,
        currency: 'eur',
        unit_amount: t.montant,
        nickname: t.nom,
        lookup_key: t.cle,
        ...(t.unique ? {} : { recurring: { interval: 'month' } }),
      });
    }
    console.log(`  ${produit.nom} : créé`);
  }
}

async function portail(stripe) {
  const { data } = await stripe.billingPortal.configurations.list({ active: true, limit: 20 });
  if (data.some((c) => c.metadata && c.metadata.papote === '1')) {
    console.log('  Portail client : déjà prêt');
    return;
  }
  await stripe.billingPortal.configurations.create({
    metadata: { papote: '1' },
    business_profile: { headline: 'Papote : votre abonnement' },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ['email', 'address', 'phone'] },
      // Résiliation depuis l'appli famille (fonction resilierAbonnement), qui respecte l'engagement.
      subscription_cancel: { enabled: false },
    },
  });
  console.log('  Portail client : créé');
}

async function webhook(stripe) {
  const { data } = await stripe.webhookEndpoints.list({ limit: 100 });
  for (const ancien of data.filter((w) => w.url === URL_WEBHOOK)) {
    await stripe.webhookEndpoints.del(ancien.id);
  }
  const w = await stripe.webhookEndpoints.create({
    url: URL_WEBHOOK,
    enabled_events: EVENEMENTS,
    description: 'Papote : abonnements des familles',
  });
  console.log('  Webhook : prêt');
  return w.secret;
}

function secretFirebase(nom, valeur) {
  const fichier = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papote-')), 'secret.txt');
  fs.writeFileSync(fichier, valeur, { mode: 0o600 });
  try {
    execSync(`firebase functions:secrets:set ${nom} --project ${PROJET} --data-file "${fichier}" --force`,
      { stdio: 'inherit' });
  } finally {
    fs.rmSync(path.dirname(fichier), { recursive: true, force: true });
  }
}

(async () => {
  const saisie = process.env.STRIPE_SECRET
    || await demander('Clé secrète Stripe (Développeurs > Clés API, sk_test_... ou sk_live_...) : ');
  // Un collage dans la fenêtre Windows peut ajouter des caractères invisibles ou des guillemets.
  const trouvee = String(saisie).match(/(sk|rk)_(test|live)_[A-Za-z0-9]+/);
  if (!trouvee) {
    const debut = String(saisie).replace(/[^\x20-\x7e]/g, '?').trim().slice(0, 3);
    console.error(`Ce n'est pas une clé secrète Stripe (reçu « ${debut}… », ${String(saisie).length} caractères).`);
    console.error('La clé secrète commence par sk_test_ (mode test) ; la clé publique pk_ ne convient pas.');
    process.exit(1);
  }
  const cle = trouvee[0];
  const stripe = new Stripe(cle);
  console.log(cle.includes('_live_') ? 'Mode réel (paiements encaissés)' : 'Mode test (aucun paiement réel)');
  await tarifs(stripe);
  await portail(stripe);
  const secretWebhook = await webhook(stripe);
  console.log('Enregistrement des clés dans Firebase...');
  secretFirebase('STRIPE_SECRET', cle);
  secretFirebase('STRIPE_WEBHOOK_SECRET', secretWebhook);
  console.log('Terminé. Déployez ensuite les fonctions : firebase deploy --only functions');
})().catch((e) => {
  console.error('Erreur :', e.message);
  process.exit(1);
});
