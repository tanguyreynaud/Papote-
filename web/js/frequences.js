// Opérateur d'une antenne d'après sa fréquence (France métropolitaine), pour les antennes voisines : Android ne donne
// le code opérateur (MCC/MNC) que pour l'antenne utilisée, les autres arrivent « opérateur inconnu ».
//
// Source : autorisations d'utilisation de fréquences de l'Arcep, lues le 08/11/2026 (liste à jour du 09/07/2026 :
// https://www.arcep.fr/la-regulation/grands-dossiers-reseaux-mobiles/la-couverture-mobile-en-metropole/le-patrimoine-de-frequences-des-operateurs-mobiles.html).
// Décisions (https://www.arcep.fr/uploads/tx_gsavis/<n°>.pdf), voie descendante seulement :
//   700 MHz  : 15-1566 Bouygues, 15-1567 Free, 15-1568 Orange, 15-1569 SFR
//   800 MHz  : 12-0037 Bouygues, 12-0038 Orange, 12-0039 SFR (Free n'a pas de 800 MHz)
//   900 MHz  : 18-1390 Bouygues (dès le 09/12/2024), 18-1392 Orange (dès le 09/02/2025), 18-1393 SFR,
//              18-1391 (art. 2 et 3, dès le 09/02/2025) + 10-0043 Free
//   1800 MHz : 18-1392 Orange, 18-1393 SFR, 18-1390 Bouygues (dès le 09/12/2024), 14-1542 modifiée par 15-1080 Free
//   2,1 GHz  : 18-1393 + 10-0633 modifiée par 18-0683 SFR, 18-1390 Bouygues (dès le 12/12/2022),
//              18-1391 + 10-0043 Free, 18-1392 + 10-0634 modifiée par 18-0682 Orange
//   2,6 GHz  : 11-1168 Bouygues, 11-1169 Free, 11-1170 Orange, 11-1171 SFR
//   3,5 GHz  : 20-1254 Bouygues, 20-1255 Free, 20-1256 Orange, 20-1257 SFR
// Dans chaque bande les blocs se suivent sans trou ni chevauchement (vérifié par les tests).
// À revoir quand les fréquences de SFR seront cédées à Bouygues, Free et Orange (rachat de SFR, accord de juin 2026,
// cession soumise à l'Arcep) : jusque-là ce sont bien les blocs de SFR.
//
// Fiable seulement si la fréquence centrale tombe nettement dans UN bloc : à moins de MARGE MHz d'une limite, ou hors
// de tout bloc connu, on ne dit rien (« opérateur inconnu »). Le nom donné est celui du titulaire de la fréquence : une
// antenne partagée (SFR et Bouygues partagent leurs antennes dans les zones peu denses) porte aussi l'autre opérateur.

/** [début, fin, opérateur] en MHz, voie descendante (antenne → tablette). */
export const BLOCS = {
  700: [[758, 763, 'SFR'], [763, 773, 'Orange'], [773, 778, 'Bouygues'], [778, 788, 'Free']],
  800: [[791, 801, 'Bouygues'], [801, 811, 'SFR'], [811, 821, 'Orange']],
  900: [[925.1, 933.8, 'Bouygues'], [933.8, 942.5, 'Orange'], [942.5, 951.2, 'Free'], [951.2, 959.9, 'SFR']],
  1800: [[1805, 1825, 'Orange'], [1825, 1845, 'SFR'], [1845, 1860, 'Free'], [1860, 1880, 'Bouygues']],
  2100: [[2110.5, 2125.3, 'SFR'], [2125.3, 2140.1, 'Bouygues'], [2140.1, 2154.9, 'Free'], [2154.9, 2169.7, 'Orange']],
  2600: [[2620, 2635, 'SFR'], [2635, 2655, 'Orange'], [2655, 2670, 'Bouygues'], [2670, 2690, 'Free']],
  3500: [[3490, 3570, 'SFR'], [3570, 3640, 'Bouygues'], [3640, 3710, 'Free'], [3710, 3800, 'Orange']],
};

// Distance minimale (MHz) entre la fréquence centrale et la limite d'un bloc : la moitié du plus petit canal possible
// (4G 1,4 MHz, 5G : bloc de synchronisation de 7,2 MHz au moins, 3G 5 MHz, 2G 200 kHz).
const MARGE = { '4G': 0.7, '5G': 0.7, '3G': 2, '2G': 0.1 };

// 4G : 3GPP TS 36.101, tableau 5.7.3-1 : F = F_bas + 0,1 × (N − N_décalage), pour les bandes FDD utilisées en France.
const BANDES_LTE = [
  // [bande, N premier, N dernier, F_bas MHz, bande Arcep (clé de BLOCS)]
  [1, 0, 599, 2110, 2100], [3, 1200, 1949, 1805, 1800], [7, 2750, 3449, 2620, 2600], [8, 3450, 3799, 925, 900],
  [20, 6150, 6449, 791, 800], [28, 9210, 9659, 758, 700],
];
const arrondi = (f) => Math.round(f * 1000) / 1000;

/** Fréquence descendante (MHz) d'un EARFCN 4G, ou null hors des bandes utilisées en France. */
export function mhzLte(n) {
  if (!Number.isInteger(n)) return null;
  const b = BANDES_LTE.find(([, de, a]) => n >= de && n <= a);
  return b ? arrondi(b[3] + 0.1 * (n - b[1])) : null;
}

/** Fréquence (MHz) d'un NR-ARFCN 5G (3GPP TS 38.104, § 5.4.2.1 : pas de 5 kHz sous 3 GHz, 15 kHz de 3 à 24,25 GHz). */
export function mhzNr(n) {
  if (!Number.isInteger(n) || n < 0) return null;
  if (n < 600000) return arrondi(0.005 * n);
  if (n < 2016667) return arrondi(3000 + 0.015 * (n - 600000));
  return null;
}

/** Fréquence descendante (MHz) d'un UARFCN 3G (TS 25.101 : bande I F = N/5, bande VIII F = 340 + N/5). */
export function mhzUmts(n) {
  if (!Number.isInteger(n)) return null;
  if (n >= 10562 && n <= 10838) return arrondi(n / 5);
  if (n >= 2937 && n <= 3088) return arrondi(340 + n / 5);
  return null;
}

/** Fréquence descendante (MHz) d'un ARFCN 2G (TS 45.005 : GSM 900, E-GSM, DCS 1800). */
export function mhzGsm(n) {
  if (!Number.isInteger(n)) return null;
  if (n >= 0 && n <= 124) return arrondi(935 + 0.2 * n);
  if (n >= 975 && n <= 1023) return arrondi(935 + 0.2 * (n - 1024));
  if (n >= 512 && n <= 885) return arrondi(1805.2 + 0.2 * (n - 512));
  return null;
}

/**
 * Opérateur titulaire de la fréquence f (MHz), ou null si elle n'est pas nettement dans un seul bloc. bande : clé de
 * BLOCS pour ne chercher que là (la bande 28 va jusqu'à 803 MHz, mais au-dessus de 788 c'est la bande 800 MHz).
 */
export function operateurDeMhz(f, marge = 0.7, bande = null) {
  if (typeof f !== 'number' || !Number.isFinite(f)) return null;
  const blocs = bande == null ? Object.values(BLOCS).flat() : BLOCS[bande] || [];
  const dans = blocs.filter(([de, a]) => f >= de + marge && f <= a - marge);
  return dans.length === 1 ? dans[0][2] : null;
}

/** Fréquence (MHz) d'une antenne envoyée par la tablette, d'après le numéro de canal de son type. */
export function mhzAntenne(a) {
  if (!a) return null;
  const n = (v) => (v == null || v === '' ? NaN : Number(v));
  switch (a.type) {
    case '4G': return mhzLte(n(a.earfcn));
    case '5G': return mhzNr(n(a.nrarfcn));
    case '3G': return mhzUmts(n(a.uarfcn));
    case '2G': return mhzGsm(n(a.arfcn));
    default: return null;
  }
}

/** Opérateur d'une antenne d'après sa fréquence, ou null (pas de canal envoyé, ou pas sûr). */
export function operateurParFrequence(a) {
  const f = mhzAntenne(a);
  if (f == null) return null;
  // 4G : seulement dans la bande que donne l'EARFCN (les autres canaux disent leur fréquence sans ambiguïté).
  const bande = a.type === '4G' ? BANDES_LTE.find(([, de, fin]) => Number(a.earfcn) >= de && Number(a.earfcn) <= fin)[4] : null;
  return operateurDeMhz(f, MARGE[a.type] ?? 0.7, bande);
}
