// Fautes de frappe dans l'e-mail sur le site (vitrine/email-correcteur.js, Tanguy 12/11 point 43).
const test = require('node:test');
const assert = require('node:assert');
const { suggestion } = require('../vitrine/email-correcteur.js');

test('fautes courantes : la bonne adresse est proposée', () => {
  const cas = {
    'jean@gmail.con': 'jean@gmail.com', 'jean@gmial.com': 'jean@gmail.com', 'jean@gmal.com': 'jean@gmail.com',
    'jean@gamil.com': 'jean@gmail.com', 'jean@gmail.fr': 'jean@gmail.com', 'jean@gmail.co': 'jean@gmail.com',
    'jean@hotmial.fr': 'jean@hotmail.fr', 'jean@hotmail.f': 'jean@hotmail.fr', 'jean@hotmai.fr': 'jean@hotmail.fr',
    'jean@orange.f': 'jean@orange.fr', 'jean@ornage.fr': 'jean@orange.fr', 'jean@wanado.fr': 'jean@wanadoo.fr',
    'jean@yahooo.fr': 'jean@yahoo.fr', 'jean@laposte.fr': 'jean@laposte.net', 'jean@lapost.net': 'jean@laposte.net',
    'jean@free.f': 'jean@free.fr', 'jean@icloud.con': 'jean@icloud.com', 'jean@outlok.fr': 'jean@outlook.fr',
    'Jean.Dupont@Gmail.Con': 'jean.dupont@gmail.com', 'jean@gmail.com.': 'jean@gmail.com', 'jean@gmail,com': 'jean@gmail.com',
    'jean@monentreprise.con': 'jean@monentreprise.com', 'jean@mairie-lyon.frr': 'jean@mairie-lyon.fr',
  };
  for (const [saisie, voulu] of Object.entries(cas)) assert.strictEqual(suggestion(saisie), voulu, saisie);
});

test('adresses correctes ou inconnues : rien n\'est proposé (on ne gêne jamais pour rien)', () => {
  for (const mel of ['jean@gmail.com', 'jean@orange.fr', 'jean@free.fr', 'jean@sfr.fr', 'jean@laposte.net', 'jean@gmx.fr',
    'jean@outlook.com', 'jean@proton.me', 'jean@mapapote.fr', 'jean@cabinet-martin.fr', 'jean@univ-lyon1.fr',
    'jean@orange.com', 'jean@free.com', 'jean@sncf.fr', 'jean@edf.fr', 'jean@ac-lyon.fr', 'jean@me.com', 'jean@msn.com',
    '', 'jean', '@gmail.com', 'jean@', null]) {
    assert.strictEqual(suggestion(mel), null, String(mel));
  }
});
