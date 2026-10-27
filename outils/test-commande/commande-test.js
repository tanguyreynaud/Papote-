// Commande de bout en bout sur le site EN LIGNE, avec un vrai navigateur (Playwright) et les cartes de test Stripe.
// À relancer avant chaque publication du site ou des fonctions (Stripe en clé de TEST seulement).
//
//   node commande-test.js                : tous les scénarios, puis vérifications et nettoyage
//   node commande-test.js telephone-carte refus : seulement ces scénarios
//   node commande-test.js --garder        : ne supprime pas les commandes TEST à la fin
//   node commande-test.js --nettoyer      : supprime seulement les commandes TEST restantes
//   node commande-test.js --voir          : navigateur visible
//
// Scénarios : telephone-carte (390 px, 4242), ordinateur-carte (1280 px, formule internet incluse, 4242),
// sepa (IBAN de test), refus (carte 4000 0000 0000 0002 refusée), retour (lien retour de Stripe puis
// bouton Retour du navigateur : la commande est gardée).
// Vérifié pour chaque commande payée : merci.html et son code, commandes/{abonnement} dans Firestore (ce que
// lit l'admin), abonnement Stripe en période d'essai, réservation de stock libérée, e-mail de confirmation parti.
//
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
// Clé Stripe : variable STRIPE_SECRET, sinon lue avec « firebase functions:secrets:access ». Refusée si ce n'est
// pas une clé de test (sk_test_). Les commandes portent « TEST » dans le nom et un e-mail +papote-test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { chromium, devices } = require('playwright');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

const SITE = process.env.PAPOTE_SITE || 'https://mapapote.fr';
// Boîte qui reçoit les e-mails des commandes TEST (adresse + « +papote-test-… ») : variable PAPOTE_TEST_EMAIL
// (une adresse personnelle, jamais écrite ici : le dépôt est public), sinon la boîte de Papote.
const BOITE = process.env.PAPOTE_TEST_EMAIL || 'contact@mapapote.fr';
const CP = process.env.PAPOTE_TEST_CP || '69001';
const MARQUE = '+papote-test';
const CAPTURES = path.join(__dirname, 'captures');

const args = process.argv.slice(2);
const options = new Set(args.filter((a) => a.startsWith('--')));
const choisis = args.filter((a) => !a.startsWith('--'));
const horodatage = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '');

const bilan = [];
function noter(scenario, ok, detail) {
  bilan.push({ scenario, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${scenario} : ${detail}`);
}
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const emailDe = (nom) => BOITE.replace('@', `${MARQUE}-${nom}-${horodatage}@`);

// ---------- Firebase et Stripe ----------

const cle = process.env.PAPOTE_CLE_ADMIN || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
if (!fs.existsSync(cle)) {
  console.error(`Clé admin introuvable : ${cle}`);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(require(cle)) });

async function base() {
  let nom = process.env.PAPOTE_BASE;
  if (!nom) {
    const config = await getFirestore().doc('config/base').get();
    nom = (config.exists && config.get('database')) || '(default)';
  }
  return getFirestore(nom);
}

function cleStripe() {
  let k = process.env.STRIPE_SECRET;
  if (!k) {
    try {
      k = execSync('firebase functions:secrets:access STRIPE_SECRET --project papote-famille',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true }).trim();
    } catch (_) { k = ''; }
  }
  if (k && !k.startsWith('sk_test_')) {
    console.error('La clé Stripe n\'est PAS une clé de test : arrêt, aucune commande passée.');
    process.exit(1);
  }
  return k ? require('stripe')(k) : null;
}

// ---------- Gestes sur le site ----------

async function remplirCommande(page, { nom, email, sansInternet }) {
  await page.goto(`${SITE}/commande.html`, { waitUntil: 'domcontentloaded' });
  if (sansInternet) await page.locator('input[name="internet"][value="non"]').check();
  await page.locator('#cp').fill(CP);
  const point = page.locator('#points .point').first();
  await point.waitFor({ timeout: 20000 });
  await point.click();
  await page.locator('#destinataire').fill(nom);
  await page.locator('#email').fill(email);
  // Pas de défilement horizontal à largeur téléphone (bug du 27/10).
  const large = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (large > 1) throw new Error(`la page déborde de ${large} px en largeur`);
  await page.waitForFunction(() => document.getElementById('payer').getAttribute('aria-disabled') === 'false');
  await Promise.all([
    page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 }),
    page.locator('#payer').click(),
  ]);
  if (!/cs_test_/.test(page.url())) throw new Error('page de paiement qui n\'est pas en mode test : arrêt');
}

// Les champs de la page Stripe Checkout (remplis seulement s'ils sont là).
async function siVisible(page, selecteur, valeur) {
  const champ = page.locator(selecteur).first();
  if (!(await champ.isVisible().catch(() => false))) return false;
  if (await champ.isEditable().catch(() => false)) await champ.fill(valeur);
  return true;
}

async function moyen(page, type) {
  // Le <button> de l'accordéon est masqué (0×0) : on clique la ligne entière.
  const bouton = page.locator(`[data-testid="${type}-accordion-item"]`).first();
  await bouton.waitFor({ timeout: 30000 });
  await bouton.click();
}

async function payerCarte(page, numero) {
  await moyen(page, 'card');
  await page.locator('#cardNumber').fill(numero);
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  await siVisible(page, '#billingName', 'TEST Automatique');
  await siVisible(page, '#billingPostalCode', CP);
  await siVisible(page, '#phoneNumber', '06 12 34 56 78');
  await sansLink(page);
  await page.locator('[data-testid="hosted-payment-submit-button"], .SubmitButton').first().click();
}

async function payerSepa(page) {
  await moyen(page, 'sepa_debit');
  await page.locator('#iban').fill('FR1420041010050500013M02606');
  await siVisible(page, '#billingName', 'TEST Automatique');
  await siVisible(page, '#billingAddressLine1', '1 rue de la République');
  await siVisible(page, '#billingPostalCode', CP);
  await siVisible(page, '#billingLocality', 'Lyon');
  await siVisible(page, '#phoneNumber', '06 12 34 56 78');
  await sansLink(page);
  await page.locator('[data-testid="hosted-payment-submit-button"], .SubmitButton').first().click();
}

// « Enregistrer mes infos avec Link » : décoché, pour ne rien créer chez Link.
async function sansLink(page) {
  const link = page.locator('#enableStripePass');
  if (await link.isChecked().catch(() => false)) await link.uncheck({ force: true }).catch(() => null);
}

async function merci(page, scenario) {
  const reponses = [];
  page.on('response', async (r) => {
    if (/codeCommande/.test(r.url())) reponses.push(`${r.status()} ${(await r.text().catch(() => '')).slice(0, 80)}`);
  });
  await page.waitForURL(/merci\.html/, { timeout: 60000 });
  // #code-valeur existe vide dès le chargement (et .code reste affiché malgré hidden) : attendre que la page
  // l'ait rempli avec la réponse de codeCommande.
  await page.waitForFunction(() => document.getElementById('code-valeur').textContent.trim() !== '', null, { timeout: 30000 })
    .catch(() => null);
  const code = (await page.locator('#code-valeur').textContent().catch(() => '')).trim();
  const session = new URL(page.url()).searchParams.get('session');
  noter(scenario, !!code, code ? `merci.html affiche le code ${code}`
    : `merci.html sans code de commande (codeCommande : ${reponses.join(' | ') || 'pas appelé'}, adresse ${page.url().slice(0, 70)})`);
  if (!code) await page.screenshot({ path: path.join(CAPTURES, `${scenario}-merci-${Date.now()}.png`), fullPage: true }).catch(() => null);
  return { session, code };
}

// ---------- Vérifications serveur ----------

async function verifierCommande(db, stripe, scenario, email, { sepa } = {}) {
  let doc = null;
  for (let i = 0; i < 30 && !doc; i++) {
    const r = await db.collection('commandes').where('email', '==', email).get();
    doc = r.docs.find((d) => d.get('mailConfirmation') || (sepa && d.get('expedition'))) || null;
    if (!doc) await attendre(3000);
  }
  if (!doc) { noter(scenario, false, 'aucune commande dans Firestore après 90 s (webhook ?)'); return null; }
  const c = doc.data();
  const attendu = sepa ? ['paiement-en-attente', 'a-preparer'] : ['a-preparer'];
  noter(scenario, attendu.includes(c.expedition),
    `commande ${doc.id} (code ${c.code}) : ${c.expedition}, relais ${c.livraison && (c.livraison.nom || c.livraison.relais) ? 'OK' : 'ABSENT'}, téléphone ${c.telephone ? 'OK' : 'absent'}, formule ${c.formule}`);
  if (!sepa) noter(scenario, !!c.mailConfirmation, c.mailConfirmation ? 'e-mails de confirmation envoyés (client + Papote)' : 'e-mail de confirmation pas envoyé');
  if (stripe) {
    const abo = await stripe.subscriptions.retrieve(doc.id);
    noter(scenario, abo.status === 'trialing', `abonnement Stripe ${abo.status}, ${abo.items.data.map((i) => `${i.price.unit_amount / 100} €`).join(' + ')}/mois`);
    const resa = abo.metadata && abo.metadata.reservation;
    if (resa) {
      const r = await db.doc(`reservations/${resa}`).get();
      noter(scenario, !r.exists, r.exists ? `réservation ${resa} toujours là` : 'réservation de stock libérée');
    }
  }
  return doc.id;
}

// ---------- Scénarios ----------

const TELEPHONE = { ...devices['iPhone 13'], locale: 'fr-FR' };
const ORDINATEUR = { viewport: { width: 1280, height: 800 }, locale: 'fr-FR' };
const TELEPHONE_LARGEUR = { viewport: { width: 390, height: 800 }, locale: 'fr-FR' };

const SCENARIOS = {
  'telephone-carte': async (navigateur, db, stripe) => {
    const page = await (await navigateur.newContext(TELEPHONE)).newPage();
    const email = emailDe('tel');
    await remplirCommande(page, { nom: 'TEST Téléphone', email });
    await payerCarte(page, '4242424242424242');
    await merci(page, 'telephone-carte');
    await verifierCommande(db, stripe, 'telephone-carte', email);
  },
  'ordinateur-carte': async (navigateur, db, stripe) => {
    const page = await (await navigateur.newContext(ORDINATEUR)).newPage();
    const email = emailDe('pc');
    await remplirCommande(page, { nom: 'TEST Ordinateur', email, sansInternet: true });
    await payerCarte(page, '4242424242424242');
    await merci(page, 'ordinateur-carte');
    await verifierCommande(db, stripe, 'ordinateur-carte', email);
  },
  sepa: async (navigateur, db, stripe) => {
    const page = await (await navigateur.newContext(ORDINATEUR)).newPage();
    const email = emailDe('sepa');
    await remplirCommande(page, { nom: 'TEST Sepa', email });
    await payerSepa(page);
    await merci(page, 'sepa');
    await verifierCommande(db, stripe, 'sepa', email, { sepa: true });
  },
  refus: async (navigateur, db) => {
    const page = await (await navigateur.newContext(TELEPHONE)).newPage();
    const email = emailDe('refus');
    await remplirCommande(page, { nom: 'TEST Refus', email });
    await payerCarte(page, '4000000000000002');
    const erreur = page.getByText(/refusée|declined/i).first();
    const vu = await erreur.waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    noter('refus', vu && /checkout\.stripe\.com/.test(page.url()),
      vu ? `Stripe affiche « ${(await erreur.textContent()).trim()} » et reste sur le paiement` : 'aucun message de refus visible');
    await attendre(5000);
    const r = await db.collection('commandes').where('email', '==', email).get();
    noter('refus', r.empty, r.empty ? 'aucune commande créée' : `${r.size} commande(s) créée(s) malgré le refus`);
  },
  retour: async (navigateur) => {
    const contexte = await navigateur.newContext(TELEPHONE);
    const page = await contexte.newPage();
    const email = emailDe('retour');
    await remplirCommande(page, { nom: 'TEST Retour', email });
    // Lien « ← » de la page Stripe (cancel_url).
    await page.locator('[data-testid="business-link"], a[href*="commande.html"]').first().click();
    await page.waitForURL(/commande\.html/, { timeout: 30000 });
    await verifierReprise(page, 'retour (lien Stripe)', email);
    // Chromium sans écran rend cet onglet revenu de Stripe avec innerWidth = 0 (défaut de l'émulateur, pas du
    // site) : plus rien n'y est cliquable. Bouton Retour du navigateur testé dans un nouvel onglet (la commande
    // gardée est propre à chaque onglet : on la remplit à nouveau).
    const onglet = await contexte.newPage();
    await remplirCommande(onglet, { nom: 'TEST Retour', email });
    await onglet.goBack({ waitUntil: 'commit' });
    await onglet.waitForURL(/commande\.html/, { timeout: 30000, waitUntil: 'commit' });
    await verifierReprise(onglet, 'retour (navigateur)', email);
  },
};

async function verifierReprise(page, scenario, email) {
  await page.waitForTimeout(1500);
  const etat = await page.evaluate(() => ({
    email: document.getElementById('email').value,
    relais: !document.getElementById('ok2').hidden,
    bouton: document.getElementById('payer').textContent.trim(),
    actif: document.getElementById('payer').getAttribute('aria-disabled') === 'false',
  }));
  const ok = etat.email === email && etat.relais && etat.actif && /Payer/.test(etat.bouton);
  noter(scenario, ok, ok ? 'commande gardée, bouton « Payer 60 € » prêt'
    : `e-mail ${etat.email === email ? 'gardé' : 'perdu'}, relais ${etat.relais ? 'gardé' : 'perdu'}, bouton « ${etat.bouton} »`);
}

// ---------- Nettoyage ----------

// Commandes TEST (e-mail +papote-test) : abonnement Stripe annulé, client supprimé, documents effacés.
async function nettoyer(db, stripe) {
  const tout = await db.collection('commandes').get();
  const tests = tout.docs.filter((d) => String(d.get('email') || '').includes(MARQUE));
  for (const d of tests) {
    const c = d.data();
    if (stripe && c.stripeCustomerId) {
      // Supprimer le client annule aussi ses abonnements (sans « dernier mois » : pas une résiliation).
      await stripe.customers.del(c.stripeCustomerId).catch((e) => console.log(`    Stripe ${c.stripeCustomerId} : ${e.message}`));
    }
    console.log(`  supprimée : ${d.id} ${c.code || ''} ${c.nom || ''} <${c.email}>`);
  }
  if (tests.length && stripe) await attendre(8000); // laisser passer les webhooks avant d'effacer
  for (const d of tests) {
    await d.ref.delete();
  }
  // Paniers des scénarios sans paiement (refus, retour) et réservations restées ouvertes pendant le test.
  const paniers = await db.collection('paniers').get();
  for (const p of paniers.docs) if (String(p.get('email') || '').includes(MARQUE)) await p.ref.delete();
  // Pages Stripe TEST restées ouvertes (refus, retour, essais interrompus) : expirées, et leur tablette mise
  // de côté rendue au stock. Seulement les pages au nom d'un e-mail +papote-test des 24 dernières heures.
  let resas = 0;
  if (stripe) {
    const depuis = Math.floor(Date.now() / 1000) - 24 * 3600;
    for await (const s of stripe.checkout.sessions.list({ status: 'open', limit: 100, created: { gte: depuis } })) {
      if (!String(s.customer_email || '').includes(MARQUE)) continue;
      await stripe.checkout.sessions.expire(s.id).catch(() => null);
      const resa = s.metadata && s.metadata.reservation;
      if (resa && /^[A-Za-z0-9]{10,40}$/.test(resa)) { await db.doc(`reservations/${resa}`).delete(); resas++; }
    }
  }
  console.log(`  ${tests.length} commande(s) TEST supprimée(s), ${resas} page(s) de paiement TEST fermée(s) et leur réservation rendue.`);
  if (!stripe) console.log('  Sans clé Stripe : clients et abonnements de test laissés dans Stripe (mode test).');
}

// ---------- Lancement ----------

(async () => {
  const db = await base();
  const stripe = cleStripe();
  if (!stripe) console.log('Clé Stripe de test non lue : abonnements non vérifiés.');
  if (options.has('--nettoyer')) { await nettoyer(db, stripe); process.exit(0); }
  fs.mkdirSync(CAPTURES, { recursive: true });
  const navigateur = await chromium.launch({ headless: !options.has('--voir') });
  const noms = choisis.length ? choisis : Object.keys(SCENARIOS);
  for (const nom of noms) {
    if (!SCENARIOS[nom]) { console.error(`Scénario inconnu : ${nom}`); continue; }
    console.log(`\n${nom}`);
    try {
      await SCENARIOS[nom](navigateur, db, stripe);
    } catch (e) {
      noter(nom, false, e.message.split('\n')[0]);
      for (const ctx of navigateur.contexts()) {
        for (const p of ctx.pages()) await p.screenshot({ path: path.join(CAPTURES, `${nom}-${Date.now()}.png`), fullPage: true }).catch(() => null);
      }
    }
    for (const ctx of navigateur.contexts()) await ctx.close();
  }
  await navigateur.close();
  console.log('\nNettoyage');
  if (options.has('--garder')) console.log('  --garder : commandes TEST laissées (node commande-test.js --nettoyer pour les supprimer).');
  else await nettoyer(db, stripe);
  const ko = bilan.filter((b) => !b.ok);
  console.log(`\n${ko.length ? `${ko.length} problème(s)` : 'Tout est bon ✓'} (${bilan.length} vérifications). Captures des échecs : ${CAPTURES}`);
  process.exit(ko.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
