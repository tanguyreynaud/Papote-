// Un numéro de portable par proche dans une même famille (Tanguy, 13/11) : deux membres d'une famille ne peuvent pas
// avoir le même members/{uid}.telephone (la tablette appelle et reconnaît ses proches par ce numéro).
//
// L'appli le refuse dans Profil et juste après l'entrée dans la famille (web/js/famille.js, telPrisPar), avant
// d'écrire le numéro. Les règles Firestore ne peuvent pas vérifier l'unicité : un doublon peut donc exister (fiche
// d'avant le 13/11, deux écritures en même temps). La page admin le montre : une ligne « À faire » et un mot sur la
// page de la famille, calculés ici à partir des fiches membres (gestion.js, gestionDonnees).
//
// Seuls les proches comptent : la tablette porte le numéro de sa carte SIM, ce n'est pas un proche.

// « 06 12 34 56 78 », « +33 6… », « 0033 7… » → « 0612345678 » ; '' pour tout autre chose (même règle que l'appli).
function telNormalise(v) {
  let t = String(v || '').replace(/[^\d+]/g, '');
  if (t.startsWith('+')) t = t.slice(1);
  else if (t.startsWith('00')) t = t.slice(2);
  if (t.startsWith('33')) t = `0${t.slice(2).replace(/^0/, '')}`;
  return /^0[67]\d{8}$/.test(t) ? t : '';
}

// « 0612345678 » → « 06 •• •• •• 78 » : l'admin reconnaît le numéro sans l'afficher en entier.
function masquer(numero) {
  const t = telNormalise(numero);
  return t ? `${t.slice(0, 2)} •• •• •• ${t.slice(8)}` : '';
}

// membres : [{ fid, uid, name, role, status, telephone }] → [{ fid, numero (masqué), prenoms: [...] }],
// un élément par numéro porté par au moins deux proches d'une même famille ; rangés par famille puis numéro.
function doublons(membres) {
  const groupes = new Map();
  for (const m of membres || []) {
    if (!m || !m.fid || m.role === 'tablette') continue;
    const t = telNormalise(m.telephone);
    if (!t) continue;
    const cle = `${m.fid}|${t}`;
    if (!groupes.has(cle)) groupes.set(cle, { fid: m.fid, tel: t, prenoms: [] });
    groupes.get(cle).prenoms.push(String(m.name || '').trim() || 'sans prénom');
  }
  return [...groupes.values()].filter((g) => g.prenoms.length > 1)
    .sort((a, b) => a.fid.localeCompare(b.fid) || a.tel.localeCompare(b.tel))
    .map((g) => ({ fid: g.fid, numero: masquer(g.tel), prenoms: g.prenoms.sort((a, b) => a.localeCompare(b, 'fr')) }));
}

// Texte de la ligne « À faire » (et de la page de la famille).
function texte(d, nomFamille) {
  return `Numéro en double dans la famille ${nomFamille || 'sans nom'} : ${d.numero} (${d.prenoms.join(', ')})`;
}

// Documents d'une lecture collectionGroup('members') → membres (seulement families/{fid}/members/{uid}).
function membresDe(docs) {
  return (docs || []).filter((d) => d.ref && d.ref.parent && d.ref.parent.parent && d.ref.parent.parent.parent
    && d.ref.parent.parent.parent.id === 'families')
    .map((d) => ({ fid: d.ref.parent.parent.id, uid: d.id, name: d.get('name'), role: d.get('role'), telephone: d.get('telephone') }));
}

module.exports = { telNormalise, masquer, doublons, texte, membresDe };
