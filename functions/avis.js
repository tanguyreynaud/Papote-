// Avis de familles sur la page d'accueil du site vitrine, gérés depuis l'espace admin.
// Collection avis/{id} : prenom, relation (ex. « petite-fille de Jeanne, 91 ans »), ville, texte,
// note (1 à 5, facultative), visible (booléen), ordre (nombre, croissant), creeLe.
// La page d'accueil (« / ») passe par la fonction accueil : elle prend vitrine/accueil.html et
// remplace <!-- AVIS --> par les avis visibles, pour qu'ils soient dans le HTML (lu par le chat d'aide).
// Seulement de vrais avis de clients.

const MAX_AVIS = 12;

function echapper(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function etoiles(note) {
  const n = Math.round(Number(note));
  if (!(n >= 1 && n <= 5)) return '';
  return `<p class="avis-note" aria-label="${n} sur 5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</p>`;
}

// Liste d'avis (données Firestore) -> section HTML, ou '' s'il n'y en a aucun à montrer.
function sectionAvis(liste) {
  const avis = (liste || [])
    .filter((a) => a && a.visible === true && String(a.texte || '').trim() && String(a.prenom || '').trim())
    .sort((a, b) => (Number(a.ordre) || 0) - (Number(b.ordre) || 0))
    .slice(0, MAX_AVIS);
  if (!avis.length) return '';
  const cartes = avis.map((a) => {
    const qui = [a.relation, a.ville].map((x) => String(x || '').trim()).filter(Boolean).map(echapper).join(', ');
    return `<figure class="avis-carte">${etoiles(a.note)}<blockquote>${echapper(String(a.texte).trim())}</blockquote>`
      + `<figcaption><b>${echapper(String(a.prenom).trim())}</b>${qui ? `<span>${qui}</span>` : ''}</figcaption></figure>`;
  }).join('\n');
  return `<section id="avis">
    <div class="wrap">
      <div class="section-head">
        <p class="eyebrow">Avis de familles</p>
        <h2>Ce qu'en disent les familles</h2>
      </div>
      <div class="avis-liste">
${cartes}
      </div>
    </div>
  </section>`;
}

function pageAvecAvis(gabarit, liste) {
  return gabarit.replace('<!-- AVIS -->', sectionAvis(liste));
}

module.exports = { sectionAvis, pageAvecAvis, MAX_AVIS };
