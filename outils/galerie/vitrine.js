// Écrans du site vitrine (vitrine/, publié depuis origin/main) sur un téléphone et un ordinateur.
// Les services extérieurs (fonctions Papote, points relais Sendcloud, codes postaux, Stripe) sont
// remplacés par de fausses réponses : rien ne part sur internet, aucune commande n'est créée.
'use strict';

const TAILLES = [
  { nom: 'telephone', width: 390, height: 844, mobile: true },
  { nom: 'ordinateur', width: 1280, height: 800, mobile: false },
];

// Quatre points relais autour du code postal tapé.
const RELAIS = [
  { id: 101, name: 'Tabac Le Carnot', street: 'Rue Carnot', house_number: '12', postal_code: '69001', city: 'Lyon', country: 'FR', distance: 350 },
  { id: 102, name: 'Pressing des Terreaux', street: 'Place des Terreaux', house_number: '3', postal_code: '69001', city: 'Lyon', country: 'FR', distance: 620 },
  { id: 103, name: 'Épicerie du Griffon', street: 'Rue du Griffon', house_number: '8', postal_code: '69001', city: 'Lyon', country: 'FR', distance: 900 },
  { id: 104, name: 'Librairie Saint-Vincent', street: 'Quai Saint-Vincent', house_number: '21', postal_code: '69001', city: 'Lyon', country: 'FR', distance: 1400 },
];

// Adresses proposées par la Géoplateforme (Base Adresse Nationale) quand on tape l'adresse du proche.
const ADRESSES = { type: 'FeatureCollection', features: [
  { geometry: { type: 'Point', coordinates: [4.8320, 45.7578] }, properties: { label: '12 Place Bellecour 69002 Lyon', name: '12 Place Bellecour', postcode: '69002', city: 'Lyon', type: 'housenumber' } },
  { geometry: { type: 'Point', coordinates: [3.5141, 45.4882] }, properties: { label: 'Le Bourg 63880 Le Brugeron', name: 'Le Bourg', postcode: '63880', city: 'Le Brugeron', type: 'street' } },
  { geometry: { type: 'Point', coordinates: [4.835, 45.764] }, properties: { label: 'Lyon', name: 'Lyon', postcode: '69001', city: 'Lyon', type: 'municipality' } },
] };

// Réponse de codeCommande pour la page « Merci » : un vrai récapitulatif, avec une adresse e-mail longue (insécable).
const RECAP = { code: 'ABCD-EFGH', date: 1761474600, nom: 'Marie-Christine Dupont-Lefebvre', email: 'mariechristine.dupontlefebvre@gmail.com', formule: 'sim', payeCentimes: 6000,
  relais: { nom: 'Pressing des Terreaux', adresse: '3 Place des Terreaux', cp: '69001', ville: 'Lyon', destinataire: 'Marie-Christine Dupont-Lefebvre' } };

// Largeur de la page : si elle dépasse l'écran, le téléphone dézoome tout (bug signalé deux fois, 27/10).
// Donne le texte de l'erreur, ou rien.
async function tropLarge(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    if (de.scrollWidth <= de.clientWidth) return '';
    const coupables = [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1 && el.getBoundingClientRect().width > 0)
      .slice(0, 3).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].join('.') : ''));
    return `page trop large (${de.scrollWidth} px pour un écran de ${de.clientWidth} px : ${coupables.join(', ')})`;
  }).catch(() => '');
}

const pause = (p, ms = 700) => p.waitForTimeout(ms);
// Adresse du proche tapée, puis la n-ième proposition choisie (0 : Lyon, 4G très bonne ; 1 : limitée ; 2 : commune).
async function adresseChoisie(p, n = 0) {
  await p.fill('#adresse', 'place bellecour');
  await p.locator('#suggestions .point').nth(n).waitFor({ timeout: 5000 });
  await p.locator('#suggestions .point').nth(n).click();
  await pause(p, 500);
}
// Les trois étapes de la commande remplies : adresse du proche (points relais proposés autour), premier point
// relais, nom, e-mail.
async function commandeRemplie(p) {
  await adresseChoisie(p, 0);
  await p.locator('#points .point').first().waitFor({ timeout: 5000 });
  await pause(p, 300);
  await p.locator('#points .point').first().click();
  await p.fill('#destinataire', 'Tanguy Reynaud');
  await p.fill('#email', 'tanguy@exemple.fr');
  await p.dispatchEvent('#email', 'input');
  await pause(p);
}

// plein : toute la page (qui défile) ; sinon le premier écran seulement.
const SCENES = [
  { groupe: 'Accueil', titre: 'Page d’accueil', fichier: 'accueil.html', plein: true },
  { groupe: 'Accueil', titre: 'Accueil : chat de support ouvert', fichier: 'accueil.html', faire: async (p) => {
    await p.locator('.ps-bouton').click(); await pause(p, 900);
  } },
  { groupe: 'Commande', titre: 'Commande : page vide', fichier: 'commande.html', plein: true },
  { groupe: 'Commande', titre: 'Commande : adresse du proche tapée, propositions', fichier: 'commande.html', faire: async (p) => {
    await p.fill('#adresse', 'place bellecour'); await p.locator('#suggestions .point').first().waitFor({ timeout: 5000 }); await pause(p, 300);
  } },
  { groupe: 'Commande', titre: 'Commande : la 4G ne passe pas assez bien chez le proche', fichier: 'commande.html', faire: (p) => adresseChoisie(p, 1) },
  { groupe: 'Commande', titre: 'Commande : une commune seule, sans rue', fichier: 'commande.html', faire: (p) => adresseChoisie(p, 2) },
  { groupe: 'Commande', titre: 'Commande : point relais et coordonnées remplis, « Payer » actif', fichier: 'commande.html', plein: true, faire: commandeRemplie },
  { groupe: 'Commande', titre: 'Commande : « Payer » touché, « Un instant… »', fichier: 'commande.html', note: 'Le paiement s’ouvre chez Stripe (coupé ici) : la barre montre l’attente.', faire: async (p) => {
    await commandeRemplie(p);
    await p.locator('#payer').click({ noWaitAfter: true }).catch(() => {});
    await pause(p, 400);
  } },
  { groupe: 'Commande', titre: 'Commande : retour depuis Stripe avec le bouton Retour', fichier: 'commande.html', note: 'La page revient telle quelle : le bouton doit être redevenu « Payer 60 € », le relais et le nom gardés.', faire: async (p) => {
    await commandeRemplie(p);
    await p.locator('#payer').click({ noWaitAfter: true }).catch(() => {});
    await pause(p, 300);
    await p.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await pause(p, 300);
  } },
  { groupe: 'Commande', titre: 'Commande : il manque le point relais', fichier: 'commande.html', faire: async (p) => {
    await p.fill('#destinataire', 'Tanguy Reynaud'); await p.fill('#email', 'tanguy@exemple.fr'); await p.dispatchEvent('#email', 'input');
    await p.locator('#payer').click(); await pause(p);
  } },
  { groupe: 'Commande', titre: 'Merci, commande enregistrée (code et récapitulatif)', fichier: 'merci.html?session=cs_test_galerie', plein: true, note: 'Le récapitulatif vient d’une fausse réponse de codeCommande, avec une adresse e-mail longue (bug de largeur du 27/10).' },
  { groupe: 'Textes', titre: 'Conditions générales de vente', fichier: 'cgv.html', plein: true },
  { groupe: 'Textes', titre: 'Mentions légales et confidentialité', fichier: 'mentions.html', plein: true },
];

async function capturer({ browser, base, dossierImages, progression }) {
  const travaux = [];
  let n = 0;
  for (const scene of SCENES) for (const taille of TAILLES) travaux.push({ scene, taille, n: ++n });
  const n0 = travaux.length;
  const resultats = [];
  let faits = 0;
  async function ouvrier() {
    for (let job = travaux.shift(); job; job = travaux.shift()) {
      const { scene, taille, n } = job;
      const ctx = await browser.newContext({
        viewport: { width: taille.width, height: taille.height }, deviceScaleFactor: taille.mobile ? 2 : 1,
        isMobile: taille.mobile, hasTouch: taille.mobile, locale: 'fr-FR', timezoneId: 'Europe/Paris',
      });
      const page = await ctx.newPage();
      const erreurs = [];
      page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
      await page.clock.install({ time: new Date('2026-10-26T10:30:00+01:00') });
      // Internet coupé (sauf les polices), puis les faux services : Playwright regarde les routes de la dernière à la première.
      await page.route(/^https?:\/\/(?!127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com)/, (r) => r.abort());
      await page.route('**/stockDisponible', (r) => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"disponible":4}' }));
      await page.route('**/compter**', (r) => r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } }));
      // « Payer » part vers la fonction commander (puis Stripe) : ici une réponse 204, que le navigateur ignore,
      // la page reste donc affichée avec « Un instant… ».
      await page.route('**/commander**', (r) => r.fulfill({ status: 204 }));
      await page.route('**/codeCommande**', (r) => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(RECAP) }));
      await page.route(/geo\.api\.gouv\.fr/, (r) => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '[{"nom":"Lyon 1er Arrondissement","code":"69381"}]' }));
      await page.route(/data\.geopf\.fr\/geocodage\/search/, (r) => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(ADRESSES) }));
      // Couverture : la vraie règle (functions/couverture.js, carte de l'ARCEP) sur les coordonnées demandées.
      await page.route('**/couverture?**', (r) => {
        const u = new URL(r.request().url());
        const corps = require('../../functions/couverture').verifier(u.searchParams.get('lat'), u.searchParams.get('lon'));
        r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(corps) });
      });
      await page.route(/servicepoints\.sendcloud\.sc/, (r) => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(RELAIS) }));
      try {
        await page.goto(`${base}/${scene.fichier}`);
        await page.waitForTimeout(900);
        if (scene.faire) await scene.faire(page);
      } catch (e) {
        erreurs.push('Scène : ' + e.message.split('\n')[0]);
      }
      const largeur = await tropLarge(page);
      if (largeur) erreurs.push('Largeur : ' + largeur);
      const fichier = `vitrine-${String(n).padStart(3, '0')}.jpg`;
      if (scene.plein) {
        const h = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => taille.height);
        if (h > taille.height) { await page.setViewportSize({ width: taille.width, height: Math.min(h, taille.height * 6) }); await pause(page, 400); }
      }
      await page.screenshot({ path: `${dossierImages}/${fichier}`, type: 'jpeg', quality: 62, timeout: 15000 }).catch((e) => erreurs.push('Capture : ' + e.message.split('\n')[0]));
      resultats.push({ n, groupe: scene.groupe, titre: scene.titre, note: scene.note, taille: taille.nom, fichier, erreurs, scene: SCENES.indexOf(scene) });
      await ctx.close();
      progression(`site vitrine ${++faits}/${n0}`);
    }
  }
  await Promise.all([ouvrier(), ouvrier(), ouvrier()]);
  return resultats.sort((a, b) => a.n - b.n);
}

module.exports = { capturer, SCENES };
