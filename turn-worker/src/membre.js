// Le relais n'est donné qu'aux membres d'une famille (Tanguy 12/11, règles 2, R3) : un proche actif (pas en
// attente) ou une tablette. La question est posée à Firestore avec le jeton de l'appli elle-même : les règles ne
// lui montrent que ses propres fiches (requête « mes familles », fiches membres qui portent son uid). Les fiches
// des tablettes portent aussi leur uid, écrit par le serveur (functions/uid-tablette.js).
// Aucune clé de service ici : le Worker ne voit que ce que l'appli voit déjà.

// base : 'https://firestore.googleapis.com/v1' (ou l'émulateur : 'http://127.0.0.1:8080/v1').
export async function estMembre({ base, projet, database, uid, jeton, fetchFn = fetch }) {
  if (!uid || !jeton) return false;
  const url = `${base}/projects/${projet}/databases/${encodeURIComponent(database)}/documents:runQuery`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'members', allDescendants: true }],
        where: { fieldFilter: { field: { fieldPath: 'uid' }, op: 'EQUAL', value: { stringValue: uid } } },
        select: { fields: [{ fieldPath: 'status' }, { fieldPath: 'role' }] },
        limit: 10,
      },
    }),
  });
  // Refus des règles, base injoignable : pas de relais (l'appel essaie sans, comme avant le relais).
  if (!res.ok) throw new Error(`firestore ${res.status}`);
  const lignes = await res.json();
  return (Array.isArray(lignes) ? lignes : []).some((l) => {
    const f = l && l.document && l.document.fields;
    if (!f) return false;
    const statut = f.status && f.status.stringValue;
    return statut !== 'pending';
  });
}
