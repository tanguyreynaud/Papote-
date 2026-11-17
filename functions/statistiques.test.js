const test = require('node:test');
const assert = require('node:assert');
const s = require('./statistiques');

const FV = { increment: (n) => ({ inc: n }) };

test('provenance : familles connues, notre site et vide = direct, le reste = autre', () => {
  const cas = {
    'www.google.fr': 'google', 'google.com': 'google', 'news.google.com': 'google', 'bing.com': 'bing', 'www.qwant.com': 'qwant',
    'lite.qwant.com': 'qwant', 'duckduckgo.com': 'duckduckgo', 'www.ecosia.org': 'ecosia', 'fr.search.yahoo.com': 'yahoo',
    'l.facebook.com': 'facebook', 'm.facebook.com': 'facebook', 'l.instagram.com': 'instagram', 'web.whatsapp.com': 'whatsapp',
    'www.linkedin.com': 'linkedin', 'lnkd.in': 'linkedin', 'youtube.com': 'youtube', 't.co': 'x', 'www.leboncoin.fr': 'leboncoin',
    'mail.google.com': 'email', 'outlook.live.com': 'email', 'webmail.free.fr': 'email', 'mail.orange.fr': 'email',
    'mapapote.fr': 'direct', 'www.mapapote.fr': 'direct', 'papote.web.app': 'direct', '': 'direct',
    'blog-de-mamie.fr': 'autre', 'googlefake.com': 'autre', 'evil.com/google.com': 'autre', 'pas un site': 'autre',
  };
  for (const [hote, attendu] of Object.entries(cas)) assert.strictEqual(s.source(hote), attendu, hote);
});

test('provenance : utm_source prioritaire, et seulement dans la liste fermée', () => {
  assert.strictEqual(s.source('google.fr', 'facebook'), 'facebook');
  assert.strictEqual(s.source('', 'newsletter'), 'email');
  assert.strictEqual(s.source('', 'FB'), 'facebook');
  assert.strictEqual(s.source('', 'Mon Super Site'), 'direct');
  assert.strictEqual(s.source('bing.com', 'n\'importe quoi'), 'bing');
});

test('compteur : étape inconnue refusée, visite comptée avec sa provenance, rien d\'autre gardé', () => {
  assert.strictEqual(s.increments({ e: 'paye' }, FV), null, 'paye ne vient que du serveur (paiement reçu)');
  assert.strictEqual(s.increments({ e: 'prevenir' }, FV), null);
  assert.strictEqual(s.increments({ e: '__proto__' }, FV), null);
  assert.strictEqual(s.increments({}, FV), null);
  assert.deepStrictEqual(s.increments({ e: 'relais', r: 'google.fr' }, FV), { relais: { inc: 1 } });
  assert.deepStrictEqual(s.increments({ e: 'visite', r: 'www.google.fr', u: '' }, FV), { visite: { inc: 1 }, sources: { google: { inc: 1 } } });
  for (const e of s.ETAPES_SITE) assert.ok(s.increments({ e }, FV), e);
});

test('jour de Paris : minuit à Paris, pas en UTC', () => {
  assert.strictEqual(s.jourDeParis(Date.UTC(2026, 10, 17, 23, 30)), '2026-11-18');
  assert.strictEqual(s.jourDeParis(Date.UTC(2026, 6, 1, 21, 59)), '2026-07-01');
  assert.strictEqual(s.jourDeParis(Date.UTC(2026, 6, 1, 22, 0)), '2026-07-02');
});

test('résumé : totaux, provenance additionnée, anciens jours sans « visite » repris de l\'accueil', () => {
  const r = s.resume([
    { id: '2026-11-15', data: { accueil: 40, commande: 12, relais: 3, paiement: 2, paye: 1 } },
    { id: '2026-11-17', data: { visite: 50, accueil: 45, commande: 10, paye: 2, prevenir: 1, sources: { google: 30, direct: 20 } } },
    { id: '2026-11-18', data: { visite: 5, sources: { google: 1, facebook: 4 }, bizarre: 999 } },
  ]);
  assert.strictEqual(r.jours.length, 3);
  assert.strictEqual(r.jours[0].visite, 40);
  assert.strictEqual(r.total.visite, 95);
  assert.strictEqual(r.total.paye, 3);
  assert.strictEqual(r.total.prevenir, 1);
  assert.strictEqual(r.total.bizarre, undefined);
  assert.deepStrictEqual(r.sources, { google: 31, direct: 20, facebook: 4 });
  assert.strictEqual(r.jours[2].commande, 0);
});
