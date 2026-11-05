// Fichier .zip assemblé petit à petit, pour « Tout télécharger » (photos, vidéos et messages de la famille).
// Sans compression : les photos et les vidéos le sont déjà. Les fichiers ne sont jamais recopiés en mémoire
// JavaScript : le .zip final est un Blob fait des Blobs reçus (le navigateur les garde, sur disque s'ils sont gros).
// Seule la somme de contrôle (CRC-32) demande de lire chaque fichier, morceau par morceau. Une quarantaine de
// vidéos de 8 Mo ne demande donc pas 600 Mo de mémoire au téléphone, comme avec JSZip.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crcMorceau(c, octets) {
  for (let i = 0; i < octets.length; i++) c = TABLE[(c ^ octets[i]) & 0xff] ^ (c >>> 8);
  return c;
}

async function crc32(blob) {
  let c = 0xffffffff;
  if (blob.stream) {
    const lecteur = blob.stream().getReader();
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      c = crcMorceau(c, value);
    }
  } else {
    // Navigateurs anciens : par tranches de 4 Mo.
    for (let debut = 0; debut < blob.size; debut += 4 << 20) {
      c = crcMorceau(c, new Uint8Array(await blob.slice(debut, debut + (4 << 20)).arrayBuffer()));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dateDos(d) {
  return {
    heure: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    jour: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const LIMITE = 0xffffffff; // 4 Go : au-delà, il faudrait le format ZIP64.

export function creerZip() {
  const morceaux = [];
  const centrale = [];
  const noms = new Set();
  const enc = new TextEncoder();
  let position = 0;

  // Deux fichiers du même nom : « nom (2).jpg ».
  function nomUnique(nom) {
    let n = nom;
    for (let i = 2; noms.has(n); i++) n = nom.replace(/(\.[^./]*)?$/, (ext) => ` (${i})${ext || ''}`);
    noms.add(n);
    return n;
  }

  return {
    /** Ajoute un fichier (Blob). date : celle de l'envoi. */
    async ajouter(nom, blob, date = new Date()) {
      if (position + blob.size + 30 + nom.length * 3 > LIMITE) throw new Error('Fichier .zip trop gros (4 Go)');
      const octetsNom = enc.encode(nomUnique(nom));
      const crc = await crc32(blob);
      const { heure, jour } = dateDos(date);
      const entete = new DataView(new ArrayBuffer(30));
      entete.setUint32(0, 0x04034b50, true);
      entete.setUint16(4, 20, true);
      entete.setUint16(6, 0x0800, true); // noms en UTF-8
      entete.setUint16(8, 0, true); // sans compression
      entete.setUint16(10, heure, true);
      entete.setUint16(12, jour, true);
      entete.setUint32(14, crc, true);
      entete.setUint32(18, blob.size, true);
      entete.setUint32(22, blob.size, true);
      entete.setUint16(26, octetsNom.length, true);
      entete.setUint16(28, 0, true);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, heure, true);
      c.setUint16(14, jour, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, blob.size, true);
      c.setUint32(24, blob.size, true);
      c.setUint16(28, octetsNom.length, true);
      c.setUint32(42, position, true);
      centrale.push(c, octetsNom);
      morceaux.push(entete, octetsNom, blob);
      position += 30 + octetsNom.length + blob.size;
    },
    get nombre() { return noms.size; },
    /** Le .zip complet, prêt à enregistrer. */
    fermer() {
      const tailleCentrale = centrale.reduce((t, m) => t + m.byteLength, 0);
      const fin = new DataView(new ArrayBuffer(22));
      fin.setUint32(0, 0x06054b50, true);
      fin.setUint16(8, noms.size, true);
      fin.setUint16(10, noms.size, true);
      fin.setUint32(12, tailleCentrale, true);
      fin.setUint32(16, position, true);
      return new Blob([...morceaux, ...centrale, fin], { type: 'application/zip' });
    },
  };
}
