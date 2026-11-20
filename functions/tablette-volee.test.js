const test = require('node:test');
const assert = require('node:assert');
const { verifierParams, planRevocation, revoquer, apresOrdre } = require('./tablette-volee');

// Fausse base Firestore : juste ce que revoquer() utilise.
function fausseBase(docs) {
  const ecrits = [];
  let n = 0;
  const ref = (chemin) => ({
    path: chemin,
    id: chemin.split('/').pop(),
    set: async (v) => { docs[chemin] = v; ecrits.push(['set', chemin]); },
    update: async (v) => { docs[chemin] = { ...docs[chemin], ...v }; ecrits.push(['update', chemin]); },
    delete: async () => { delete docs[chemin]; ecrits.push(['delete', chemin]); },
  });
  const requete = (col, filtres) => ({
    where: (champ, op, valeur) => requete(col, [...filtres, [champ, valeur]]),
    limit: () => requete(col, filtres),
    get: async () => ({
      docs: Object.keys(docs)
        .filter((c) => c.startsWith(`${col}/`) && c.split('/').length === col.split('/').length + 1)
        .filter((c) => filtres.every(([k, v]) => docs[c][k] === v))
        .map((c) => ({ ref: ref(c), data: () => docs[c], get: (k) => docs[c][k] })),
    }),
  });
  return {
    ecrits,
    doc: ref,
    collection: (col) => ({ ...requete(col, []), doc: () => ref(`${col}/ordre${++n}`) }),
  };
}

function fauxAuth(absents = []) {
  const a = { desactives: [], revoques: [] };
  a.updateUser = async (uid, v) => { if (absents.includes(uid)) throw new Error('user-not-found'); if (v.disabled) a.desactives.push(uid); };
  a.revokeRefreshTokens = async (uid) => { if (absents.includes(uid)) throw new Error('user-not-found'); a.revoques.push(uid); };
  return a;
}

const deps = (db, auth) => ({
  db, auth, qui: 'admin-uid', maintenant: () => 1000,
  supprimerChamp: () => '__supprime__', ajouterHistorique: (x) => ({ __ajout__: x }), horodatage: () => '__now__',
});

function parc() {
  return {
    'stock/T-007': { serieAndroid: 'BV123456', etat: 'chez-client', fid: 'f1', tabletUid: 'tab', callsUid: 'app' },
    'families/f1/members/tab': { name: 'Tablette', role: 'tablet' },
    'families/f1/members/app': { name: 'Appels', role: 'tablet' },
    'families/f1/members/marie': { name: 'Marie', telephone: '0612345678' },
    'clesTablettes/abc': { serie: 'BV123456', tabletUid: 'tab' },
    'clesTablettes/def': { serie: 'AUTRE999' },
  };
}

test('paramètres : n° de série obligatoire, options booléennes strictes', () => {
  assert.ok(verifierParams({}).erreur);
  assert.ok(verifierParams({ serie: ' ab ' }).erreur);
  assert.deepStrictEqual(verifierParams({ serie: ' BV123456 ', effacer: 'oui' }), { serie: 'BV123456', effacer: false, couperTout: false });
});

test('plan : ordre avant la sortie de la famille, compte appels coupé tout de suite, tablette après l\'ordre', () => {
  const plan = planRevocation({ fid: 'f1', tabletUid: 'tab', callsUid: 'app' }, { effacer: false, couperTout: false });
  assert.deepStrictEqual(plan.ordre, { type: 'verrouiller', target: 'tab' });
  assert.deepStrictEqual(plan.desactiver, ['app']);
  assert.deepStrictEqual(plan.membres, ['families/f1/members/tab', 'families/f1/members/app']);
  assert.strictEqual(planRevocation({ fid: 'f1', tabletUid: 'tab' }, { effacer: true }).ordre.type, 'usine');
  assert.deepStrictEqual(planRevocation({ fid: 'f1', tabletUid: 'tab', callsUid: 'app' }, { couperTout: true }).desactiver, ['app', 'tab']);
  // Déjà sortie de sa famille (Stock > Perdue fait avant) : plus d'ordre possible, on coupe tout.
  const sans = planRevocation({ fid: null, tabletUid: 'tab', callsUid: 'app' }, {});
  assert.strictEqual(sans.ordre, null);
  assert.deepStrictEqual(sans.desactiver, ['app', 'tab']);
});

test('révocation complète : ordre, fiches membre, comptes, clés App Check, fiche stock', async () => {
  const docs = parc();
  const db = fausseBase(docs);
  const auth = fauxAuth();
  const r = await revoquer(deps(db, auth), { serie: 'BV123456' });
  assert.strictEqual(r.ok, true);
  // 1. l'ordre est écrit AVANT la suppression des fiches membre
  const iOrdre = db.ecrits.findIndex(([op, c]) => op === 'set' && c.startsWith('families/f1/commands/'));
  const iMembre = db.ecrits.findIndex(([op, c]) => op === 'delete' && c === 'families/f1/members/tab');
  assert.ok(iOrdre >= 0 && iOrdre < iMembre);
  const ordre = docs[r.ordre];
  assert.deepStrictEqual({ type: ordre.type, target: ordre.target, serie: ordre.serie, state: ordre.state, revoquer: ordre.revoquer },
    { type: 'verrouiller', target: 'tab', serie: 'BV123456', state: 'pending', revoquer: true });
  // 2. plus membre ; les proches restent
  assert.strictEqual(docs['families/f1/members/tab'], undefined);
  assert.strictEqual(docs['families/f1/members/app'], undefined);
  assert.ok(docs['families/f1/members/marie']);
  // 3. compte appels désactivé, les deux révoqués ; la tablette reste active pour lire l'ordre
  assert.deepStrictEqual(auth.desactives, ['app']);
  assert.deepStrictEqual(auth.revoques.sort(), ['app', 'tab']);
  // 4. seule la clé de cette tablette est retirée
  assert.strictEqual(docs['clesTablettes/abc'], undefined);
  assert.ok(docs['clesTablettes/def']);
  // 5. fiche stock
  const s = docs['stock/T-007'];
  assert.strictEqual(s.etat, 'perdue');
  assert.strictEqual(s.fid, null);
  assert.strictEqual(s.tabletUid, null);
  assert.strictEqual(s.revocation.tabletUid, 'tab');
  assert.ok(r.attente);
});

test('compte déjà supprimé : le reste se fait quand même', async () => {
  const docs = parc();
  const auth = fauxAuth(['app']);
  const r = await revoquer(deps(fausseBase(docs), auth), { serie: 'BV123456', couperTout: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(auth.desactives, ['tab']);
  assert.strictEqual(r.erreurs.length, 2);
  assert.strictEqual(docs['stock/T-007'].etat, 'perdue');
});

test('n° de série inconnu : rien n\'est touché', async () => {
  const docs = parc();
  const db = fausseBase(docs);
  const r = await revoquer(deps(db, fauxAuth()), { serie: 'INCONNU1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(db.ecrits.length, 0);
});

test('après l\'ordre : désactiver le compte une seule fois, seulement pour un ordre de révocation', () => {
  assert.strictEqual(apresOrdre({ state: 'pending' }, { state: 'done', revoquer: true, target: 'tab' }), 'tab');
  assert.strictEqual(apresOrdre({ state: 'pending' }, { state: 'failed', revoquer: true, target: 'tab' }), 'tab');
  assert.strictEqual(apresOrdre({ state: 'pending' }, { state: 'running', revoquer: true, target: 'tab' }), null);
  assert.strictEqual(apresOrdre({ state: 'done' }, { state: 'done', revoquer: true, target: 'tab' }), null);
  assert.strictEqual(apresOrdre({ state: 'pending' }, { state: 'done', target: 'tab' }), null);
});

// Audit du 19/11 (prouvé sur l'émulateur des règles) : pendant les 24 h qui suivent son jumelage, le compte d'une
// tablette révoquée recréait sa fiche membre avec son code encore « confirmé » et relisait les photos.
test('révocation : les codes de jumelage confirmés de cette tablette sont annulés, pas ceux des autres', async () => {
  const docs = {
    ...parc(),
    'pairings/QRST6789': { status: 'confirmed', fid: 'f1', tabletUid: 'tab', callsUid: 'app' },
    'pairings/VIEUX234': { status: 'waiting', tabletUid: 'tab' },
    'pairings/AUTRE567': { status: 'confirmed', fid: 'f2', tabletUid: 'autre-tablette' },
  };
  const db = fausseBase(docs);
  const r = await revoquer(deps(db, fauxAuth()), { serie: 'BV123456' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.codes, 1);
  assert.deepStrictEqual(docs['pairings/QRST6789'], { status: 'closed', fid: 'f1', tabletUid: 'tab', callsUid: 'app', closedAt: new Date(1000) });
  assert.strictEqual(docs['pairings/VIEUX234'].status, 'waiting');
  assert.strictEqual(docs['pairings/AUTRE567'].status, 'confirmed');
  // Le code est annulé avant la suppression des fiches : la tablette ne peut pas rentrer entre les deux.
  const iMembre = db.ecrits.findIndex(([op, c]) => op === 'delete' && c === 'families/f1/members/tab');
  const iCode = db.ecrits.findIndex(([op, c]) => op === 'update' && c === 'pairings/QRST6789');
  assert.ok(iCode >= 0 && iCode < iMembre);
});

test('révocation d\'une tablette de remplacement : le code de remplacement qu\'elle a pris est effacé, le code famille reste', async () => {
  const docs = {
    ...parc(),
    'invites/TABL2345': { kind: 'tablette', fid: 'f1', usedBy: 'tab', callsUid: 'app' },
    'invites/ABCD2345': { fid: 'f1', createdBy: 'marie' },
    'invites/TABL9999': { kind: 'tablette', fid: 'f2', usedBy: 'autre-tablette' },
  };
  const db = fausseBase(docs);
  const r = await revoquer(deps(db, fauxAuth()), { serie: 'BV123456' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.codes, 1);
  assert.strictEqual(docs['invites/TABL2345'], undefined);
  assert.ok(docs['invites/ABCD2345']);
  assert.ok(docs['invites/TABL9999']);
});

const { fermerCodes, tabletteSortie } = require('./tablette-volee');

test('fiche membre d\'une tablette supprimée (remplacement, retour, famille supprimée) : ses codes sont fermés', async () => {
  const docs = {
    'pairings/QRST6789': { status: 'confirmed', fid: 'f1', tabletUid: 'tab', callsUid: 'app' },
    'pairings/AUTRE567': { status: 'confirmed', fid: 'f2', tabletUid: 'autre', callsUid: 'autre-appels' },
    'invites/TABL2345': { kind: 'tablette', fid: 'f1', usedBy: 'tab' },
    'invites/ABCD2345': { fid: 'f1', createdBy: 'marie' },
  };
  const db = fausseBase(docs);
  // Le compte des appels sort : le code qui le ferait rentrer est annulé une seule fois, même vu par ses deux champs.
  assert.strictEqual(await fermerCodes(db, 'app', 2000), 1);
  assert.deepStrictEqual(docs['pairings/QRST6789'], { status: 'closed', fid: 'f1', tabletUid: 'tab', callsUid: 'app', closedAt: new Date(2000) });
  // Le compte principal sort ensuite : code de jumelage déjà annulé, code de remplacement effacé.
  assert.strictEqual(await fermerCodes(db, 'tab', 3000), 1);
  assert.strictEqual(docs['invites/TABL2345'], undefined);
  assert.deepStrictEqual(docs['pairings/QRST6789'].closedAt, new Date(2000));
  // Rien d'autre n'est touché ; un uid vide ne lit rien.
  assert.strictEqual(docs['pairings/AUTRE567'].status, 'confirmed');
  assert.ok(docs['invites/ABCD2345']);
  assert.strictEqual(await fermerCodes(db, '', 1), 0);
  assert.strictEqual(await fermerCodes(db, undefined, 1), 0);
});

test('code supprimé entre la lecture et la fermeture (famille en cours d\'effacement) : pas d\'erreur', async () => {
  const doc = (update) => ({ get: (k) => ({ status: 'confirmed' })[k], ref: { path: 'pairings/X', update } });
  const base = (update) => ({ collection: (nom) => ({ where: () => ({ get: async () => ({ docs: nom === 'pairings' ? [doc(update)] : [] }) }) }) });
  const absent = Object.assign(new Error('5 NOT_FOUND: no entity to update'), { code: 5 });
  assert.strictEqual(await fermerCodes(base(async () => { throw absent; }), 'tab', 1), 0);
  // Une autre erreur (réseau, droits) remonte toujours.
  await assert.rejects(fermerCodes(base(async () => { throw Object.assign(new Error('panne'), { code: 14 }); }), 'tab', 1), /panne/);
});

test('sortie d\'une tablette : seulement la suppression d\'une fiche de rôle « tablette »', () => {
  assert.strictEqual(tabletteSortie({ role: 'tablette', name: 'Tablette' }, null), true);
  assert.strictEqual(tabletteSortie({ role: 'famille' }, null), false); // un proche qui part
  assert.strictEqual(tabletteSortie({ role: 'tablette' }, { role: 'tablette', lastOnline: 1 }), false); // battement
  assert.strictEqual(tabletteSortie(null, { role: 'tablette' }), false); // entrée
  assert.strictEqual(tabletteSortie(null, null), false);
});
