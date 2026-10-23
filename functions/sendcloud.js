// Étiquettes d'envoi et de retour par Sendcloud (API v3, Mondial Relay).
// Clés : secret SENDCLOUD_API (« clé publique:clé secrète » de l'intégration « Papote étiquettes »),
// rangé par outils\gestion\installer-sendcloud.bat. Les fonctions pures sont testées par gestion.test.js.

const API = 'https://panel.sendcloud.sc/api/v3';
const TRANSPORTEUR = 'mondial_relay';

const propre = (v, max = 100) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

// Adresse Sendcloud du client : point relais choisi sur le site, ou adresse Stripe (commande depuis l'appli).
// { adresse, pointRelais } ; null s'il manque de quoi l'écrire.
function adresseClient(c) {
  const l = c.livraison || {};
  const contact = {
    name: propre(l.destinataire || c.nom || l.nom || c.email, 70), // personne qui retire le colis, choisie à la commande
    ...(c.telephone ? { phone_number: propre(c.telephone, 20) } : {}),
    ...(c.email ? { email: propre(c.email, 120) } : {}),
  };
  if (l.transporteur === 'mondial-relay' && l.id) {
    if (!l.cp || !l.ville) return null;
    return {
      adresse: { ...contact, address_line_1: propre(l.adresse || l.nom), postal_code: propre(l.cp, 10), city: propre(l.ville), country_code: (l.pays || 'FR').toUpperCase() },
      pointRelais: String(l.id),
    };
  }
  const a = l.adresse && typeof l.adresse === 'object' ? l.adresse : null;
  if (!a || !a.line1 || !a.postal_code || !a.city) return null;
  return {
    adresse: {
      ...contact,
      address_line_1: propre(a.line1),
      ...(a.line2 ? { address_line_2: propre(a.line2) } : {}),
      postal_code: propre(a.postal_code, 10), city: propre(a.city), country_code: (a.country || 'FR').toUpperCase(),
    },
    pointRelais: null,
  };
}

// Adresse de Papote (réglage « expediteur ») : départ des colis, arrivée des retours.
function adressePapote(e) {
  if (!e || !e.nom || !e.adresse || !e.cp || !e.ville) return null;
  return {
    name: propre(e.nom, 70), address_line_1: propre(e.adresse), postal_code: propre(e.cp, 10), city: propre(e.ville),
    country_code: 'FR',
    ...(e.telephone ? { phone_number: propre(e.telephone, 20) } : {}),
    ...(e.email ? { email: propre(e.email, 120) } : {}),
  };
}

const kg = (o) => (o && o.value != null ? Number(o.value) * ({ g: 0.001, kg: 1 }[o.unit] || 1) : null);

// Options Mondial Relay qui acceptent ce poids (kg) et le besoin (point relais, domicile ou retour),
// celles d'un contrat d'abord (contrat Mondial Relay du compte).
function optionsPossibles(options, poids, besoin) {
  return (options || []).filter((o) => {
    if (!o || !o.code || (o.carrier && o.carrier.code !== TRANSPORTEUR)) return false;
    const f = o.functionalities || {};
    if (besoin === 'retour' && !f.returns) return false;
    if (besoin === 'relais' && f.last_mile !== 'service_point') return false;
    if (besoin === 'domicile' && (f.returns || f.last_mile === 'service_point')) return false;
    const min = kg(o.weight && o.weight.min);
    const max = kg(o.weight && o.weight.max);
    return (min == null || poids >= min) && (max == null || poids <= max);
  }).sort((a, b) => !!(b.contract && b.contract.id) - !!(a.contract && a.contract.id));
}

const choisirOption = (options, poids, besoin) => optionsPossibles(options, poids, besoin)[0] || null;

// Carton d'une tablette (cm) : certains transporteurs exigent les dimensions.
const DIMENSIONS = { length: '35', width: '25', height: '8', unit: 'cm' };

// Message lisible d'une erreur Sendcloud (400 : { errors: [...] } ou { error: {...} }).
function erreurLisible(corps) {
  if (!corps) return 'réponse vide';
  const liste = corps.errors || (corps.error ? [corps.error] : []);
  const t = liste.map((e) => [e.field || (e.source && e.source.pointer), e.detail || e.message].filter(Boolean).join(' : '))
    .filter(Boolean).join(' ; ');
  return t || corps.message || JSON.stringify(corps).slice(0, 300);
}

// Réponse de GET /api/v2/parcels/{id} : livré quand le statut est 11 (« Delivered »).
function colisLivre(corps) {
  const st = corps && corps.parcel && corps.parcel.status;
  return !!st && (st.id === 11 || /^delivered$/i.test(String(st.message || '')));
}

// Suivi d'un colis (réponse de GET /v2/parcels/{id}) : n° et lien de suivi, étape en clair, livré ou non.
function suiviColis(corps) {
  const p = (corps && corps.parcel) || {};
  return {
    suivi: p.tracking_number || null,
    lien: p.tracking_url || null,
    etape: (p.status && p.status.message) || null,
    livre: colisLivre(corps),
  };
}

function client(cles) {
  const [publique, secrete] = String(cles || '').trim().split(':');
  if (!publique || !secrete) throw new Error('Clés Sendcloud absentes : lancez outils\\gestion\\installer-sendcloud.bat.');
  const auth = `Basic ${Buffer.from(`${publique}:${secrete}`).toString('base64')}`;

  async function appel(methode, chemin, corps) {
    const r = await fetch(`${API}${chemin}`, {
      method: methode,
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    const json = await r.json().catch(() => null);
    if (r.status === 401 || r.status === 403) throw new Error('Sendcloud refuse les clés : relancez installer-sendcloud.bat.');
    if (!r.ok) throw new Error(`Sendcloud : ${erreurLisible(json)}`);
    return json;
  }

  const adresseCourte = (a) => ({
    country_code: a.country_code, postal_code: a.postal_code, city: a.city, address_line_1: a.address_line_1,
  });

  async function options(de, vers, pointRelais, poids, besoin) {
    const r = await appel('POST', '/shipping-options', {
      from_address: adresseCourte(de),
      to_address: adresseCourte(vers),
      ...(pointRelais ? { to_service_point: { id: pointRelais } } : {}),
      carrier_code: TRANSPORTEUR,
      parcels: [{ weight: { value: String(poids), unit: 'kg' }, dimensions: DIMENSIONS }],
      ...(besoin === 'retour' ? { functionalities: { returns: true } } : pointRelais ? {} : { functionalities: { last_mile: 'home_delivery' } }),
    });
    const liste = optionsPossibles(r && r.data, poids, besoin);
    if (!liste.length) {
      throw new Error(`aucune offre Mondial Relay ${besoin === 'retour' ? 'de retour ' : ''}pour ce colis dans votre compte Sendcloud (${de.postal_code} → ${vers.postal_code}${r && r.message ? ` : ${r.message}` : ''}).`);
    }
    return liste;
  }

  // Essaie chaque offre possible : la première acceptée par Sendcloud fait l'étiquette.
  async function essayer(liste, faire) {
    const refus = [];
    for (const o of liste.slice(0, 5)) {
      try {
        return await faire(o);
      } catch (e) {
        refus.push(`${o.code} : ${e.message.replace(/^Sendcloud : /, '')}`);
      }
    }
    throw new Error(`Sendcloud refuse ${refus.length > 1 ? 'les offres' : 'l\'offre'} ${refus.join(' | ')}`);
  }

  // Étiquette PDF d'un colis : elle peut mettre quelques secondes à être prête après l'annonce.
  async function etiquette(colis) {
    for (let essai = 0; essai < 6; essai++) {
      const r = await fetch(`${API}/parcels/${colis}/documents/label?paper_size=A4`, { headers: { Authorization: auth, Accept: 'application/pdf' } });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    throw new Error("l'étiquette n'est pas encore prête chez Sendcloud. Réessayez dans une minute.");
  }

  return {
    // Colis remis au destinataire (retiré au point relais) ? Statut 11 « Delivered » de Sendcloud.
    async livre(colis) {
      return (await this.suivi(colis)).livre;
    },
    // Où en est le colis : { suivi, lien, etape, livre } (voir suiviColis).
    async suivi(colis) {
      const r = await fetch(`${API.replace('/v3', '/v2')}/parcels/${colis}`, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (r.status === 401 || r.status === 403) throw new Error('Sendcloud refuse les clés : relancez installer-sendcloud.bat.');
      if (!r.ok) throw new Error(`Sendcloud : colis ${colis} illisible (${r.status})`);
      return suiviColis(await r.json().catch(() => null));
    },
    // Annule un colis (étiquette non utilisée, remboursée par Sendcloud). Déjà annulé ou supprimé : rien à faire.
    async annuler(colis) {
      const r = await fetch(`${API.replace('/v3', '/v2')}/parcels/${colis}/cancel`, {
        method: 'POST', headers: { Authorization: auth, Accept: 'application/json' },
      });
      if (r.ok || r.status === 404 || r.status === 410) return;
      const json = await r.json().catch(() => null);
      if (r.status === 401 || r.status === 403) throw new Error('Sendcloud refuse les clés : relancez installer-sendcloud.bat.');
      throw new Error(`Sendcloud n'annule pas ce colis : ${erreurLisible(json)}`);
    },
    // Colis aller : { colis, suivi, lienSuivi, pdf }.
    async envoi({ de, vers, pointRelais, poids, reference }) {
      const liste = await options(de, vers, pointRelais, poids, pointRelais ? 'relais' : 'domicile');
      const r = await essayer(liste, (o) => appel('POST', '/shipments/announce', {
        from_address: de,
        to_address: vers,
        ...(pointRelais ? { to_service_point: { id: pointRelais } } : {}),
        ship_with: {
          type: 'shipping_option_code',
          properties: { shipping_option_code: o.code, ...(o.contract && o.contract.id ? { contract_id: o.contract.id } : {}) },
        },
        parcels: [{ weight: { value: String(poids), unit: 'kg' }, dimensions: DIMENSIONS }],
        order_number: reference,
        label_details: { mime_type: 'application/pdf' },
      }));
      const p = r && r.data && r.data.parcels && r.data.parcels[0];
      if (!p || !p.id) throw new Error(`Sendcloud : ${erreurLisible(r && r.data)}`);
      const pdf = p.label_file ? Buffer.from(p.label_file, 'base64') : await etiquette(p.id);
      return { colis: p.id, suivi: p.tracking_number || null, lienSuivi: p.tracking_url || null, pdf };
    },
    // Colis retour, déposé par le client dans un point relais : { colis, pdf }.
    async retour({ de, vers, poids, reference }) {
      const liste = await options(de, vers, null, poids, 'retour');
      const r = await essayer(liste, (o) => appel('POST', '/returns/announce-synchronously', {
        from_address: de,
        to_address: vers,
        ship_with: { type: 'shipping_option_code', shipping_option_code: o.code, ...(o.contract && o.contract.id ? { contract: o.contract.id } : {}) },
        weight: { value: poids, unit: 'kg' },
        dimensions: DIMENSIONS,
        delivery_option: 'drop_off_point',
        order_number: reference,
      }));
      if (!r || !r.parcel_id) throw new Error(`Sendcloud : ${erreurLisible(r)}`);
      return { colis: r.parcel_id, pdf: await etiquette(r.parcel_id) };
    },
  };
}

module.exports = { adresseClient, adressePapote, choisirOption, optionsPossibles, erreurLisible, colisLivre, suiviColis, client };
