// Stripe simulé pour les tests du parcours client : tout reste en mémoire, rien ne part chez Stripe
// et rien n'est payé. Seules les méthodes dont les fonctions se servent existent ; une méthode
// absente fait échouer le test (on voit tout de suite qu'il faut la simuler).
//
// En plus de l'API, des commandes « du test » jouent ce que ferait le client ou sa banque :
//   payerSession(id, client)  le client remplit la page de paiement (SEPA) et valide
//   evenements                événements que Stripe enverrait au webhook (vidés par la simulation)

const TARIFS = {
  papote_wifi_incluse: { montant: 2000, recurrent: true },
  papote_sim_incluse: { montant: 3000, recurrent: true },
  papote_wifi_achetee: { montant: 2000, recurrent: true },
  papote_sim_achetee: { montant: 3000, recurrent: true },
  papote_mise_en_service: { montant: 6000, recurrent: false },
};

function creerFauxStripe(horloge) {
  let compteur = 0;
  const id = (prefixe) => `${prefixe}_test${String(++compteur).padStart(6, '0')}`;
  const secondes = () => Math.floor(horloge() / 1000);
  const etat = {
    sessions: new Map(), abonnements: new Map(), clients: new Map(), factures: new Map(),
    paiements: new Map(), remboursements: [], lignes: [], evenements: [],
  };
  const prix = new Map(Object.entries(TARIFS).map(([cle, t]) => [`price_${cle}`, {
    id: `price_${cle}`, lookup_key: cle, unit_amount: t.montant, currency: 'eur', active: true,
    recurring: t.recurrent ? { interval: 'month' } : null,
  }]));
  const introuvable = (quoi, x) => Object.assign(new Error(`No such ${quoi}: '${x}'`), { code: 'resource_missing', statusCode: 404 });
  const lire = (table, quoi, x) => {
    const o = etat[table].get(x);
    if (!o) throw introuvable(quoi, x);
    return o;
  };
  const copie = (o) => structuredClone(o);
  // Liste Stripe : promesse de { data } qu'on peut aussi parcourir avec « for await » (pagination automatique).
  const liste = (elements) => {
    const p = Promise.resolve({ data: elements.map(copie), has_more: false });
    p[Symbol.asyncIterator] = async function* parcourir() { yield* elements.map(copie); };
    return p;
  };
  const evenement = (type, objet) => etat.evenements.push({ id: id('evt'), type, data: { object: copie(objet) } });

  // Paiement réussi d'une facture : PaymentIntent + charge, comme un prélèvement SEPA abouti.
  function payer(facture, client) {
    const pi = {
      id: id('pi'), amount: facture.amount_due, currency: 'eur', status: 'succeeded', customer: client.id,
      metadata: { ...(facture.metadata || {}) }, invoice: facture.id, description: facture.description || null,
    };
    pi.latest_charge = { id: id('ch'), amount: pi.amount, amount_refunded: 0, payment_intent: pi.id };
    etat.paiements.set(pi.id, pi);
    Object.assign(facture, { status: 'paid', amount_paid: facture.amount_due, payment_intent: pi.id });
    return pi;
  }

  function nouvelleFacture(client, { lignes, abonnement = null, metadata = {}, description = null }) {
    const f = {
      id: id('in'), customer: client.id, subscription: abonnement, status: 'draft', metadata, description,
      lines: { data: lignes }, amount_due: lignes.reduce((t, l) => t + l.amount, 0), amount_paid: 0, payment_intent: null,
      created: secondes(),
    };
    etat.factures.set(f.id, f);
    return f;
  }

  const api = {
    prices: {
      list: ({ lookup_keys: cles }) => liste([...prix.values()].filter((p) => cles.includes(p.lookup_key))),
    },
    checkout: {
      sessions: {
        create: async (params) => {
          if (params.expires_at && params.expires_at < secondes() + 30 * 60 - 5) {
            throw new Error('expires_at doit être au moins 30 minutes après maintenant');
          }
          const s = {
            id: id('cs'), object: 'checkout.session', status: 'open', payment_status: 'unpaid', mode: params.mode,
            url: null, metadata: { ...(params.metadata || {}) }, customer: params.customer || null,
            customer_email: params.customer_email || null, customer_details: null, subscription: null,
            amount_total: null, created: secondes(), params: copie(params),
          };
          s.url = `https://checkout.stripe.test/${s.id}`;
          etat.sessions.set(s.id, s);
          return copie(s);
        },
        retrieve: async (x) => copie(lire('sessions', 'checkout.session', x)),
      },
    },
    customers: {
      update: async (x, maj) => Object.assign(lire('clients', 'customer', x), copie(maj)),
      retrieve: async (x) => copie(lire('clients', 'customer', x)),
    },
    subscriptions: {
      retrieve: async (x, options = {}) => {
        const a = copie(lire('abonnements', 'subscription', x));
        const etendre = options.expand || [];
        if (etendre.includes('customer')) a.customer = copie(lire('clients', 'customer', a.customer));
        if (etendre.includes('default_payment_method')) {
          const c = etat.clients.get(a.customer);
          a.default_payment_method = c ? copie(c.moyen) : null;
        }
        return a;
      },
      update: async (x, maj) => {
        const a = lire('abonnements', 'subscription', x);
        for (const [k, v] of Object.entries(maj)) {
          if (k === 'proration_behavior') continue;
          if (k === 'metadata') a.metadata = { ...v };
          else if (k === 'trial_end') {
            // Comme Stripe : un abonnement actif repasse en essai jusqu'à cette date, qui devient le début des mois.
            a.trial_end = v;
            a.status = 'trialing';
            a.billing_cycle_anchor = v;
            a.current_period_end = v;
            a.items.data[0].current_period_end = v;
          }
          else if (k === 'cancel_at') a.cancel_at = v === '' ? null : v;
          else if (k === 'pause_collection') a.pause_collection = v === '' ? null : v;
          else a[k] = v;
        }
        evenement('customer.subscription.updated', a);
        return copie(a);
      },
      cancel: async (x) => {
        const a = lire('abonnements', 'subscription', x);
        if (a.status === 'canceled') throw new Error('Subscription already canceled');
        a.status = 'canceled';
        a.canceled_at = secondes();
        a.ended_at = secondes();
        a.cancellation_details = { reason: 'cancellation_requested' };
        evenement('customer.subscription.deleted', a);
        return copie(a);
      },
    },
    invoices: {
      list: ({ subscription, status }) => liste([...etat.factures.values()]
        .filter((f) => (!subscription || f.subscription === subscription) && (!status || f.status === status))),
      create: async ({ customer, metadata }) => {
        const client = lire('clients', 'customer', customer);
        const lignes = etat.lignes.filter((l) => l.customer === customer && !l.facture);
        const f = nouvelleFacture(client, { lignes, metadata });
        lignes.forEach((l) => { l.facture = f.id; });
        return copie(f);
      },
      finalizeInvoice: async (x) => {
        const f = lire('factures', 'invoice', x);
        f.status = 'open';
        return copie(f);
      },
      pay: async (x) => {
        const f = lire('factures', 'invoice', x);
        payer(f, lire('clients', 'customer', f.customer));
        evenement('invoice.paid', f);
        return copie(f);
      },
    },
    invoiceItems: {
      create: async ({ customer, amount, description, metadata }) => {
        const l = { id: id('ii'), customer, amount, description, metadata };
        etat.lignes.push(l);
        return copie(l);
      },
    },
    paymentIntents: {
      retrieve: async (x) => copie(lire('paiements', 'payment_intent', x)),
      create: async ({ amount, customer, description, metadata }) => {
        const client = lire('clients', 'customer', customer);
        const f = nouvelleFacture(client, { lignes: [{ amount, description }], metadata, description });
        const pi = payer(f, client);
        pi.description = description;
        return copie(pi);
      },
    },
    refunds: {
      create: async ({ payment_intent: x, amount }, options = {}) => {
        const cle = options.idempotencyKey;
        const deja = cle && etat.remboursements.find((r) => r.cle === cle);
        if (deja) return copie(deja);
        const pi = lire('paiements', 'payment_intent', x);
        const reste = pi.latest_charge.amount - pi.latest_charge.amount_refunded;
        const montant = amount == null ? reste : amount;
        if (montant > reste || montant <= 0) throw new Error(`Charge ${pi.latest_charge.id} has already been refunded.`);
        pi.latest_charge.amount_refunded += montant;
        const r = { id: id('re'), amount: montant, payment_intent: x, cle };
        etat.remboursements.push(r);
        return copie(r);
      },
    },
    billingPortal: {
      configurations: { list: async () => ({ data: [{ id: 'bpc_test', metadata: { papote: '1' } }] }) },
      sessions: { create: async () => ({ url: 'https://billing.stripe.test/session' }) },
    },
    webhooks: {
      // La simulation signe ses événements avec « faux » : tout le reste est refusé, comme une vraie signature fausse.
      constructEvent: (corps, signature) => {
        if (signature !== 'faux') throw new Error('No signatures found matching the expected signature for payload');
        return JSON.parse(Buffer.isBuffer(corps) ? corps.toString('utf8') : corps);
      },
    },
  };

  // ---------- Ce que font le client et sa banque ----------

  // Le client remplit la page de paiement : IBAN, nom, e-mail. sepaEnAttente : la banque confirme plus tard.
  function payerSession(sessionId, { email, nom = 'Julie Martin', telephone = '+33612345678', iban = 'FR76-1234', sepaEnAttente = false } = {}) {
    const s = lire('sessions', 'checkout.session', sessionId);
    if (s.status !== 'open') throw new Error(`Session ${sessionId} déjà ${s.status}`);
    const p = s.params;
    const adresse = { line1: '3 rue des Lilas', postal_code: '69006', city: 'Lyon', country: 'FR' };
    let client = p.customer ? lire('clients', 'customer', p.customer) : null;
    if (!client) {
      client = { id: id('cus'), email: email || p.customer_email, name: nom, invoice_settings: {} };
      etat.clients.set(client.id, client);
    }
    client.moyen = {
      id: id('pm'), type: 'sepa_debit', billing_details: { name: nom },
      sepa_debit: { fingerprint: `empreinte-${iban}`, last4: iban.slice(-4) },
    };
    client.invoice_settings.default_payment_method = client.moyen.id;
    const lignes = p.line_items.map((l) => prix.get(l.price));
    const mensuel = lignes.find((l) => l.recurring);
    const essai = p.subscription_data.trial_period_days;
    // Date de départ posée au paiement (billing_cycle_anchor) : abonnement « active », premier mois à cette date.
    const depart = p.subscription_data.billing_cycle_anchor || null;
    const finPeriode = essai ? secondes() + essai * 86400 : (depart || secondes() + 30 * 86400);
    const a = {
      id: id('sub'), object: 'subscription', customer: client.id, status: essai ? 'trialing' : 'active',
      metadata: { ...p.subscription_data.metadata }, trial_end: essai ? finPeriode : null,
      billing_cycle_anchor: finPeriode, start_date: secondes(),
      current_period_end: finPeriode, cancel_at: null, cancel_at_period_end: false,
      default_payment_method: client.moyen.id, pause_collection: null, created: secondes(),
      items: { data: [{ price: mensuel, quantity: 1, current_period_end: finPeriode }] },
    };
    etat.abonnements.set(a.id, a);
    // Première facture : la mise en service (60 €), payée tout de suite (sauf SEPA en attente de la banque).
    const unique = lignes.filter((l) => !l.recurring);
    const f = nouvelleFacture(client, { lignes: unique.map((l) => ({ amount: l.unit_amount, price: l.id })), abonnement: a.id });
    if (!sepaEnAttente) payer(f, client);
    else f.status = 'open';
    Object.assign(s, {
      status: 'complete', payment_status: sepaEnAttente ? 'unpaid' : 'paid', subscription: a.id, customer: client.id,
      customer_details: { email: email || p.customer_email, name: nom, phone: telephone, address: adresse },
      amount_total: f.amount_due,
    });
    evenement('customer.subscription.created', a);
    evenement('checkout.session.completed', s);
    return { session: copie(s), abonnement: a.id, client: client.id };
  }

  // La banque confirme le prélèvement SEPA de la mise en service.
  function banqueAccepte(sessionId) {
    const s = lire('sessions', 'checkout.session', sessionId);
    const f = [...etat.factures.values()].find((x) => x.subscription === s.subscription && x.status === 'open');
    payer(f, lire('clients', 'customer', s.customer));
    s.payment_status = 'paid';
    evenement('checkout.session.async_payment_succeeded', s);
  }

  function banqueRefuse(sessionId) {
    evenement('checkout.session.async_payment_failed', lire('sessions', 'checkout.session', sessionId));
  }

  // Le client ferme la page de paiement sans payer : elle expire.
  function expirerSession(sessionId) {
    const s = lire('sessions', 'checkout.session', sessionId);
    s.status = 'expired';
    evenement('checkout.session.expired', s);
  }

  // Fin du mois offert : Stripe prélève le premier mois (abonnement « active »).
  function finirEssai(abonnementId) {
    const a = lire('abonnements', 'subscription', abonnementId);
    const client = lire('clients', 'customer', a.customer);
    const mensuel = a.items.data[0].price;
    a.status = 'active';
    a.trial_end = a.trial_end ? secondes() : null;
    a.billing_cycle_anchor = secondes();
    a.current_period_end = secondes() + 30 * 86400;
    a.items.data[0].current_period_end = a.current_period_end;
    const f = nouvelleFacture(client, { lignes: [{ amount: mensuel.unit_amount, price: mensuel.id }], abonnement: a.id });
    payer(f, client);
    evenement('customer.subscription.updated', a);
    evenement('invoice.paid', f);
  }

  // Prélèvement du mois refusé par la banque : abonnement « past_due », facture ouverte.
  function banqueRefusePrelevement(abonnementId) {
    const a = lire('abonnements', 'subscription', abonnementId);
    const client = lire('clients', 'customer', a.customer);
    const mensuel = a.items.data[0].price;
    a.status = 'past_due';
    const f = nouvelleFacture(client, { lignes: [{ amount: mensuel.unit_amount, price: mensuel.id }], abonnement: a.id });
    f.status = 'open';
    evenement('invoice.payment_failed', f);
    evenement('customer.subscription.updated', a);
  }

  // Le client a changé de carte : la facture ouverte est payée, l'abonnement redevient « active ».
  function banqueAccepteEnRetard(abonnementId) {
    const a = lire('abonnements', 'subscription', abonnementId);
    const f = [...etat.factures.values()].find((x) => x.subscription === a.id && x.status === 'open');
    if (f) payer(f, lire('clients', 'customer', a.customer));
    a.status = 'active';
    evenement('invoice.paid', f || {});
    evenement('customer.subscription.updated', a);
  }

  // Date d'arrêt demandée (cancel_at) atteinte : Stripe arrête l'abonnement.
  function arreterALaDate(abonnementId) {
    const a = lire('abonnements', 'subscription', abonnementId);
    if (!a.cancel_at) throw new Error(`Abonnement ${abonnementId} : aucune résiliation demandée`);
    a.status = 'canceled';
    a.canceled_at = secondes();
    a.ended_at = a.cancel_at;
    a.cancellation_details = { reason: 'cancellation_requested' };
    evenement('customer.subscription.deleted', a);
  }

  // Remise à zéro entre deux scénarios.
  function vider() {
    for (const v of Object.values(etat)) {
      if (v instanceof Map) v.clear();
      else v.length = 0;
    }
  }

  const rembourse = (abonnement) => etat.remboursements
    .filter((r) => (etat.paiements.get(r.payment_intent) || {}).invoice
      && (etat.factures.get(etat.paiements.get(r.payment_intent).invoice) || {}).subscription === abonnement)
    .reduce((t, r) => t + r.amount, 0);

  return { api, etat, payerSession, banqueAccepte, banqueRefuse, banqueRefusePrelevement, banqueAccepteEnRetard, expirerSession, finirEssai, arreterALaDate, rembourse, vider };
}

module.exports = { creerFauxStripe };
