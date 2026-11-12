const test = require('node:test');
const assert = require('node:assert');
const mail = require('./mail');

test('espaces insécables avant la ponctuation, jamais dans les balises', () => {
  const m = mail.tabletteRecue({ nom: 'Paul', rembourse: 6000 });
  assert.match(m.html, /Merci&nbsp;!/);
  assert.match(m.html, /60&nbsp;€/);
  assert.match(m.html, /style="margin:0 0 16px"/);
  assert.doesNotMatch(m.text, /&nbsp;/);
});

test('désinscription sous le bouton, et e-mails internes sans « Une question ? »', () => {
  const r = mail.relancePanier({ etape: 1, nom: 'Paul', lien: 'https://x/c', desinscription: 'https://x/d' });
  assert.ok(r.html.indexOf('Reprendre ma commande') < r.html.indexOf('Se désinscrire'));
  assert.match(r.text, /Se désinscrire/);
  const n = mail.nouvelleCommande({ nom: 'Paul', email: 'p@x.fr', code: 'AB' });
  assert.doesNotMatch(n.html, /Une question/);
  assert.match(mail.commandeAnnulee({ nom: 'Paul' }).html, /Une question/);
  assert.strictEqual((mail.sepaRefuse({ nom: 'Paul' }).text.match(/Une question/g) || []).length, 1);
});

test('tablette remise en main propre : rien qui invite à changer d\'avis', () => {
  const m = mail.tabletteRemise({ nom: 'Marie', code: 'ABCD-1234' });
  assert.ok(m.html.includes('remise en main propre'));
  assert.ok(!m.text.includes('changer d\'avis'));
  assert.ok(!m.text.includes('60 €'));
});

test('blocs : fiche, étapes et encadré en HTML comme en texte brut', () => {
  const m = mail.colisParti({ nom: 'Julie', suivi: '12345678', lien: 'https://x/s', relais: { nom: 'Tabac', adresse: '4 rue', cp: '69003', ville: 'Lyon' }, code: 'ABCD-1234' });
  assert.match(m.html, /NUMÉRO DE SUIVI|Numéro de suivi/);
  assert.match(m.text, /Numéro de suivi : 12345678/);
  assert.match(m.text, /1\. Branchez la tablette/);
  const r = mail.retourTablette({ nom: 'Julie', avant: Date.UTC(2026, 10, 25), retractation: null, montant: 15000 });
  assert.match(r.html, /border-left:4px solid #4f46e5/);
  assert.match(r.text, /Date limite : 25 novembre 2026\. Sans retour à cette date, 150 € seront prélevés/);
});

test('aperçu dans la boîte de réception : la première vraie phrase, jamais « Bonjour »', () => {
  const m = mail.tabletteRecue({ nom: 'Paul', rembourse: 0 });
  assert.match(m.html, /<title>Nous avons bien reçu la tablette<\/title>/);
  assert.match(m.html, /display:none[^>]*>La tablette Papote est bien revenue chez nous\. Merci !/);
});

test('nouveaux e-mails : liste d\'attente, pause, matériel non rendu, demande acceptée, installation, rappel', () => {
  const l = mail.listeAttenteConfirmee({ prenom: 'Julie', telephone: '06 12 34 56 78', desinscription: 'https://x/d' });
  assert.match(l.text, /06 12 34 56 78/);
  assert.match(l.text, /Se désinscrire : https:\/\/x\/d/);
  assert.match(l.html, /demandé à être prévenu/);
  const p = mail.pausePrelevements({ nom: 'Julie', famille: 'Mamie Jeanne', jusqua: Date.UTC(2026, 11, 20) });
  assert.match(p.text, /reprennent le 20 décembre 2026/);
  assert.match(mail.reprisePrelevements({ nom: 'Julie' }).subject, /reprennent/);
  const n = mail.materielNonRendu({ nom: 'Julie', montant: 15000, avant: Date.UTC(2026, 10, 25) });
  assert.match(n.text, /150 € ont été prélevés/);
  assert.match(mail.demandeAcceptee({ prenom: 'Anne', famille: 'Mamie Jeanne' }).subject, /Bienvenue dans la famille de Mamie Jeanne/);
  const i = mail.installationFinie({ prenom: 'Julie', famille: 'Mamie Jeanne' });
  assert.match(i.text, /1\. Envoyer une photo/);
  assert.match(mail.rappelConfirme({ nom: 'Julie', telephone: '06 12 34 56 78' }).text, /rappelons au 06 12 34 56 78/);
});

test('tablette reçue : éléments manquants prélevés, ou prélèvement refusé', () => {
  const ok = mail.tabletteRecue({ nom: 'Julie', rembourse: 0, manquants: ['chargeur et câble'], montant: 1000 });
  assert.match(ok.text, /Il manquait dans le colis : chargeur et câble\. Comme prévu, 10 € ont été prélevés/);
  assert.doesNotMatch(ok.text, /^Vous n'avez plus rien à faire/m);
  const ko = mail.tabletteRecue({ nom: 'Julie', rembourse: 0, manquants: ['enceinte'], montant: 1000, echec: true });
  assert.match(ko.text, /n'a pas abouti : nous revenons vers vous/);
  assert.doesNotMatch(mail.tabletteRecue({ nom: 'Julie', rembourse: 0 }).text, /manquait/);
});

test('e-mails internes : lien vers la commande dans l\'admin, pied admin, budget', () => {
  const n = mail.nouvelleCommande({ nom: 'Julie', email: 'j@x.fr', code: 'AB', commande: 'sub_1', relais: { transporteur: 'mr', nom: 'Tabac', id: '1' }, delai: 'stock' });
  assert.match(n.text, /Ouvrir la commande : https:\/\/app\.mapapote\.fr\/admin\.html#commande\/sub_1/);
  assert.match(n.html, /pour Tanguy/);
  assert.doesNotMatch(n.html, /Une question/);
  const b = mail.budget({ palier: 'coupure', montant: '152,00 €', paliers: { alerte: 30, avertissement: 100, coupure: 150 }, coupee: false });
  assert.match(b.subject, /n'a pas pu couper/);
  const r = mail.recapSemaine({ aFaire: 2, lignes: [['À faire', ['a', 'b']]] });
  assert.match(r.subject, /2 choses à faire/);
  assert.match(r.text, /À FAIRE\n- a\n- b/);
  const c = mail.livresComptables({ titres: ['Octobre 2026'], resume: [['Octobre 2026', ['Recettes : 1 ligne, 25,00 €']]] });
  assert.match(c.text, /#compta/);
});

test('rien ne cite une ancienne formule, Linote, ni un essai gratuit', () => {
  const { scenes } = require('../outils/galerie/emails');
  // Les e-mails d'arrêt (resiliationEnregistree, resiliationAnnulee) arrivent par le fil gestion : absents ici, ignorés.
  for (const s of scenes(mail).filter((x) => x.contenu)) {
    for (const t of [s.contenu.subject, s.contenu.text]) {
      assert.doesNotMatch(t, /Linote|gratuit|90 jours|20 € par mois|30 € par mois|Belgique|Luxembourg|formule Wi-Fi/i, `${s.titre} : ${t.slice(0, 80)}`);
    }
    assert.ok(s.contenu.html.length < 60000, s.titre);
  }
});

test('Outlook et Gmail sans styles : carte de 560 px [if mso], bouton à toute épreuve, ni flex ni <div> dimensionné', () => {
  const m = mail.colisParti({ nom: 'Julie', suivi: '12345678', lien: 'https://x/s', relais: { nom: 'Tabac', adresse: '4 rue', cp: '69003', ville: 'Lyon' }, code: 'ABCD-1234' });
  assert.match(m.html, /<!--\[if mso\]><table role="presentation" width="560"/);
  assert.match(m.html, /mso-padding-alt:15px 28px"><a /);
  assert.match(m.html, /<o:PixelsPerInch>96<\/o:PixelsPerInch>/);
  assert.doesNotMatch(m.html, /display:(flex|grid)|position:/);
  assert.doesNotMatch(m.html, /<div style="width:/);
  assert.doesNotMatch(m.html, /<a href="[^"]*">/); // chaque lien a sa couleur en ligne
  for (const t of m.html.match(/<table\b[^>]*>/g)) assert.match(t, /role="presentation"/);
});

test('premier jour : allumer la tablette expliqué, pas de « décroche toute seule » trompeur', () => {
  // Audit premier jour (05/11) : la tablette décroche quand elle voit un visage, pas toute seule.
  const colis = mail.colisParti({ nom: 'Julie', suivi: '1', lien: 'https://x', relais: null, code: 'AB' });
  // Tanguy 12/11 (M9) : « bouton d'allumage (Power) », jamais « la tranche » ; personne n'a besoin d'être dans l'appli.
  assert.match(colis.text, /bouton d'allumage \(Power\)/);
  assert.doesNotMatch(colis.text, /tranche/);
  assert.match(colis.text, /Personne n'a besoin d'être dans l'appli Papote pour la brancher/);
  assert.match(colis.text, /laissez-la charger/);
  for (const m of [mail.installationFinie({ prenom: 'Julie', famille: 'Mamie Jeanne' }), mail.demandeAcceptee({ prenom: 'Anne', famille: 'Mamie Jeanne' })]) {
    assert.doesNotMatch(m.text, /décroche toute seule|n'a rien à faire/);
    assert.match(m.text, /regarde l.écran/);
  }
});

test('décès : e-mails de deuil, sans « Merci de nous avoir fait confiance », sans somme en gras, avec les photos à garder', () => {
  const le = Date.UTC(2027, 0, 5);
  const arret = mail.resiliationEnregistree({ nom: 'Paul', famille: 'Mamie Jeanne', le, tablettePretee: true, deces: true });
  assert.strictEqual(arret.subject, 'Nous pensons bien à vous');
  assert.match(arret.text, /condoléances/);
  assert.match(arret.text, /Tout télécharger/);
  assert.match(arret.text, /deux mois après l'arrêt/, 'après un décès : 60 jours pour rendre la tablette');
  const avis = mail.avantEffacement({ nom: 'Paul', famille: 'Mamie Jeanne', le, deces: true });
  assert.match(avis.text, /les photos, les vidéos et les messages s'enregistre/);
  assert.doesNotMatch(arret.text, /Garder mon abonnement|Merci de nous avoir/);
  const retour = mail.retourTablette({ nom: 'Paul', avant: le, retractation: null, montant: 14000, deces: true });
  assert.doesNotMatch(retour.text, /Merci de nous avoir fait confiance|seront prélevés/);
  assert.doesNotMatch(retour.html, /<b>140/);
  assert.match(retour.text, /Rien ne presse/);
  const rappel = mail.rappelRestitution({ nom: 'Paul', avant: le, lien: null, montant: 14000, deces: true });
  assert.doesNotMatch(rappel.html, /<b>140|seront prélevés/);
  // Sans décès : rien ne change.
  assert.match(mail.retourTablette({ nom: 'Paul', avant: le, retractation: null, montant: 14000 }).text, /Merci de nous avoir fait confiance/);
});

test('passer au SEPA : premier e-mail et relance, sans promesse impossible (10/11)', () => {
  const premier = mail.passerAuSepa({ nom: 'Julie', famille: 'Mamie Jeanne' });
  const relance = mail.passerAuSepa({ nom: 'Julie', famille: 'Mamie Jeanne', relance: true });
  assert.match(premier.subject, /Plus jamais de souci de carte/);
  assert.match(relance.subject, /rappel/);
  for (const m of [premier, relance]) {
    assert.match(m.text, /Passer au prélèvement/);
    assert.match(m.text, /IBAN/);
    assert.match(m.text, /sans engagement/);
    assert.doesNotMatch(m.text, /jamais coupée/);
    assert.match(m.html, /Mamie(&nbsp;| )Jeanne/);
  }
});
