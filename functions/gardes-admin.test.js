// Toute fonction « gestion… » appelable depuis une appli (tableau de bord) commence par vérifier que l'appelant est
// l'administrateur (audit sécurité, nuit du 19/11). Aucun essai ne le vérifiait fonction par fonction : une nouvelle
// fonction écrite sans la vérification, ou une vérification effacée, serait passée. Lecture du code, sans émulateur.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Corps de chaque « exports.gestionX = onCall(… » : jusqu'à la fermeture « }); » en début de ligne.
function fonctionsGestion(fichier) {
  const texte = fs.readFileSync(path.join(__dirname, fichier), 'utf8');
  const trouvees = [];
  const debut = /^exports\.(gestion[A-Za-z0-9]*) = onCall\(/gm;
  for (let m = debut.exec(texte); m; m = debut.exec(texte)) {
    const fin = texte.indexOf('\n});', m.index);
    assert.ok(fin > 0, `${fichier} : fin de ${m[1]} introuvable`);
    trouvees.push({ nom: m[1], corps: texte.slice(m.index, fin) });
  }
  return trouvees;
}

// La vérification doit venir avant toute lecture ou écriture de la base, de Stripe ou d'un e-mail.
// Deux écritures admises : verifierAdmin(request), ou le même refus écrit sur place (gestionStatistiques).
const VERIFIE = /verifierAdmin\(request\)|token\.admin !== true\) throw new HttpsError\('permission-denied'/;
const AGIT = /\bdb\(\)|\bdb\.|stripe\(\)|envoyerMail|mail\.envoyer|stockage\(\)|await /;

test('fonctions gestion… : l\'administrateur est vérifié avant toute action', () => {
  const toutes = [...fonctionsGestion('gestion.js'), ...fonctionsGestion('index.js')];
  assert.ok(toutes.length >= 25, `seulement ${toutes.length} fonctions trouvées : le motif de lecture ne marche plus`);
  for (const { nom, corps } of toutes) {
    const lignes = corps.split('\n').slice(1);
    const v = lignes.findIndex((l) => VERIFIE.test(l));
    assert.ok(v >= 0, `${nom} : l'administrateur n'est pas vérifié`);
    const avant = lignes.slice(0, v).filter((l) => !/^\s*\/\//.test(l) && AGIT.test(l));
    assert.deepStrictEqual(avant, [], `${nom} : une action avant la vérification de l'administrateur`);
  }
});

test('verifierAdmin refuse un inconnu, un proche et un jeton sans le droit admin', () => {
  const texte = fs.readFileSync(path.join(__dirname, 'gestion.js'), 'utf8');
  const m = /function verifierAdmin\(request\) \{[\s\S]*?\n\}/.exec(texte);
  assert.ok(m, 'verifierAdmin introuvable dans gestion.js');
  // eslint-disable-next-line no-new-func
  const verifierAdmin = new Function('HttpsError', `${m[0]}; return verifierAdmin;`)(class extends Error {
    constructor(code, message) { super(message); this.code = code; }
  });
  assert.throws(() => verifierAdmin({}), (e) => e.code === 'permission-denied' || e.code === 'unauthenticated');
  assert.throws(() => verifierAdmin({ auth: { uid: 'julie', token: {} } }));
  assert.throws(() => verifierAdmin({ auth: { uid: 'julie', token: { admin: 'true' } } }));
  assert.doesNotThrow(() => verifierAdmin({ auth: { uid: 'tanguy', token: { admin: true } } }));
});
