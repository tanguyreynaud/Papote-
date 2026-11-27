const test = require('node:test');
const assert = require('node:assert');
const mail = require('./mail');
const connexion = require('./connexion');

const { adresseValide, retourPermis, compterEnvoi, adresseAppelant, LIMITES_CONNEXION } = connexion;

// Base en mémoire : doc(), runTransaction() avec getAll et set, assez pour les compteurs.
function fausseBase() {
  const docs = new Map();
  const snap = (chemin) => ({ exists: docs.has(chemin), get: (c) => (docs.get(chemin) || {})[c] });
  return {
    docs,
    doc: (chemin) => ({ chemin }),
    runTransaction: async (f) => {
      const ecritures = [];
      const r = await f({ getAll: async (...refs) => refs.map((x) => snap(x.chemin)), set: (ref, d) => ecritures.push([ref.chemin, d]) });
      for (const [c, d] of ecritures) docs.set(c, d);
      return r;
    },
  };
}

function banc() {
  const db = fausseBase();
  const envois = [];
  const liens = [];
  const journal = [];
  const auth = {
    generateSignInWithEmailLink: async (email, reglages) => {
      liens.push({ email, reglages });
      return `https://papote-famille.firebaseapp.com/__/auth/action?mode=signIn&oobCode=CODE${liens.length}&continueUrl=${encodeURIComponent(reglages.url)}`;
    },
  };
  const f = connexion.creer({
    db, auth, mail, envoyerMail: async (a, contenu) => { envois.push({ a, contenu }); },
    logger: { warn: (...m) => journal.push(m.join(' ')), error: (...m) => journal.push(m.join(' ')) },
  });
  const appeler = (data, ip = '203.0.113.7') => f({ data, rawRequest: { headers: { 'x-forwarded-for': `1.2.3.4, ${ip}` }, ip: '10.0.0.1' } });
  return { db, envois, liens, journal, appeler, auth };
}

const RETOUR = 'https://app.mapapote.fr/?lien=1';

test('l\'e-mail de connexion : français, vouvoiement, bouton avec le lien, rien d\'anglais', () => {
  const lien = 'https://papote-famille.firebaseapp.com/__/auth/action?mode=signIn&oobCode=ABC&continueUrl=x';
  const m = mail.lienConnexion({ email: 'julie@exemple.fr', lien });
  assert.strictEqual(m.subject, 'Votre lien pour ouvrir Papote');
  assert.match(m.html, /Ouvrir Papote&nbsp;→<\/a>/);
  assert.ok(m.html.includes(`href="${mail.echapper(lien)}"`), 'le bouton mène au lien');
  assert.match(m.text, /Ouvrir Papote : https:\/\/papote-famille\.firebaseapp\.com\/__\/auth\/action\?mode=signIn&oobCode=ABC/);
  assert.match(m.text, /Ce lien marche une seule fois, pendant 1 heure, sur ce téléphone\./);
  assert.match(m.text, /Si vous n'avez rien demandé, ignorez cet e-mail : personne n'aura accès à votre compte\./);
  assert.match(m.text, /julie@exemple\.fr/);
  assert.match(m.text, /Copiez cette adresse dans votre navigateur/);
  // L'ordre : le lien de secours et « rien demandé » sous le bouton.
  assert.ok(m.html.indexOf('Ouvrir Papote&nbsp;→') < m.html.indexOf('Si vous n'), 'sous le bouton');
  assert.doesNotMatch(m.text + m.html, /Hello|We received|sign in|Thanks|Your Papote team/i);
  assert.doesNotMatch(m.text, /\btu\b|\bton\b|\bta\b/i);
  assert.ok(!mail.estConfort(m), 'jamais retenu quand le quota baisse');
  assert.ok(!mail.estMarketing(m) && !m.headers, 'e-mail de service : pas de désinscription');
  // Adresse piégée : échappée.
  assert.doesNotMatch(mail.lienConnexion({ email: '<b>x@y.fr', lien }).html, /<b>x@y/);
});

test('adresses : valides en minuscules, les autres refusées', () => {
  assert.strictEqual(adresseValide('  Julie@Exemple.FR '), 'julie@exemple.fr');
  for (const mauvaise of ['', 'julie', 'julie@exemple', 'julie@exemple.f', 'ju lie@exemple.fr', `${'a'.repeat(120)}@exemple.fr`, null, 42, ['a@b.fr']]) {
    assert.strictEqual(adresseValide(mauvaise), null, String(mauvaise));
  }
});

test('adresse de retour : seulement l\'appli (localhost avec les émulateurs)', () => {
  assert.strictEqual(retourPermis('https://app.mapapote.fr/?lien=1', false), 'https://app.mapapote.fr/?lien=1');
  assert.strictEqual(retourPermis('https://papote-famille.web.app/?lien=1', false), 'https://papote-famille.web.app/?lien=1');
  assert.strictEqual(retourPermis('http://localhost:5000/?lien=1', true), 'http://localhost:5000/?lien=1');
  for (const r of [
    'http://localhost:5000/?lien=1', 'http://app.mapapote.fr/?lien=1', 'https://app.mapapote.fr.pirate.com/', 'https://pirate.com/?app.mapapote.fr',
    'https://evil@app.mapapote.fr/', 'https://app.mapapote.fr:8443/', 'javascript:alert(1)', 'https://mapapote.fr/', '', null, 'pas une adresse',
  ]) assert.strictEqual(retourPermis(r, false), null, String(r));
  assert.strictEqual(retourPermis('https://pirate.com/', true), null);
});

test('envoi : lien fabriqué avec les réglages de l\'appli, e-mail à la bonne adresse, réponse sans rien révéler', async () => {
  const b = banc();
  assert.deepStrictEqual(await b.appeler({ email: 'Julie@Exemple.fr', retour: RETOUR }), { ok: true });
  assert.deepStrictEqual(b.liens, [{ email: 'julie@exemple.fr', reglages: { url: RETOUR, handleCodeInApp: true } }]);
  assert.strictEqual(b.envois.length, 1);
  assert.strictEqual(b.envois[0].a, 'julie@exemple.fr');
  assert.strictEqual(b.envois[0].contenu.subject, 'Votre lien pour ouvrir Papote');
  assert.match(b.envois[0].contenu.text, /oobCode=CODE1/);
  // Les compteurs ne gardent ni l'adresse e-mail ni l'adresse internet en clair.
  const cles = [...b.db.docs.keys()].join(' ');
  assert.doesNotMatch(cles, /julie|203\.0\.113/);
  assert.ok(cles.includes('limites/connexion-total'));
});

test('adresse refusée et retour refusé : rien ne part, rien n\'est compté', async () => {
  const b = banc();
  await assert.rejects(b.appeler({ email: 'julie@exemple', retour: RETOUR }), (e) => e.code === 'invalid-argument');
  await assert.rejects(b.appeler({ email: 'julie@exemple.fr', retour: 'https://pirate.com/?lien=1' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(b.appeler({ email: 'julie@exemple.fr' }), (e) => e.code === 'invalid-argument');
  assert.strictEqual(b.envois.length + b.liens.length + b.db.docs.size, 0);
});

test('limite : 3 par heure pour une adresse, puis de nouveau une heure plus tard', async () => {
  const b = banc();
  const vrai = Date.now;
  let t = Date.parse('2026-11-20T10:00:00Z');
  Date.now = () => t;
  try {
    for (let i = 0; i < LIMITES_CONNEXION.parAdresse; i++) await b.appeler({ email: 'julie@exemple.fr', retour: RETOUR });
    await assert.rejects(b.appeler({ email: 'julie@exemple.fr', retour: RETOUR }), (e) => e.code === 'resource-exhausted' && /une heure/.test(e.message));
    assert.strictEqual(b.envois.length, 3);
    // Une autre adresse passe toujours.
    await b.appeler({ email: 'paul@exemple.fr', retour: RETOUR });
    assert.strictEqual(b.envois.length, 4);
    t += 61 * 60 * 1000;
    await b.appeler({ email: 'julie@exemple.fr', retour: RETOUR });
    assert.strictEqual(b.envois.length, 5);
  } finally {
    Date.now = vrai;
  }
});

test('limite : 10 par heure depuis une même adresse internet, 60 pour tout Papote', async () => {
  const b = banc();
  for (let i = 0; i < LIMITES_CONNEXION.parIp; i++) await b.appeler({ email: `p${i}@exemple.fr`, retour: RETOUR });
  await assert.rejects(b.appeler({ email: 'autre@exemple.fr', retour: RETOUR }), (e) => e.code === 'resource-exhausted');
  // Une autre adresse internet passe ; X-Forwarded-For : c'est le dernier élément qui compte (le premier est écrit par l'appelant).
  await b.appeler({ email: 'autre@exemple.fr', retour: RETOUR }, '198.51.100.1');
  assert.strictEqual(b.envois.length, LIMITES_CONNEXION.parIp + 1);
  const g = banc();
  for (let i = 0; i < LIMITES_CONNEXION.total; i++) await g.appeler({ email: `p${i}@exemple.fr`, retour: RETOUR }, `198.51.100.${i}`);
  await assert.rejects(g.appeler({ email: 'x@exemple.fr', retour: RETOUR }, '192.0.2.1'), (e) => e.code === 'resource-exhausted');
  assert.strictEqual(g.envois.length, LIMITES_CONNEXION.total);
});

test('compterEnvoi et adresseAppelant (purs)', () => {
  const T = 1_000_000_000;
  assert.deepStrictEqual(compterEnvoi(null, 3, T), [T]);
  assert.deepStrictEqual(compterEnvoi([T - 3_700_000, T - 10, 'x'], 2, T), [T - 10, T]);
  assert.strictEqual(compterEnvoi([T - 3, T - 2, T - 1], 3, T), null);
  assert.strictEqual(adresseAppelant({ headers: { 'x-forwarded-for': 'faux, 203.0.113.9' } }), '203.0.113.9');
  assert.strictEqual(adresseAppelant({ headers: {}, ip: '127.0.0.1' }), '127.0.0.1');
});

test('panne du lien ou de l\'e-mail : erreur claire, jamais de repli', async () => {
  const b = banc();
  b.auth.generateSignInWithEmailLink = async () => { throw new Error('quota'); };
  await assert.rejects(b.appeler({ email: 'julie@exemple.fr', retour: RETOUR }), (e) => e.code === 'unavailable');
  const c = connexion.creer({
    db: fausseBase(), auth: { generateSignInWithEmailLink: async () => 'https://x/lien' }, mail,
    envoyerMail: async () => { throw new Error('SMTP'); }, logger: { warn() {}, error() {} },
  });
  await assert.rejects(c({ data: { email: 'julie@exemple.fr', retour: RETOUR }, rawRequest: { headers: {} } }), (e) => e.code === 'unavailable');
});

test('plafond du jour : au-delà de 100 liens, rien ne part de Papote et l\'appli reçoit « repli » (Tanguy, 27/11)', async () => {
  const b = banc();
  const jour = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  b.db.docs.set(`limites/connexion-jour-${jour}`, { n: LIMITES_CONNEXION.parJour - 1 });
  assert.deepStrictEqual(await b.appeler({ email: 'julie@exemple.fr', retour: RETOUR }), { ok: true });
  assert.strictEqual(b.envois.length, 1);
  assert.strictEqual(b.db.docs.get(`limites/connexion-jour-${jour}`).n, LIMITES_CONNEXION.parJour);
  assert.deepStrictEqual(await b.appeler({ email: 'paul@exemple.fr', retour: RETOUR }), { ok: true, repli: true });
  assert.strictEqual(b.envois.length, 1, 'aucun e-mail de Papote au-delà du plafond');
  assert.strictEqual(b.liens.length, 1, 'aucun lien fabriqué au-delà du plafond');
  assert.match(b.journal.join('\n'), /plafond du jour atteint/);
});

test('réserve des e-mails urgents entamée : repli aussi, même sous le plafond du jour', async () => {
  const envois = [];
  const f = connexion.creer({
    db: fausseBase(), auth: { generateSignInWithEmailLink: async () => 'https://x/lien' }, mail,
    envoyerMail: async (a) => { envois.push(a); }, logger: { warn() {}, error() {} }, reserveEntamee: async () => true,
  });
  assert.deepStrictEqual(await f({ data: { email: 'julie@exemple.fr', retour: RETOUR }, rawRequest: { headers: {} } }), { ok: true, repli: true });
  assert.strictEqual(envois.length, 0);
});
