// SOS de la tablette (audit 05/11) : pause de l'abonnement, enchaînement des proches par la carte SIM,
// messagerie vocale, appel par internet pendant la pause.
// Lancement : node --test android/tests/
const test = require('node:test');
const assert = require('node:assert');
const { ouvrir, lot } = require('./banc');

const PROCHES = {
  faces: {}, birthdays: [],
  people: [
    { uid: 'julie', name: 'Julie', tel: '0612345678', responsable: false },
    { uid: 'paul', name: 'Paul', tel: '0700000000', responsable: true },
    { uid: 'marc', name: 'Marc', tel: '0611111111', responsable: false },
  ],
};
const PAUL = { sortant: true, numero: '0700000000', uid: 'paul', name: 'Paul' };

async function tablette(etat = {}, champs = {}) {
  const b = await ouvrir('2026-10-26T10:00:00', { telephone: true, ...etat });
  await b.android('onPosts', lot([], champs));
  await b.android('onFamily', PROCHES);
  await b.avancer(500);
  // Appel internet imité : on note chaque départ (sos 1 ou 2).
  await b.page.evaluate(() => {
    window.__internet = [];
    window.papoteCallFamily = (o) => { window.__internet.push(o.sos || o.to); return { hangup() {} }; };
  });
  return b;
}
// Numéros appelés par la carte SIM (appel ordinaire ou appel de SOS).
const appelsTel = async (b) => (await b.appels()).filter((a) => a.nom === 'phoneCall' || a.nom === 'phoneCallSos').map((a) => a.args[0]);
const internet = (b) => b.page.evaluate(() => window.__internet);
const ecran = async (b) => (await b.texte('.call-out')).replace(/\s+/g, ' ').trim();

test('SOS (F-b) : Android retire l\'appel sans réponse 1 s après « fin » : le proche suivant est appelé quand même', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(46000); // 45 s sans réponse : la page raccroche
    // Android réel : « fin » publiée à DISCONNECTING, l'appel n'est retiré (onCallRemoved) qu'un peu après :
    // jusque-là phoneCall répond false (AppelGsm.enCours()).
    await b.etat({ telephoneKo: true });
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(1000);
    await b.etat({ telephoneKo: false }); // onCallRemoved
    await b.avancer(1000);
    const tel = await appelsTel(b);
    assert.strictEqual(tel[tel.length - 1], '0612345678', `Julie appelée après Paul (appels : ${tel.join(', ')})`);
    assert.ok(!tel.includes('0611111111'), 'Marc pas encore appelé');
    assert.deepStrictEqual(await internet(b), [], 'pas de repli internet tant qu\'il reste des proches');
    assert.match(await ecran(b), /SOS : on appelle Julie/);
  } finally { await b.fermer(); }
});
