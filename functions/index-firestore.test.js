// Index Firestore : chaque requête du code (fonctions/ et web/js/) doit avoir son index dans firestore.indexes.json.
// L'émulateur n'exige AUCUN index : une requête sans index passe tous les parcours puis échoue en ligne
// (FAILED_PRECONDITION « The query requires an index »). Ce test lit le code, retrouve chaque requête et vérifie :
//   - requête sur un groupe de collections (collectionGroup) : index de portée COLLECTION_GROUP pour chaque champ
//     (fieldOverrides) ou index composite COLLECTION_GROUP : Firestore ne les crée jamais tout seul ;
//   - égalité + tri ou inégalité sur un autre champ, ou deux champs triés : index composite (indexes) ;
//   - champ exempté par un fieldOverrides sans portée COLLECTION : la requête simple échoue aussi.
// INDEX_DETAIL=1 affiche toutes les requêtes trouvées ; RACINE_DEPOT=… vérifie un autre dépôt (branche de l'appli web).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RACINE = process.env.RACINE_DEPOT || path.join(__dirname, '..');

// Argument entre parenthèses équilibrées à partir de src[i] === '(' ; renvoie [texte, indice après ')'].
function parentheses(src, i) {
  let prof = 0;
  let chaine = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (chaine) {
      if (c === '\\') j++;
      else if (c === chaine) chaine = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') chaine = c;
    else if (c === '(' || c === '[' || c === '{') prof++;
    else if (c === ')' || c === ']' || c === '}') {
      prof--;
      if (prof === 0) return [src.slice(i + 1, j), j + 1];
    }
  }
  return [src.slice(i + 1), src.length];
}

// Découpe des arguments au premier niveau.
function args(texte) {
  const res = [];
  let prof = 0;
  let chaine = null;
  let debut = 0;
  for (let j = 0; j < texte.length; j++) {
    const c = texte[j];
    if (chaine) {
      if (c === '\\') j++;
      else if (c === chaine) chaine = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') chaine = c;
    else if ('([{'.includes(c)) prof++;
    else if (')]}'.includes(c)) prof--;
    else if (c === ',' && prof === 0) {
      res.push(texte.slice(debut, j).trim());
      debut = j + 1;
    }
  }
  if (texte.slice(debut).trim()) res.push(texte.slice(debut).trim());
  return res;
}

const litteral = (a) => {
  const m = /^(['"`])([^'"`]*)\1$/.exec((a || '').trim());
  return m ? m[2] : null;
};
// Nom de la collection : dernier segment du chemin ('families/${fid}/posts' -> posts ; collection(db, 'families', id, 'posts')).
function nomCollection(arguments_) {
  const morceaux = arguments_.map((a) => {
    const m = /^(['"`])(.*)\1$/s.exec(a.trim());
    return m ? m[2] : null;
  });
  const dernier = morceaux.filter((m) => m != null).pop();
  if (dernier == null) return '?';
  // Nombre impair de segments en tout (chemin de collection) : on garde le dernier segment.
  return dernier.split('/').filter(Boolean).pop().replace(/\$\{[^}]*\}/g, '?');
}

const OPS_EGALITE = ['==', 'in'];
const OPS_INEGALITE = ['<', '<=', '>', '>=', '!=', 'not-in'];

function filtre(texte) {
  const [champ, op] = args(texte);
  return { champ: litteral(champ) || '?', op: litteral(op) || '?' };
}
function tri(texte) {
  const [champ, sens] = args(texte);
  return { champ: litteral(champ) || '?', sens: (litteral(sens) || 'asc').toLowerCase() === 'desc' ? 'DESCENDING' : 'ASCENDING' };
}

const ligneDe = (src, i) => src.slice(0, i).split('\n').length;

// Requêtes du SDK serveur : db.collection('x').where(...).orderBy(...)… (et variable = db.collection(...)).
function requetesServeur(src, fichier) {
  const res = [];
  const re = /\.(collection|collectionGroup)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const [arg, fin] = parentheses(src, m.index + m[0].length - 1);
    const q = { fichier, ligne: ligneDe(src, m.index), groupe: m[1] === 'collectionGroup', collection: nomCollection(args(arg)), filtres: [], tris: [] };
    let i = fin;
    for (;;) {
      const suite = /^\s*\.\s*(where|orderBy|limit|select|count|offset|startAfter|startAt|limitToLast)\s*\(/.exec(src.slice(i));
      if (!suite) break;
      const [a, f] = parentheses(src, i + suite[0].length - 1);
      if (suite[1] === 'where') q.filtres.push(filtre(a));
      if (suite[1] === 'orderBy') q.tris.push(tri(a));
      i = f;
    }
    // Variable : const posts = db.collection(...); … posts.where(...)
    const affect = /(?:const|let|var)\s+(\w+)\s*=\s*[^;=]*$/.exec(src.slice(Math.max(0, m.index - 200), m.index));
    let usages = 0;
    if (affect) {
      const nom = affect[1];
      const reVar = new RegExp(`(?<![\\w.])${nom}\\s*\\.\\s*(where|orderBy)\\s*\\(`, 'g');
      reVar.lastIndex = i;
      let v;
      while ((v = reVar.exec(src))) {
        const qv = { ...q, ligne: ligneDe(src, v.index), filtres: [...q.filtres], tris: [...q.tris] };
        let k = v.index + v[0].length - 1 - v[1].length - 1;
        for (;;) {
          const suite = /^\s*\.\s*(where|orderBy|limit|select|count|offset)\s*\(/.exec(src.slice(k));
          if (!suite) break;
          const [a, f] = parentheses(src, k + suite[0].length - 1);
          if (suite[1] === 'where') qv.filtres.push(filtre(a));
          if (suite[1] === 'orderBy') qv.tris.push(tri(a));
          k = f;
        }
        res.push(qv);
        usages += 1;
      }
    }
    // Requête de base rangée dans une variable puis complétée (membres.where(…)) : seules les requêtes complètes comptent.
    if (!usages && (q.filtres.length || q.tris.length)) res.push(q);
  }
  return res;
}

// Requêtes du SDK web modulaire : query(collection(db, …) | collectionGroup(db, 'x') | variable, where(…), orderBy(…)).
function requetesWeb(src, fichier) {
  const res = [];
  const variables = new Map();
  const reVar = /(?:const|let|var)\s+(\w+)\s*=\s*(collection|collectionGroup)\s*\(/g;
  let m;
  while ((m = reVar.exec(src))) {
    const [a] = parentheses(src, m.index + m[0].length - 1);
    variables.set(m[1], { groupe: m[2] === 'collectionGroup', collection: nomCollection(args(a)) });
  }
  // Fonctions fléchées d'une ligne : const base = (nom) => collection(db, 'families', fid, nom) : collection inconnue.
  const re = /(?<![\w.])query\s*\(/g;
  while ((m = re.exec(src))) {
    const [a] = parentheses(src, m.index + m[0].length - 1);
    const [racine, ...reste] = args(a);
    let source = null;
    const r = /^(collection|collectionGroup)\s*\(/.exec(racine);
    if (r) source = { groupe: r[1] === 'collectionGroup', collection: nomCollection(args(parentheses(racine, r[0].length - 1)[0])) };
    else if (variables.has(racine)) source = variables.get(racine);
    else source = { groupe: false, collection: '?' };
    const q = { fichier, ligne: ligneDe(src, m.index), ...source, filtres: [], tris: [] };
    for (const x of reste) {
      const w = /^(where|orderBy)\s*\(/.exec(x);
      if (!w) continue;
      const [contenu] = parentheses(x, w[0].length - 1);
      if (w[1] === 'where') q.filtres.push(filtre(contenu));
      else q.tris.push(tri(contenu));
    }
    if (q.filtres.length || q.tris.length) res.push(q);
  }
  return res;
}

// Ce qu'il faut à une requête : { composite: [champs…] | null, champsGroupe: [{champ, ordre}] }.
function besoin(q) {
  const egalites = q.filtres.filter((f) => OPS_EGALITE.includes(f.op)).map((f) => f.champ);
  const tableaux = q.filtres.filter((f) => f.op === 'array-contains' || f.op === 'array-contains-any').map((f) => f.champ);
  const inegalites = q.filtres.filter((f) => OPS_INEGALITE.includes(f.op)).map((f) => f.champ);
  const tris = [...q.tris];
  // Inégalité sans tri : tri implicite croissant sur le champ de l'inégalité.
  for (const c of inegalites) if (!tris.some((t) => t.champ === c)) tris.push({ champ: c, sens: 'ASCENDING' });
  const egal = [...new Set(egalites.filter((c) => !tris.some((t) => t.champ === c)))];
  const champsTries = [...new Set(tris.map((t) => t.champ))];
  const composite = champsTries.length > 1 || (champsTries.length >= 1 && (egal.length + tableaux.length) > 0);
  return {
    composite: composite ? { egal, tableaux, tris } : null,
    champs: [...egal.map((c) => ({ champ: c, ordre: 'ASCENDING' })), ...tableaux.map((c) => ({ champ: c, tableau: true })),
      ...tris.map((t) => ({ champ: t.champ, ordre: t.sens }))],
  };
}

function indexComposite(indexes, q, b) {
  const portee = q.groupe ? 'COLLECTION_GROUP' : 'COLLECTION';
  const { egal, tableaux, tris } = b.composite;
  return (indexes.indexes || []).some((ix) => {
    if (ix.collectionGroup !== q.collection || (ix.queryScope || 'COLLECTION') !== portee) return false;
    const champs = ix.fields.filter((f) => f.fieldPath !== '__name__');
    const n = egal.length + tableaux.length;
    if (champs.length !== n + tris.length) return false;
    const tete = champs.slice(0, n);
    if (!egal.every((c) => tete.some((f) => f.fieldPath === c && f.order))) return false;
    if (!tableaux.every((c) => tete.some((f) => f.fieldPath === c && f.arrayConfig === 'CONTAINS'))) return false;
    return tris.every((t, k) => champs[n + k].fieldPath === t.champ && champs[n + k].order === t.sens);
  });
}

// Index d'un seul champ : automatique en portée COLLECTION (sauf exemption), jamais en portée COLLECTION_GROUP.
function indexSimple(indexes, q, { champ, ordre, tableau }) {
  const portee = q.groupe ? 'COLLECTION_GROUP' : 'COLLECTION';
  const exception = (indexes.fieldOverrides || []).find((o) => o.collectionGroup === q.collection && o.fieldPath === champ);
  if (!exception) return !q.groupe;
  return exception.indexes.some((ix) => (ix.queryScope || 'COLLECTION') === portee
    && (tableau ? ix.arrayConfig === 'CONTAINS' : ix.order === ordre || (ordre === 'ASCENDING' && ix.order)));
}

function verifier(q, indexes) {
  const b = besoin(q);
  if (q.collection === '?' || q.filtres.some((f) => f.champ === '?') || q.tris.some((t) => t.champ === '?')) {
    // Champ ou collection calculés : une seule égalité ne demande jamais d'index composite (portée collection).
    const simple = !q.groupe && !b.composite;
    return { ok: simple, attendu: simple ? 'automatique (nom calculé, un seul champ)' : 'à vérifier à la main (nom calculé)' };
  }
  if (b.composite) {
    const attendu = `composite ${q.groupe ? 'COLLECTION_GROUP' : 'COLLECTION'} ${q.collection} (${[
      ...b.composite.egal.map((c) => `${c} ASC`), ...b.composite.tableaux.map((c) => `${c} CONTAINS`),
      ...b.composite.tris.map((t) => `${t.champ} ${t.sens === 'DESCENDING' ? 'DESC' : 'ASC'}`)].join(', ')})`;
    return { ok: indexComposite(indexes, q, b), attendu };
  }
  const manquants = b.champs.filter((c) => !indexSimple(indexes, q, c));
  const attendu = q.groupe
    ? `champ seul COLLECTION_GROUP ${q.collection}.${b.champs.map((c) => c.champ).join(' + ')}` : 'automatique';
  return { ok: manquants.length === 0, attendu: manquants.length && !q.groupe ? `${attendu} (champ exempté : ${manquants.map((c) => c.champ)})` : attendu };
}

function fichiersJs(dossier, filtre_ = () => true) {
  if (!fs.existsSync(dossier)) return [];
  return fs.readdirSync(dossier).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && filtre_(f)).map((f) => path.join(dossier, f));
}

function toutesLesRequetes(racine = RACINE) {
  const requetes = [];
  for (const f of fichiersJs(path.join(racine, 'functions'))) {
    requetes.push(...requetesServeur(fs.readFileSync(f, 'utf8'), path.relative(racine, f)));
  }
  for (const f of fichiersJs(path.join(racine, 'web', 'js'))) {
    requetes.push(...requetesWeb(fs.readFileSync(f, 'utf8'), path.relative(racine, f)));
  }
  return requetes;
}

const decrire = (q) => `${q.groupe ? 'collectionGroup' : 'collection'}(${q.collection}) ${[
  ...q.filtres.map((f) => `where ${f.champ} ${f.op}`), ...q.tris.map((t) => `orderBy ${t.champ} ${t.sens === 'DESCENDING' ? 'desc' : 'asc'}`)].join(', ')}`;

test('chaque requête Firestore du code a son index dans firestore.indexes.json', () => {
  const indexes = JSON.parse(fs.readFileSync(path.join(RACINE, 'firestore.indexes.json'), 'utf8'));
  const requetes = toutesLesRequetes();
  assert.ok(requetes.length > 20, `trop peu de requêtes trouvées (${requetes.length}) : l'analyse du code est cassée`);
  const resultats = requetes.map((q) => ({ q, ...verifier(q, indexes) }));
  if (process.env.INDEX_DETAIL) {
    console.log(`| Fichier:ligne | Requête | Index nécessaire | Présent |\n|---|---|---|---|\n${resultats.map((r) => `| ${r.q.fichier}:${r.q.ligne} | ${decrire(r.q)} | ${r.attendu} | ${r.ok ? 'oui' : '**NON**'} |`).join('\n')}`);
  }
  const manquants = resultats.filter((r) => !r.ok).map((r) => `${r.q.fichier}:${r.q.ligne} ${decrire(r.q)} -> ${r.attendu}`);
  assert.deepStrictEqual(manquants, [], `index manquants (la requête échouera en ligne) :\n${manquants.join('\n')}`);
});

test('l\'analyseur reconnaît les cas qui demandent un index', () => {
  const vide = { indexes: [], fieldOverrides: [] };
  const [a] = requetesServeur("db.collection('x').where('a', '==', 1).orderBy('b', 'desc').get()", 't');
  assert.strictEqual(verifier(a, vide).ok, false);
  const [g] = requetesServeur("db.collectionGroup('members').where('uid', '==', uid).get()", 't');
  assert.strictEqual(verifier(g, vide).ok, false);
  const [s] = requetesServeur("db.collection('x').where('a', '==', 1).where('b', '==', 2).get()", 't');
  assert.strictEqual(verifier(s, vide).ok, true);
  const [i] = requetesServeur("db.collection('x').where('a', '==', 1).where('b', '>', 2).get()", 't');
  assert.strictEqual(verifier(i, vide).ok, false);
  const [w] = requetesWeb("const posts = collection(db, 'families', fid, 'posts');\nquery(posts, where('type', 'in', t), orderBy('createdAt', 'desc'))", 't');
  assert.strictEqual(w.collection, 'posts');
  assert.strictEqual(verifier(w, vide).ok, false);
  assert.strictEqual(verifier(w, { indexes: [{ collectionGroup: 'posts', queryScope: 'COLLECTION', fields: [
    { fieldPath: 'type', order: 'ASCENDING' }, { fieldPath: 'createdAt', order: 'DESCENDING' }] }] }).ok, true);
});

module.exports = { toutesLesRequetes, verifier, decrire };
