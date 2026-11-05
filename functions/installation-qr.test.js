const test = require('node:test');
const assert = require('node:assert');
const q = require('./installation-qr');

const H = 3600 * 1000;
const SHA = 'a'.repeat(40);
const URL_OK = `https://raw.githubusercontent.com/tanguyreynaud/Papote-/${SHA}/installation/Papote.apk`;

test('jeton : 32 caractères base64url', () => {
  assert.strictEqual(q.jetonValide('A'.repeat(32)), true);
  assert.strictEqual(q.jetonValide('A'.repeat(31)), false);
  assert.strictEqual(q.jetonValide(`${'A'.repeat(31)}=`), false);
  assert.strictEqual(q.jetonValide(null), false);
});

test('n° de série et ICCID : propres ou refusés', () => {
  assert.strictEqual(q.serieValide(' R9TT1234ABC '), 'R9TT1234ABC');
  assert.strictEqual(q.serieValide('unknown'), null);
  assert.strictEqual(q.serieValide('0000'), null);
  assert.strictEqual(q.serieValide('a b'), null);
  assert.strictEqual(q.iccidValide('8933 1500 0000 0000 0001'), '89331500000000000001');
  assert.strictEqual(q.iccidValide('123'), null);
});

test('inscription : 24 h, une seule tablette, nouveaux essais permis avec le même n° de série', () => {
  const t0 = 1_000_000_000_000;
  const inst = { expire: t0 + 24 * H, serie: null, essais: 0 };
  assert.deepStrictEqual(q.decisionInscription(null, 'S1', t0), { etat: 'inconnu' });
  assert.deepStrictEqual(q.decisionInscription(inst, 'S1', t0), { etat: 'premiere' });
  const inscrite = { ...inst, serie: 'S1', essais: 1 };
  assert.deepStrictEqual(q.decisionInscription(inscrite, 'S1', t0 + H), { etat: 'nouvel-essai' });
  assert.deepStrictEqual(q.decisionInscription(inscrite, 'S2', t0 + H), { etat: 'autre-tablette' });
  assert.deepStrictEqual(q.decisionInscription(inscrite, 'S1', t0 + 24 * H), { etat: 'expire' });
  assert.deepStrictEqual(q.decisionInscription({ ...inscrite, essais: q.MAX_ESSAIS }, 'S1', t0), { etat: 'trop' });
});

test('critères : hors critères gardé avec son détail, jamais refusé ici', () => {
  assert.deepStrictEqual(q.criteresPropres(true, {}), { ok: true, detail: [], simPin: false, mesures: {} });
  assert.strictEqual(q.criteresPropres(undefined, undefined).ok, true);
  // Ce qu'envoie la tablette (android/…/Installation.java).
  const r = q.criteresPropres(false, { pouces: 8.04, android13: false, camera: true, simPin: false, ok: false, manque: 'écran 8.0" ; Android 11 ; ' });
  assert.deepStrictEqual(r, { ok: false, detail: ['écran 8.0"', 'Android 11'], simPin: false, mesures: { pouces: 8, android13: false, camera: true } });
  // Carte SIM avec code PIN : toujours signalée, même si la tablette dit « ok ».
  const pin = q.criteresPropres(true, { simPin: true, ok: true, manque: '' });
  assert.strictEqual(pin.ok, false);
  assert.strictEqual(pin.simPin, true);
  assert.deepStrictEqual(pin.detail, ['carte SIM avec code PIN']);
  assert.deepStrictEqual(q.criteresPropres(false, ['Android trop ancien', 42]).detail, ['Android trop ancien', '42']);
});

test('fichier de version : seulement le dépôt Papote à un commit précis, ou maj.mapapote.fr', () => {
  assert.deepStrictEqual(q.apkDuFlux({ versionCode: 120, versionName: '2.99.120', url: URL_OK, sha256: 'x' }),
    { url: URL_OK, versionCode: 120, versionName: '2.99.120' });
  assert.ok(q.apkDuFlux({ versionCode: 3, url: 'https://maj.mapapote.fr/Papote.apk' }));
  assert.strictEqual(q.apkDuFlux({ versionCode: 3, url: URL_OK.replace('Papote.apk', 'Papote-test.apk') }), null);
  assert.strictEqual(q.apkDuFlux({ versionCode: 3, url: 'https://exemple.com/Papote.apk' }), null);
  assert.strictEqual(q.apkDuFlux({ versionCode: 3, url: URL_OK.replace(SHA, 'main') }), null);
  assert.strictEqual(q.apkDuFlux({ url: URL_OK }), null);
});

test('fichier de version : la plus récente des deux adresses, sans planter si l\'une manque', async () => {
  const reponses = {
    [q.FLUX[0]]: { versionCode: 119, versionName: '2.99.119', url: URL_OK },
    [q.FLUX[1]]: { versionCode: 120, versionName: '2.99.120', url: 'https://maj.mapapote.fr/Papote-120.apk' },
  };
  const chercher = async (u) => ({ ok: true, json: async () => reponses[u] });
  assert.strictEqual((await q.lireApk(chercher)).versionCode, 120);
  const enPanne = async (u) => { if (u === q.FLUX[1]) throw new Error('DNS'); return chercher(u); };
  assert.strictEqual((await q.lireApk(enPanne)).versionCode, 119);
  assert.strictEqual(await q.lireApk(async () => { throw new Error('rien'); }), null);
});

test('QR : contenu convenu avec la tablette, sans wifi', () => {
  const p = q.provisionnement({ jeton: 'J'.repeat(32), canal: 'test', apkUrl: URL_OK });
  assert.strictEqual(p['android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME'], 'com.papote.tablette/.AdminReceiver');
  assert.strictEqual(p['android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM'], '_yWAPegUjhtPlkspLstFmFlfmTSzn5Ywzxk_lFzSBZk');
  assert.strictEqual(p['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION'], URL_OK);
  assert.strictEqual(p['android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED'], false);
  assert.deepStrictEqual(p['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'], { papote_jeton: 'J'.repeat(32), papote_canal: 'test' });
  assert.ok(!Object.keys(p).some((k) => /WIFI/.test(k)));
});

test('fiche d\'achat : réception ouverte, n° tapé, un seul achat ; plusieurs achats → pas de devinette', () => {
  const a1 = { id: 'a1', depense: 'd1', modele: 'Tab 60 Pro' };
  const a2 = { id: 'a2', depense: 'd1', modele: 'Tab 60 Pro' };
  const b1 = { id: 'b1', depense: 'd2', modele: 'Tab 60 Pro' };
  assert.deepStrictEqual(q.choisirFiche([a1, a2], 'S1', 'Tab 60 Pro'), { id: 'a1', ambigu: false });
  assert.deepStrictEqual(q.choisirFiche([a1, b1], 'S1', 'Tab 60 Pro'), { id: null, ambigu: true });
  assert.deepStrictEqual(q.choisirFiche([a1, { ...b1, numero: 's 1' }], 'S1', 'x'), { id: 'b1', ambigu: false });
  assert.deepStrictEqual(q.choisirFiche([a1, { ...b1, reception: { etape: 2 } }], 'S1', 'x'), { id: 'b1', ambigu: false });
  assert.deepStrictEqual(q.choisirFiche([a1, { ...b1, modele: 'M107' }], 'S1', 'M107'), { id: 'b1', ambigu: false });
  assert.deepStrictEqual(q.choisirFiche([], 'S1', 'M107'), { id: null, ambigu: false });
});

test('stock à vendre : ni tablette d\'essai, ni hors critères pas acceptée', () => {
  const { tablettesDisponibles } = require('./stock');
  const stock = [{ etat: 'preparee' }, { etat: 'preparee', essai: true }, { etat: 'en-stock', horsCriteres: { detail: ['x'] } }, { etat: 'en-stock', horsCriteres: null }];
  assert.strictEqual(tablettesDisponibles({ stock, commandes: [], reservations: [], maintenant: 0 }), 2);
});
