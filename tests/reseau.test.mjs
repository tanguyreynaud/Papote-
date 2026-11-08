// Réseau mobile chez le client (admin) : opérateur d'une antenne d'après sa fréquence (web/js/frequences.js, blocs
// Arcep) et « Vu » sur l'alerte réseau (web/js/sim.js). Sans dépendance : node --test tests/reseau.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCS, mhzLte, mhzNr, mhzUmts, mhzGsm, operateurDeMhz, operateurParFrequence } from '../web/js/frequences.js';
import { reseauMobile, reseauAVoir, reseauVuDe } from '../web/js/sim.js';

const lte = (earfcn) => operateurParFrequence({ type: '4G', earfcn });

test('blocs Arcep : dans chaque bande, des blocs qui se suivent sans trou ni chevauchement', () => {
  for (const [bande, blocs] of Object.entries(BLOCS)) {
    for (let i = 0; i < blocs.length; i += 1) {
      assert.ok(blocs[i][0] < blocs[i][1], `${bande} : bloc ${i} à l'envers`);
      if (i) assert.equal(blocs[i][0], blocs[i - 1][1], `${bande} : trou ou chevauchement avant ${blocs[i][2]}`);
    }
  }
  // Largeurs attribuées (MHz duplex), comme dans les décisions Arcep.
  const largeur = (bande, op) => BLOCS[bande].filter((b) => b[2] === op).reduce((t, [de, a]) => t + a - de, 0);
  assert.equal(largeur(700, 'Free'), 10); assert.equal(largeur(700, 'SFR'), 5);
  assert.equal(largeur(800, 'Free'), 0);
  assert.equal(Math.round(largeur(900, 'Free') * 10) / 10, 8.7);
  assert.equal(largeur(1800, 'Free'), 15); assert.equal(largeur(1800, 'Bouygues'), 20);
  assert.equal(Math.round(largeur(2100, 'Orange') * 10) / 10, 14.8);
  assert.equal(largeur(2600, 'Free'), 20); assert.equal(largeur(2600, 'SFR'), 15);
});

test('EARFCN → MHz (3GPP 36.101)', () => {
  assert.equal(mhzLte(6400), 816);
  assert.equal(mhzLte(1300), 1815);
  assert.equal(mhzLte(9385), 775.5);
  assert.equal(mhzLte(3350), 2680);
  assert.equal(mhzLte(375), 2147.5);
  assert.equal(mhzLte(3700), 950);
  assert.equal(mhzLte(37900), null); // bande 38 (TDD) : pas attribuée aux opérateurs en métropole
  assert.equal(mhzLte(1150), null);
});

test('4G : un canal central connu par opérateur et par bande', () => {
  const attendus = {
    // bande 28 (700 MHz)
    9235: 'SFR', 9310: 'Orange', 9385: 'Bouygues', 9460: 'Free',
    // bande 20 (800 MHz)
    6200: 'Bouygues', 6300: 'SFR', 6400: 'Orange',
    // bande 8 (900 MHz)
    3495: 'Bouygues', 3582: 'Orange', 3700: 'Free', 3705: 'Free', 3755: 'SFR',
    // bande 3 (1800 MHz)
    1300: 'Orange', 1500: 'SFR', 1675: 'Free', 1850: 'Bouygues',
    // bande 1 (2100 MHz)
    79: 'SFR', 227: 'Bouygues', 375: 'Free', 523: 'Orange',
    // bande 7 (2600 MHz)
    2825: 'SFR', 3000: 'Orange', 3175: 'Bouygues', 3350: 'Free',
  };
  for (const [n, op] of Object.entries(attendus)) assert.equal(lte(Number(n)), op, `EARFCN ${n}`);
});

test('4G : limite entre deux opérateurs, trop près d\'une limite ou hors des blocs → rien (pas de devinette)', () => {
  assert.equal(lte(1400), null); // 1825 MHz : limite Orange / SFR
  assert.equal(lte(1396), null); // 1824,6 MHz : à 0,4 MHz de la limite, aucun canal 4G d'Orange n'y est centré
  assert.equal(lte(1393), 'Orange'); // 1824,3 MHz : à 0,7 MHz, un canal de 1,4 MHz tient encore
  assert.equal(lte(6150), null); // 791 MHz : bord de la bande 20
  assert.equal(lte(9600), null); // 797 MHz en bande 28 : au-dessus de 788 MHz, c'est la bande 800 (pas la 700)
  assert.equal(operateurDeMhz(797), 'Bouygues'); // la fréquence seule est bien dans le bloc 800 MHz de Bouygues
  assert.equal(lte(2), null); // 2110,2 MHz : sous le premier bloc 2,1 GHz (2110,5)
  assert.equal(operateurParFrequence({ type: '4G' }), null); // tablette qui n'envoie pas encore earfcn
  assert.equal(operateurParFrequence({ type: '4G', earfcn: '' }), null);
  assert.equal(operateurParFrequence({ type: '4G', earfcn: 'abc' }), null);
  assert.equal(operateurParFrequence({ type: '4G', earfcn: '6400' }), 'Orange');
  assert.equal(operateurParFrequence({ type: '', earfcn: 6400 }), null);
  assert.equal(operateurParFrequence(null), null);
});

test('5G, 3G et 2G : même tableau, d\'après leur numéro de canal', () => {
  assert.equal(mhzNr(643334), 3650.01);
  assert.equal(operateurParFrequence({ type: '5G', nrarfcn: 643334 }), 'Free'); // 3 650 MHz
  assert.equal(operateurParFrequence({ type: '5G', nrarfcn: 650000 }), 'Orange'); // 3 750 MHz
  assert.equal(operateurParFrequence({ type: '5G', nrarfcn: 636666 }), 'SFR'); // 3 550 MHz
  assert.equal(operateurParFrequence({ type: '5G', nrarfcn: 640000 }), 'Bouygues'); // 3 600 MHz
  assert.equal(mhzNr(640000), 3600);
  assert.equal(operateurParFrequence({ type: '5G', nrarfcn: 156100 }), 'Free'); // 780,5 MHz (n28)
  assert.equal(operateurParFrequence({ type: '5G', nrarfcn: 638000 }), null); // 3 570 MHz : limite SFR / Bouygues
  assert.equal(operateurParFrequence({ type: '5G', nrarfcn: 2016667 }), null);
  assert.equal(mhzUmts(10712), 2142.4);
  assert.equal(operateurParFrequence({ type: '3G', uarfcn: 10737 }), 'Free'); // 2147,4 MHz
  assert.equal(operateurParFrequence({ type: '3G', uarfcn: 10587 }), 'SFR'); // 2117,4 MHz
  assert.equal(operateurParFrequence({ type: '3G', uarfcn: 10712 }), 'Free'); // 2142,4 MHz : 2,3 MHz du bord, un canal 3G y tient
  assert.equal(operateurParFrequence({ type: '3G', uarfcn: 10710 }), null); // 2142 MHz : 1,9 MHz du bord, trop près
  assert.equal(mhzGsm(1), 935.2);
  assert.equal(mhzGsm(1000), 930.2);
  assert.equal(operateurParFrequence({ type: '2G', arfcn: 1000 }), 'Bouygues'); // 930,2 MHz
  assert.equal(operateurParFrequence({ type: '2G', arfcn: 600 }), 'Orange'); // 1822,8 MHz
});

test('reseauMobile : code opérateur d\'abord, puis fréquence, puis nom, puis « opérateur inconnu »', () => {
  const r = reseauMobile({ service: 'ok', antennes: [
    { reseau: '20820', nom: '', type: '4G', bande: 3, dbm: -112, utilisee: true, earfcn: 1300 }, // code Bouygues gagne
    { reseau: '', nom: '', type: '4G', bande: 20, dbm: -108, earfcn: 6400 },
    { reseau: '', nom: 'Free', type: '4G', bande: 28, dbm: -113 },
    { reseau: '', nom: '', type: '4G', bande: 3, dbm: -119, earfcn: 1400 },
    { reseau: '', nom: '', type: '4G', bande: 3, dbm: -125 },
  ] });
  assert.deepEqual(r.antennes.map((a) => a.operateur), ['Bouygues', 'Orange', 'Free', 'opérateur inconnu', 'opérateur inconnu']);
  assert.equal(r.antennes[1].texte, 'Orange 4G bande 20, -108 dBm');
  assert.equal(r.niveau, 1);
  assert.equal(r.dbm, -112);
  assert.equal(r.alerte, 'Réseau faible chez le client (Bouygues, -112 dBm)');
});

test('reseauMobile : une antenne d\'opérateur inconnu ne sert pas de « X capte mieux ici »', () => {
  const r = reseauMobile({ service: 'ok', antennes: [
    { reseau: '20820', type: '4G', bande: 3, dbm: -115, utilisee: true },
    { reseau: '', type: '4G', bande: 20, dbm: -95 },
  ] });
  assert.equal(r.alerte, 'Réseau faible chez le client (Bouygues, -115 dBm)');
  const r2 = reseauMobile({ service: 'ok', antennes: [
    { reseau: '20820', type: '4G', bande: 3, dbm: -115, utilisee: true },
    { reseau: '', type: '4G', bande: 20, dbm: -95, earfcn: 6400 },
  ] });
  assert.equal(r2.alerte, 'Réseau faible chez le client (Bouygues, -115 dBm) (Orange capte ici à -95 dBm)');
});

test('reseauMobile : niveaux de gravité', () => {
  const ant = (type, dbm) => [{ reseau: '20801', type, bande: 3, dbm, utilisee: true }];
  assert.equal(reseauMobile({ service: 'ok', antennes: ant('4G', -90) }).niveau, 0);
  assert.equal(reseauMobile({ service: 'ok', antennes: ant('4G', -90) }).alerte, null);
  assert.equal(reseauMobile({ service: 'ok', antennes: ant('4G', -111) }).niveau, 1);
  assert.equal(reseauMobile({ service: 'ok', antennes: ant('3G', -90) }).niveau, 2);
  assert.equal(reseauMobile({ service: 'ok', antennes: ant('2G', -90) }).niveau, 2);
  for (const service of ['urgences', 'hors service', 'eteint']) assert.equal(reseauMobile({ service, antennes: [] }).niveau, 3);
  assert.equal(reseauMobile({ sim: 1 }), null);
  assert.equal(reseauMobile(null), null);
});

test('« Vu » : l\'alerte part, et ne revient que si c\'est pire (10 dB de moins ou plus grave), jamais avec le temps', () => {
  const faible = (dbm) => reseauMobile({ service: 'ok', antennes: [{ reseau: '20820', type: '4G', bande: 3, dbm, utilisee: true }] });
  const vu = reseauVuDe(faible(-112), 1000);
  assert.deepEqual(vu, { niveau: 1, dbm: -112, le: 1000 });
  assert.equal(reseauAVoir(faible(-112), null), true);
  assert.equal(reseauAVoir(faible(-112), vu), false);
  assert.equal(reseauAVoir(faible(-115), vu), false);
  assert.equal(reseauAVoir(faible(-121), vu), false);
  assert.equal(reseauAVoir(faible(-122), vu), true); // 10 dB plus bas
  assert.equal(reseauAVoir(faible(-111), { ...vu, le: 0 }), false); // vu il y a longtemps : toujours caché
  const en3G = reseauMobile({ service: 'ok', antennes: [{ reseau: '20820', type: '3G', dbm: -100, utilisee: true }] });
  assert.equal(reseauAVoir(en3G, vu), true); // faible → 3G
  for (const service of ['urgences', 'hors service', 'eteint']) {
    const r = reseauMobile({ service, antennes: [] });
    assert.equal(reseauAVoir(r, vu), true, service);
    assert.equal(reseauAVoir(r, reseauVuDe(r)), false, `${service} vu`);
    assert.equal(reseauAVoir(faible(-125), reseauVuDe(r)), false, `${service} vu puis faible : moins grave`);
  }
  assert.equal(reseauAVoir(en3G, reseauVuDe(en3G)), false);
  // Plus d'alerte : rien à voir ; vu sans niveau (fiche abîmée) : on remontre.
  assert.equal(reseauAVoir(faible(-90), vu), false);
  assert.equal(reseauAVoir(faible(-112), { niveau: 0 }), true);
  assert.equal(reseauAVoir(faible(-112), {}), true);
});
