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

// Villes, puis rues d'une ville, proposées par la Géoplateforme (Base Adresse Nationale) pour le proche.
const VILLES = { type: 'FeatureCollection', features: [
  { geometry: { type: 'Point', coordinates: [4.835, 45.758] }, properties: { label: 'Lyon', name: 'Lyon', postcode: '69001', citycode: '69123', context: '69, Rhône, Auvergne-Rhône-Alpes', type: 'municipality' } },
  { geometry: { type: 'Point', coordinates: [3.0955, 45.6997] }, properties: { label: 'Brousse', name: 'Brousse', postcode: '63490', citycode: '63056', context: '63, Puy-de-Dôme, Auvergne-Rhône-Alpes', type: 'municipality' } },
] };
const RUES = { type: 'FeatureCollection', features: [
  { geometry: { type: 'Point', coordinates: [3.5141, 45.4882] }, properties: { label: 'Le Bourg 63490 Brousse', name: 'Le Bourg', postcode: '63490', city: 'Brousse', type: 'street' } },
  { geometry: { type: 'Point', coordinates: [4.8320, 45.7578] }, properties: { label: 'Fougère 63490 Brousse', name: 'Fougère', postcode: '63490', city: 'Brousse', type: 'street' } },
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
// Ville du proche tapée, puis la n-ième proposition choisie (0 : Lyon, bien couverte ; 1 : Brousse, rue demandée),
// puis, pour Brousse, la rue r (0 : 4G limitée ; 1 : bonne).
async function villeChoisie(p, n = 0, r = null) {
  await p.fill('#adresse', 'lyon');
  await p.locator('#suggestions .point').nth(n).waitFor({ timeout: 5000 });
  await p.locator('#suggestions .point').nth(n).click();
  await pause(p, 500);
  if (r == null) return;
  await p.fill('#adresse', 'le bourg');
  await p.locator('#suggestions .point').nth(r).waitFor({ timeout: 5000 });
  await p.locator('#suggestions .point').nth(r).click();
  await pause(p, 500);
}
// Les trois étapes de la commande remplies : adresse du proche (points relais proposés autour), premier point
// relais, nom, e-mail.
async function commandeRemplie(p) {
  await villeChoisie(p, 0);
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
  { groupe: 'Accueil', titre: 'Chat : réponse de Papote, « Être rappelé » proposé', fichier: 'accueil.html', faire: async (p) => {
    await p.locator('.ps-bouton').click(); await pause(p, 600); await p.locator('.ps-idees button').first().click(); await pause(p, 1200);
  } },
  { groupe: 'Accueil', titre: 'Chat : Papote écrit (bulle « … »)', fichier: 'accueil.html', routes: (p) => p.route('**/supportChat', () => {}), faire: async (p) => {
    await p.locator('.ps-bouton').click(); await pause(p, 600); await p.locator('.ps-idees button').first().click(); await pause(p, 900);
  } },
  { groupe: 'Accueil', titre: 'Chat : indisponible', fichier: 'accueil.html', routes: (p) => p.route('**/supportChat', (r) => r.fulfill({ status: 500, body: '' })), faire: async (p) => {
    await p.locator('.ps-bouton').click(); await pause(p, 600); await p.locator('.ps-idees button').first().click(); await pause(p, 1200);
  } },
  { groupe: 'Accueil', titre: 'Chat : demande de rappel, champ manquant', fichier: 'accueil.html', faire: async (p) => {
    await p.locator('.ps-bouton').click(); await pause(p, 600); await p.locator('.ps-idees button').first().click(); await pause(p, 1200);
    await p.locator('.ps-rappeler').click(); await pause(p, 400); await p.getByRole('button', { name: 'Être rappelé', exact: true }).click(); await pause(p, 500);
  } },
  { groupe: 'Accueil', titre: 'Chat : demande de rappel envoyée', fichier: 'accueil.html', faire: async (p) => {
    await p.locator('.ps-bouton').click(); await pause(p, 600); await p.locator('.ps-idees button').first().click(); await pause(p, 1200);
    await p.locator('.ps-rappeler').click(); await pause(p, 400);
    for (const [label, v] of [['Votre prénom', 'Marie'], ['Votre nom', 'Dupont'], ['Votre téléphone', '06 12 34 56 78'], ['Votre e-mail', 'marie@exemple.fr']]) await p.getByLabel(label).fill(v);
    await p.getByRole('button', { name: 'Être rappelé', exact: true }).click(); await pause(p, 1000);
  } },
  { groupe: 'Commande', titre: 'Commande : page vide', fichier: 'commande.html', plein: true },
  { groupe: 'Commande', titre: 'Commande : ville du proche tapée, propositions', fichier: 'commande.html', faire: async (p) => {
    await p.fill('#adresse', 'lyon'); await p.locator('#suggestions .point').first().waitFor({ timeout: 5000 }); await pause(p, 300);
  } },
  { groupe: 'Commande', titre: 'Commande : la 4G ne passe pas partout dans la ville, sa rue est demandée', fichier: 'commande.html', faire: (p) => villeChoisie(p, 1) },
  { groupe: 'Commande', titre: 'Commande : la 4G ne passe pas assez bien dans sa rue', fichier: 'commande.html', faire: (p) => villeChoisie(p, 1, 0) },
  { groupe: 'Commande', titre: 'Commande : rue bien couverte', fichier: 'commande.html', faire: (p) => villeChoisie(p, 1, 1) },
  { groupe: 'Commande', titre: 'Commande : la 4G passe bien dans toute la ville', fichier: 'commande.html', faire: (p) => villeChoisie(p, 0) },
  { groupe: 'Commande', titre: 'Commande : vérification de la 4G en cours', fichier: 'commande.html', routes: (p) => p.route('**/couverture?**', () => {}), faire: (p) => villeChoisie(p, 0) },
  { groupe: 'Commande', titre: 'Commande : la vérification de la 4G ne répond pas', fichier: 'commande.html', routes: (p) => p.route('**/couverture?**', (r) => r.fulfill({ status: 500, body: '' })), faire: (p) => villeChoisie(p, 0) },
  { groupe: 'Commande', titre: 'Commande : les adresses ne s’affichent pas', fichier: 'commande.html', routes: (p) => p.route(/data\.geopf\.fr/, (r) => r.fulfill({ status: 500, body: '' })), faire: async (p) => {
    await p.fill('#adresse', 'lyon'); await pause(p, 1200);
  } },
  { groupe: 'Commande', titre: 'Commande : point relais par code postal (une ville)', fichier: 'commande.html', faire: async (p) => {
    await p.locator('#cp').pressSequentially('69001'); await pause(p, 1200); await p.locator('#points').scrollIntoViewIfNeeded().catch(() => {});
  } },
  { groupe: 'Commande', titre: 'Commande : code postal de plusieurs villes, choisir la ville', fichier: 'commande.html',
    routes: (p) => p.route(/geo\.api\.gouv\.fr/, (r) => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '[{"nom":"Le Cheylard"},{"nom":"Saint-Martin-de-Valamas"},{"nom":"Mariac"}]' })),
    faire: async (p) => { await p.locator('#cp').pressSequentially('07160'); await pause(p, 1000); await p.locator('#pays-ville').scrollIntoViewIfNeeded().catch(() => {}); } },
  { groupe: 'Commande', titre: 'Commande : « Autour de moi », position refusée', fichier: 'commande.html', faire: async (p) => {
    await p.locator('#autour').scrollIntoViewIfNeeded(); await p.click('#autour'); await pause(p, 1200);
  } },
  { groupe: 'Commande', titre: 'Commande : « Autour de moi », points relais trouvés', fichier: 'commande.html', routes: async (p, ctx) => {
    await ctx.grantPermissions(['geolocation']); await ctx.setGeolocation({ latitude: 45.767, longitude: 4.834 });
  }, faire: async (p) => { await p.locator('#autour').scrollIntoViewIfNeeded(); await p.click('#autour'); await pause(p, 1500); } },
  { groupe: 'Commande', titre: 'Commande : la liste et la carte des points relais ne s’affichent pas', fichier: 'commande.html', routes: (p) => p.route(/servicepoints\.sendcloud\.sc/, (r) => r.fulfill({ status: 500, body: '' })), faire: async (p) => {
    await p.locator('#cp').pressSequentially('69001'); await pause(p, 1500); await p.locator('#erreur-carte').scrollIntoViewIfNeeded().catch(() => {});
  } },
  { groupe: 'Commande', titre: 'Commande : revenue plus tard, « Votre commande vous attend »', fichier: 'commande.html', plein: true,
    note: 'Ce qui était rempli est gardé une heure dans le navigateur.',
    session: { 'papote-commande': { t: new Date('2026-10-26T10:10:00+01:00').getTime(), proche: { adresse: 'Lyon', lat: 45.758, lon: 4.835, cp: '69001', niveau: 'commune', eligible: true, insee: '69123' }, cp: '69001', pays: 'fr',
      relais: { id: 102, name: 'Pressing des Terreaux', adresse: '3 Place des Terreaux', postal_code: '69001', city: 'Lyon' }, nom: 'Tanguy Reynaud', email: 'tanguy@exemple.fr', accord: true } } },
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
  { groupe: 'Commande', titre: 'Commande : code postal à plusieurs villes, choix de la ville', fichier: 'commande.html', faire: async (p) => {
    await p.fill('#cp', '63490'); await p.dispatchEvent('#cp', 'input'); await p.locator('#ville').waitFor({ timeout: 5000 }); await pause(p, 500);
  } },
  { groupe: 'Commande', titre: 'Commande : il manque le point relais', fichier: 'commande.html', faire: async (p) => {
    await p.fill('#destinataire', 'Tanguy Reynaud'); await p.fill('#email', 'tanguy@exemple.fr'); await p.dispatchEvent('#email', 'input');
    await p.locator('#payer').click(); await pause(p);
  } },
  { groupe: 'Commande', titre: 'Merci, commande enregistrée (code et récapitulatif)', fichier: 'merci.html?session=cs_test_galerie', plein: true, note: 'Le récapitulatif vient d’une fausse réponse de codeCommande, avec une adresse e-mail longue (bug de largeur du 27/10).' },
  { groupe: 'Commande', titre: 'Merci : le code de commande n’a pas pu être chargé', fichier: 'merci.html?session=cs_test_galerie', plein: true, routes: (p) => p.route('**/codeCommande**', (r) => r.fulfill({ status: 404, body: '' })) },
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
      page.setDefaultTimeout(8000); // un bouton absent : erreur signalée vite, pas après 30 s
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
      // 63490 : un code postal à plusieurs villes, pour voir le choix de la ville.
      await page.route(/geo\.api\.gouv\.fr/, (r) => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: /63490/.test(r.request().url()) ? '[{"nom":"Brousse","code":"63056"},{"nom":"Sugères","code":"63423"},{"nom":"Sauviat","code":"63412"}]' : '[{"nom":"Lyon 1er Arrondissement","code":"69381"}]' }));
      await page.route(/data\.geopf\.fr\/geocodage\/search/, (r) => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(/citycode=/.test(r.request().url()) ? RUES : VILLES) }));
      // Couverture : la vraie règle (functions/couverture.js, carte de l'ARCEP) sur les coordonnées demandées.
      await page.route('**/couverture?**', (r) => {
        const u = new URL(r.request().url());
        // Commune seule : parts mesurées sur les vrais contours (Lyon 100 %, Brousse 85 %).
        const insee = u.searchParams.get('insee');
        const corps = insee ? { part: insee === '69123' ? 1 : 0.85, eligible: insee === '69123', trimestre: '2026_T2' }
          : require('../../functions/couverture').verifier(u.searchParams.get('lat'), u.searchParams.get('lon'));
        r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(corps) });
      });
      await page.route(/servicepoints\.sendcloud\.sc/, (r) => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(RELAIS) }));
      // Réponse du chat de support (fonction supportChat) : une vraie réponse type, sans appel à Claude.
      await page.route('**/supportChat', (r) => {
        const corps = JSON.parse(r.request().postData() || '{}');
        r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(corps.messages || corps.inscription
          ? { ok: true, reponse: 'Papote coûte 25 € par mois, tout compris : la tablette prêtée, la carte SIM 4G et l’appli pour toute la famille. Il y a 60 € de mise en service à la commande, et c’est sans engagement.' }
          : { ok: true }) });
      });
      // Routes propres à la scène (pannes, attentes) : posées en dernier, elles passent avant les autres.
      if (scene.routes) await scene.routes(page, ctx);
      if (scene.session) await page.addInitScript((d) => { for (const [k, v] of Object.entries(d)) sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); }, scene.session);
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
