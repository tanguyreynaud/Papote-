const test = require('node:test');
const assert = require('node:assert');
const {
  creer, resumeParc, nettoyerQuestion, filtrerLiens, LIENS_FIXES, QUOTA_JOUR, MESSAGE_QUOTA, MESSAGE_PANNE, GUIDE,
} = require('./ia-admin')._test;

const MAINTENANT = Date.UTC(2026, 9, 26, 9, 30);
const ADMIN = { auth: { uid: 'u-admin', token: { admin: true } } };

// Fausse base : quelques documents (avec des données personnelles qui ne doivent jamais partir), select et
// fieldMask respectés comme Firestore, et chaque écriture notée.
function fausseBase(docs = {}) {
  const ecrits = [];
  const lire = (chemin) => docs[chemin];
  const champ = (d, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), d);
  const garder = (d, champs) => {
    if (!d || !champs) return d;
    const r = {};
    for (const p of champs) {
      const v = champ(d, p);
      if (v === undefined) continue;
      const ks = p.split('.');
      let o = r;
      ks.slice(0, -1).forEach((k) => { o = o[k] = o[k] || {}; });
      o[ks[ks.length - 1]] = v;
    }
    return r;
  };
  const instantane = (chemin, d) => ({ id: chemin.split('/').pop(), exists: d !== undefined, get: (p) => champ(d, p), data: () => d });
  const ref = (chemin) => ({ chemin, get: async () => instantane(chemin, lire(chemin)) });
  const requete = (nom, filtre = () => true, champs = null) => ({
    where: (k, op, v) => requete(nom, (d) => filtre(d) && (op === 'in' ? v.includes(champ(d, k)) : champ(d, k) === v), champs),
    select: (...c) => requete(nom, filtre, c),
    get: async () => ({
      docs: Object.entries(docs).filter(([c, d]) => c.startsWith(`${nom}/`) && c.split('/').length === 2 && filtre(d))
        .map(([c, d]) => instantane(c, garder(d, champs))),
    }),
  });
  return {
    ecrits,
    doc: ref,
    collection: (nom) => requete(nom),
    getAll: async (...args) => {
      const options = args.length && !args[args.length - 1].chemin ? args.pop() : {};
      return args.map((r) => instantane(r.chemin, garder(lire(r.chemin), options.fieldMask)));
    },
    runTransaction: async (fn) => fn({
      get: async (r) => instantane(r.chemin, lire(r.chemin)),
      set: (r, d) => { ecrits.push(r.chemin); docs[r.chemin] = { ...(docs[r.chemin] || {}), ...d }; },
    }),
  };
}

// Parc réaliste, avec les données personnelles qu'on trouve vraiment sur ces fiches.
function parc() {
  return {
    'stock/T-001': { ref: 'T-001', etat: 'chez-client', fid: 'f-jeanne', tabletUid: 'tab-jeanne', simId: 'S1', commande: 'CMD-GH78', sim: '07 45 12 34 56', numero: 'BV60P-0001' },
    'stock/T-002': { ref: 'T-002', etat: 'en-stock' },
    'families/f-jeanne': { name: 'Mamie Jeanne', abonnement: { statut: 'actif', stripeCustomerId: 'cus_secret' }, adresse: '4 rue de la Gare, Lyon' },
    'families/f-jeanne/members/tab-jeanne': {
      role: 'tablette', email: 'tablette@exemple.fr', lastOnline: MAINTENANT - 15 * 60000, battery: { level: 82, charging: true },
      sim: { iccid: '8933150000000001', operateur: 'Lycamobile', dataMoisMo: 214 }, photoURL: 'https://exemple.invalid/photo.jpg',
    },
    'sims/S1': { statut: 'active', go: 1, prochaineRecharge: MAINTENANT + 5 * 864e5, numero: '07 45 12 34 56', iccid: '8933150000000001', cb: 'Visa …4242' },
    'commandes/CMD-GH78': { nom: 'Julie Martin', email: 'julie@exemple.fr', telephone: '06 12 34 56 78', livraison: { adresse: '4 rue de la Gare' }, pause: { jusqua: MAINTENANT + 10 * 864e5 } },
  };
}

function fauxClient(reponse = { content: [{ type: 'text', text: '1. Ouvrez la tablette. [Ouvrir](#tablette/T-001)' }] }) {
  const appels = [];
  return {
    appels,
    client: () => ({ messages: { create: async (corps) => { appels.push(corps); if (reponse instanceof Error) throw reponse; return reponse; } } }),
  };
}

test('refuse sans connexion', async () => {
  const f = fauxClient();
  const base = fausseBase(parc());
  const iaAdmin = creer({ db: () => base, client: f.client, maintenant: () => MAINTENANT });
  await assert.rejects(iaAdmin({ data: { question: 'Tablette perdue ?' } }), (e) => e.code === 'unauthenticated');
  assert.strictEqual(f.appels.length, 0);
  assert.deepStrictEqual(base.ecrits, []);
});

test('refuse un compte sans badge admin, même avec admin: "true"', async () => {
  const f = fauxClient();
  const base = fausseBase(parc());
  const iaAdmin = creer({ db: () => base, client: f.client, maintenant: () => MAINTENANT });
  for (const token of [{}, { admin: 'true' }, { admin: 1 }]) {
    await assert.rejects(iaAdmin({ auth: { uid: 'u-x', token }, data: { question: 'Tablette perdue ?' } }), (e) => e.code === 'permission-denied');
  }
  assert.strictEqual(f.appels.length, 0);
  assert.deepStrictEqual(base.ecrits, []);
});

test('répond avec le guide et l’état du parc, et n’écrit que le compteur du jour', async () => {
  const f = fauxClient();
  const base = fausseBase(parc());
  const iaAdmin = creer({ db: () => base, client: f.client, maintenant: () => MAINTENANT });
  const r = await iaAdmin({ ...ADMIN, data: { question: 'La tablette de Mamie Jeanne ne répond plus' } });
  assert.deepStrictEqual(r, { ok: true, reponse: '1. Ouvrez la tablette. [Ouvrir](#tablette/T-001)' });
  assert.deepStrictEqual(base.ecrits, ['iaAdminQuota/2026-10-26']);
  const corps = f.appels[0];
  assert.strictEqual(corps.model, 'claude-haiku-5-5');
  assert.ok(corps.max_tokens <= 1000);
  // Le guide est fixe et mis en cache ; l'état du parc vient après.
  assert.strictEqual(corps.system[1].text, GUIDE);
  assert.deepStrictEqual(corps.system[1].cache_control, { type: 'ephemeral' });
  const etat = corps.system[2].text;
  for (const vu of ['T-001', 'Mamie Jeanne', 'abonnement actif', 'il y a 15 min', 'batterie 82 %', 'data du mois 214 Mo sur 1000 Mo', 'forfait finit dans 5 j', 'pause hospitalisation', '#sim/S1', '#commande/CMD-GH78']) {
    assert.ok(etat.includes(vu), `l'état du parc devrait dire « ${vu} »`);
  }
  assert.ok(!etat.includes('T-002'), 'une tablette en stock n’est pas envoyée');
});

test('aucune donnée personnelle dans ce qui part chez Anthropic', async () => {
  const f = fauxClient();
  const base = fausseBase(parc());
  const iaAdmin = creer({ db: () => base, client: f.client, maintenant: () => MAINTENANT });
  await iaAdmin({ ...ADMIN, data: { question: 'Appeler julie@exemple.fr au 06 12 34 56 78 ou +33 6 12 34 56 78 ?' } });
  const envoye = JSON.stringify(f.appels[0]);
  for (const prive of ['julie@exemple.fr', 'Julie Martin', '06 12 34 56 78', '+33 6 12 34 56 78', '07 45 12 34 56', 'rue de la Gare', 'tablette@exemple.fr',
    '8933150000000001', 'Visa', 'cus_secret', 'photo.jpg', 'BV60P-0001', 'Lycamobile']) {
    assert.ok(!envoye.includes(prive), `« ${prive} » ne doit pas partir chez Anthropic`);
  }
  assert.ok(envoye.includes('[e-mail masqué]') && envoye.includes('[numéro masqué]'));
});

test('résumé du parc : même lu sans select, ne recopie que les champs permis', () => {
  const { texte } = resumeParc({
    stock: [{ id: 'T-001', ref: 'T-001', etat: 'chez-client', fid: 'f', tabletUid: 't', simId: 'S1', sim: '07 45 12 34 56', telephone: '06 11 22 33 44' }],
    familles: new Map([['f', { nom: 'Papi [Henri](https://pirate.example)', statut: 'impaye', graceJusqua: MAINTENANT + 3 * 864e5, email: 'x@y.fr' }]]),
    membres: new Map([['t', { lastOnline: null, email: 'x@y.fr' }]]),
    sims: new Map([['S1', { statut: 'suspendue', numero: '07 45 12 34 56' }]]),
  }, MAINTENANT);
  assert.ok(!texte.includes('07 45') && !texte.includes('06 11') && !texte.includes('x@y.fr'));
  assert.ok(!texte.includes('](https://pirate'), 'un nom de famille ne fabrique pas de lien');
  assert.ok(texte.includes('paiement en retard') && texte.includes('mise en pause prévue dans 3 j') && texte.includes('jamais vu') && texte.includes('suspendue'));
});

test('quota du jour atteint : message calme, pas d’appel à Anthropic', async () => {
  const f = fauxClient();
  const docs = parc();
  docs['iaAdminQuota/2026-10-26'] = { n: QUOTA_JOUR };
  const base = fausseBase(docs);
  const iaAdmin = creer({ db: () => base, client: f.client, maintenant: () => MAINTENANT });
  const r = await iaAdmin({ ...ADMIN, data: { question: 'Paiement refusé ?' } });
  assert.deepStrictEqual(r, { ok: false, raison: 'quota', reponse: MESSAGE_QUOTA });
  assert.strictEqual(f.appels.length, 0);
  assert.deepStrictEqual(base.ecrits, []);
});

test('la 40e question passe, la 41e non', async () => {
  const f = fauxClient();
  const docs = parc();
  docs['iaAdminQuota/2026-10-26'] = { n: QUOTA_JOUR - 1 };
  const base = fausseBase(docs);
  const iaAdmin = creer({ db: () => base, client: f.client, maintenant: () => MAINTENANT });
  assert.strictEqual((await iaAdmin({ ...ADMIN, data: { question: 'Paiement refusé ?' } })).ok, true);
  assert.strictEqual((await iaAdmin({ ...ADMIN, data: { question: 'Paiement refusé ?' } })).raison, 'quota');
  assert.strictEqual(f.appels.length, 1);
});

test('compteur illisible : question refusée plutôt qu’illimitée', async () => {
  const f = fauxClient();
  const base = { ...fausseBase(parc()), runTransaction: async () => { throw new Error('contention'); } };
  const iaAdmin = creer({ db: () => base, client: f.client, maintenant: () => MAINTENANT });
  assert.strictEqual((await iaAdmin({ ...ADMIN, data: { question: 'Paiement refusé ?' } })).raison, 'quota');
  assert.strictEqual(f.appels.length, 0);
});

test('Anthropic en panne ou qui refuse : message calme qui renvoie au guide', async () => {
  for (const reponse of [new Error('529 overloaded'), { stop_reason: 'refusal', content: [] }, { content: [{ type: 'thinking', thinking: '' }] }]) {
    const f = fauxClient(reponse);
    const iaAdmin = creer({ db: () => fausseBase(parc()), client: f.client, maintenant: () => MAINTENANT });
    const r = await iaAdmin({ ...ADMIN, data: { question: 'Panne Firebase ?' } });
    assert.strictEqual(r.ok, false);
    assert.ok(/6 cas du guide/.test(r.reponse), r.reponse);
  }
  const f = fauxClient(new Error('x'));
  const r = await creer({ db: () => fausseBase(parc()), client: f.client, maintenant: () => MAINTENANT })({ ...ADMIN, data: { question: 'Panne ?' } });
  assert.deepStrictEqual(r, { ok: false, raison: 'indisponible', reponse: MESSAGE_PANNE });
});

test('état du parc illisible : répond quand même avec le guide', async () => {
  const f = fauxClient();
  const base = { ...fausseBase(parc()), collection: () => { throw new Error('base indisponible'); } };
  const r = await creer({ db: () => base, client: f.client, maintenant: () => MAINTENANT })({ ...ADMIN, data: { question: 'Tablette cassée ?' } });
  assert.strictEqual(r.ok, true);
  assert.ok(f.appels[0].system[2].text.includes('illisible'));
  // La fiche n'a pas été lue : son lien n'est plus permis.
  assert.strictEqual(r.reponse, '1. Ouvrez la tablette. Ouvrir');
});

test('question vide ou trop longue', async () => {
  const f = fauxClient();
  const iaAdmin = creer({ db: () => fausseBase(parc()), client: f.client, maintenant: () => MAINTENANT });
  await assert.rejects(iaAdmin({ ...ADMIN, data: { question: '  ' } }), (e) => e.code === 'invalid-argument');
  await assert.rejects(iaAdmin({ ...ADMIN, data: {} }), (e) => e.code === 'invalid-argument');
  await iaAdmin({ ...ADMIN, data: { question: 'x'.repeat(5000) } });
  assert.strictEqual(f.appels[0].messages[0].content.length, 500);
});

test('liens : seuls les écrans de l’admin permis restent cliquables', () => {
  const permis = [...LIENS_FIXES, '#tablette/T-001'];
  const brut = [
    '1. Ouvrez la **tablette** : [Ouvrir la tablette](#tablette/T-001).',
    '2. Une autre : [T-999](#tablette/T-999) ou [Réglages](#outils/maintenance).',
    '3. Voir [Stripe](https://dashboard.stripe.com) et pas [ce site](https://pirate.example/x) ni [js](javascript:alert(1)).',
    '4. Ou bien https://pirate.example/y et www.pirate.example.',
  ].join('\n');
  assert.strictEqual(filtrerLiens(brut, permis), [
    '1. Ouvrez la tablette : [Ouvrir la tablette](#tablette/T-001).',
    '2. Une autre : T-999 ou Réglages.',
    '3. Voir [Stripe](https://dashboard.stripe.com) et pas ce site ni js.',
    '4. Ou bien et.',
  ].join('\n'));
});

test('la réponse renvoyée garde les liens permis et retire les autres', async () => {
  const f = fauxClient({ content: [{ type: 'text', text: '1. [Carte SIM](#sim/S1) puis [Ailleurs](#sim/S9).' }] });
  const r = await creer({ db: () => fausseBase(parc()), client: f.client, maintenant: () => MAINTENANT })({ ...ADMIN, data: { question: 'SIM sans données ?' } });
  assert.strictEqual(r.reponse, '1. [Carte SIM](#sim/S1) puis Ailleurs.');
});

test('question : e-mails et numéros masqués, le reste gardé', () => {
  assert.strictEqual(nettoyerQuestion(' La tablette T-006\nne répond plus depuis 2 h '), 'La tablette T-006 ne répond plus depuis 2 h');
  assert.strictEqual(nettoyerQuestion('Rappeler a.b@c.fr au 0612345678'), 'Rappeler [e-mail masqué] au [numéro masqué]');
  assert.strictEqual(nettoyerQuestion('Le 03/11/2026, forfait de 1000 Mo'), 'Le 03/11/2026, forfait de 1000 Mo');
  assert.strictEqual(nettoyerQuestion(42), '');
});

test('le guide du serveur a les 6 cas et les liens de la page #aide', () => {
  for (const cas of ['Tablette perdue ou volée', 'Paiement refusé', "Mamie à l'hôpital", 'Panne Firebase', 'Carte SIM sans données', 'Tablette cassée']) {
    assert.ok(GUIDE.includes(`## ${cas}`), `cas manquant : ${cas}`);
  }
  const liens = [...GUIDE.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(liens.length >= 18);
  for (const l of liens) assert.ok(LIENS_FIXES.includes(l), `lien du guide hors de la liste permise : ${l}`);
});
