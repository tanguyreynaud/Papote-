const test = require('node:test');
const assert = require('node:assert');
const { nettoyer } = require('./support')._test;

test('garde une conversation correcte', () => {
  const m = [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Bonjour !' }, { role: 'user', content: ' Prix ? ' }];
  assert.deepStrictEqual(nettoyer(m)[2], { role: 'user', content: 'Prix ?' });
});

test('refuse ce qui ne finit pas par une question', () => {
  assert.strictEqual(nettoyer([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]), null);
  assert.strictEqual(nettoyer('x'), null);
  assert.strictEqual(nettoyer([]), null);
});

test('refuse deux messages du même côté et les rôles inconnus', () => {
  assert.strictEqual(nettoyer([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]), null);
  assert.deepStrictEqual(nettoyer([{ role: 'system', content: 'x' }, { role: 'user', content: 'a' }]), [{ role: 'user', content: 'a' }]);
});

test('coupe les messages trop longs et trop nombreux', () => {
  const long = [{ role: 'user', content: 'x'.repeat(5000) }];
  assert.strictEqual(nettoyer(long)[0].content.length, 1000);
  const beaucoup = [];
  for (let i = 0; i < 30; i++) beaucoup.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
  beaucoup.push({ role: 'user', content: 'fin' });
  // 31 messages : on garde les 12 derniers, puis on retire l'assistant de tête.
  const r = nettoyer(beaucoup);
  assert.strictEqual(r[0].role, 'user');
  assert.strictEqual(r[r.length - 1].content, 'fin');
});

const { coordonneesValides, lireReponse, ACTIONS, consigneActions, consigneMain, etatMain, PHRASE_RAPPEL, PHRASE_DECLARATION } = require('./support')._test;

test('accepte un téléphone ou un e-mail', () => {
  assert.deepStrictEqual(coordonneesValides('06 12 34 56 78'), { telephone: '06 12 34 56 78' });
  assert.deepStrictEqual(coordonneesValides('+33 6 12 34 56 78'), { telephone: '+33 6 12 34 56 78' });
  assert.deepStrictEqual(coordonneesValides(' a@b.fr '), { email: 'a@b.fr' });
  assert.strictEqual(coordonneesValides('1234'), null);
  assert.strictEqual(coordonneesValides('bonjour'), null);
});

test('repère la marque de passage de main', () => {
  assert.deepStrictEqual(lireReponse('Quelqu’un va vous recontacter.\n[CONTACT]'), { reponse: 'Quelqu’un va vous recontacter.\n\n' + PHRASE_RAPPEL, contact: true });
  assert.deepStrictEqual(lireReponse('20 € par mois.'), { reponse: '20 € par mois.', contact: false });
});

test('retire le gras markdown', () => {
  assert.strictEqual(lireReponse('Allez dans **Réglages**.').reponse, 'Allez dans Réglages.');
});

test('retire la phrase de refus collée à une vraie réponse', () => {
  assert.strictEqual(lireReponse('Renvoyez-la sous 30 jours. Je ne peux vous aider que pour Papote : avez-vous une question sur la tablette ou l\'appli ?').reponse, 'Renvoyez-la sous 30 jours.');
  const refus = 'Je ne peux vous aider que pour Papote. Avez-vous une question sur la tablette ou l\'appli ?';
  assert.strictEqual(lireReponse(refus).reponse, refus);
});

test('coordonnées à l\'ouverture du chat : tout est obligatoire, accord seulement si coché', () => {
  const { inscriptionValide } = require('./support')._test;
  assert.deepStrictEqual(inscriptionValide({ prenom: ' Léa ', nom: 'Martin', telephone: '06 12 34 56 78', email: 'Lea@X.fr' }),
    { prenom: 'Léa', nom: 'Martin', telephone: '06 12 34 56 78', email: 'lea@x.fr', marketing: false });
  assert.strictEqual(inscriptionValide({ prenom: 'Léa', nom: 'Martin', telephone: '0612345678', email: 'lea@x.fr', marketing: 'oui' }).marketing, false);
  assert.strictEqual(inscriptionValide({ prenom: 'Léa', nom: 'Martin', telephone: '0612345678', email: 'lea@x.fr', marketing: true }).marketing, true);
  assert.strictEqual(inscriptionValide({ prenom: 'Léa', telephone: '0612345678', email: 'lea@x.fr' }), null);
  assert.strictEqual(inscriptionValide({ prenom: 'Léa', nom: 'Martin', telephone: '0612', email: 'lea@x.fr' }), null);
  assert.strictEqual(inscriptionValide({ prenom: 'Léa', nom: 'Martin', telephone: '0612345678', email: 'lea' }), null);
});

// Le guide du chat ne doit plus contredire l'offre (audit du 2026-11-03).
test('le guide ne dit plus que la commande est fermée ni que deux abonnements vont dans une famille', () => {
  const guide = require('fs').readFileSync(require('path').join(__dirname, 'support-connaissances.md'), 'utf8');
  for (const faux of ["pas encore ouvert", "liste d'attente", 'avec deux abonnements', '45 minutes', 'au lancement']) {
    assert.ok(!guide.includes(faux), `le guide contient encore « ${faux} »`);
  }
  for (const vrai of ['bouton « Commander »', 'État du stock', 'une famille Papote = une tablette', 'environ une heure', 'Livraison à domicile', 'numéro de téléphone']) {
    assert.ok(guide.includes(vrai), `le guide ne contient pas « ${vrai} »`);
  }
  const { STOCK_DISPONIBLE, STOCK_EPUISE } = require('./support')._test;
  assert.ok(STOCK_DISPONIBLE.startsWith('# État du stock') && STOCK_EPUISE.startsWith('# État du stock'));
  assert.ok(STOCK_DISPONIBLE.includes('Commander') && STOCK_EPUISE.includes('Être prévenu'));
});

// 18/11 (banc élargi) : la marque écrite au milieu d'une phrase n'ouvre pas le formulaire de contact.
test('la marque de contact ne compte que si elle termine la réponse', () => {
  assert.strictEqual(lireReponse('Il faut une pièce d’identité.\n\n[CONTACT] ne s’applique pas ici.').contact, false);
  assert.strictEqual(lireReponse('Il faut une pièce d’identité.\n\n[CONTACT] ne s’applique pas ici.').reponse.includes('[CONTACT]'), false);
  assert.strictEqual(lireReponse('Quelqu’un va vous recontacter.\n[CONTACT]\n').contact, true);
});

// 18/11 (Tanguy) : ni prénom ni numéro de téléphone dans ce que le chat peut recopier des pages légales.
test('le texte du site donné au chat ne contient ni prénom ni numéro de téléphone', () => {
  const { sansPersonne } = require('./support')._test;
  const lu = sansPersonne('Papote, nom commercial de Tanguy Reynaud, 111 avenue Thiers, contact@mapapote.fr, téléphone 06 76 77 11 70 (laissez un message, nous rappelons). Tanguy répond lui-même.');
  assert.ok(!/Tanguy/.test(lu), lu);
  assert.ok(!/0\d[ .]?\d{2}/.test(lu), lu);
  assert.ok(/contact@mapapote\.fr/.test(lu));
});

test('ni les consignes ni le guide du chat ne citent un prénom ou un numéro de téléphone', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const guide = fs.readFileSync(path.join(__dirname, 'support-connaissances.md'), 'utf8');
  const code = fs.readFileSync(path.join(__dirname, 'support.js'), 'utf8');
  const consignes = code.match(/const CONSIGNES = `([\s\S]*?)`;/)[1];
  assert.ok(!/Tanguy/.test(guide) && !/Tanguy/.test(consignes));
  assert.ok(!/0[67](?:[ .]?\d{2}){4}/.test(guide + consignes));
});

test('boutons [ALLER:x] : retirés du texte, gardés seulement s\'ils sont permis sur la page', () => {
  assert.deepStrictEqual(lireReponse('Ouvrez Réglages, « Dépanner la tablette ».\n[ALLER:depanner]', 'appli'),
    { reponse: 'Ouvrez Réglages, « Dépanner la tablette ».', contact: false, actions: ['depanner'] });
  // Inconnue, ou réservée à l'autre page : ignorée, mais jamais laissée dans le texte.
  const inconnu = lireReponse('Voici.\n[ALLER:payer]\n[ALLER:commander]', 'appli');
  // Sur le site, un écran de l'appli est permis (bouton « Dans l'appli »).
  assert.deepStrictEqual(lireReponse('Changez de carte dans l\'appli.\n[ALLER:abonnement]', 'site').actions, ['abonnement']);
  assert.deepStrictEqual(inconnu, { reponse: 'Voici.', contact: false });
  assert.deepStrictEqual(lireReponse('Commandez ici.\n[ALLER:commander]', 'site').actions, ['commander']);
  // Deux au plus, sans doublon, casse et espaces tolérés.
  assert.deepStrictEqual(lireReponse('A.\n[ALLER:volumes] [aller: Volumes] [ALLER:nuit] [ALLER:wifi]', 'appli').actions, ['volumes', 'nuit']);
  // Sans page connue : aucun bouton.
  assert.strictEqual(lireReponse('A.\n[ALLER:depanner]').actions, undefined);
});

test('boutons : la passation de main reste reconnue avec une balise avant ou après', () => {
  const lu = lireReponse('Regardez l\'abonnement.\n[ALLER:abonnement]\n[CONTACT]', 'appli');
  assert.deepStrictEqual(lu, { reponse: 'Regardez l\'abonnement.\n\n' + PHRASE_RAPPEL, contact: true, actions: ['abonnement'] });
  assert.strictEqual(lireReponse('Regardez.\n[CONTACT]\n[ALLER:abonnement]', 'appli').contact, true);
});

test('boutons : déduits du libellé cité quand l\'IA oublie la balise (appli seulement)', () => {
  assert.deepStrictEqual(lireReponse('Allez dans Réglages, « Dépanner la tablette », puis « Redémarrer la tablette ».', 'appli').actions, ['depanner']);
  assert.deepStrictEqual(lireReponse('Onglet Profil, « Gérer le paiement et les factures ». Sinon Réglages, « Changer le Wi-Fi », ou « Volumes ».', 'appli').actions, ['abonnement', 'wifi']);
  assert.strictEqual(lireReponse('Allez dans Réglages, « Dépanner la tablette ».', 'site').actions, undefined);
  assert.strictEqual(lireReponse('Bonjour, comment puis-je vous aider ?', 'appli').actions, undefined);
  assert.deepStrictEqual(lireReponse('Réglages, « Dépanner la tablette ».\n[ALLER:nuit]', 'appli').actions, ['nuit']);
});

test('boutons : aucune action ne touche à l\'argent, et la consigne le dit', () => {
  for (const nom of [...Object.keys(ACTIONS.appli), ...Object.keys(ACTIONS.site)]) assert.doesNotMatch(nom, /pay|resili(?!er$)|annul|rembours/);
  assert.match(consigneActions('appli'), /\[ALLER:depanner\]/);
  assert.doesNotMatch(consigneActions('appli'), /\[ALLER:commander\]/);
  assert.match(consigneActions('site'), /c'est elle qui appuie/);
});

test('passage de main : la phrase est posée par le serveur, une seule fois', () => {
  // Vu sur 121 conversations de 6 messages : phrase en double, phrase sans la marque, marque avant la phrase.
  const double = lireReponse('Je comprends. ' + PHRASE_RAPPEL + '\n\n' + PHRASE_RAPPEL + '\n[CONTACT]', 'site');
  assert.deepStrictEqual(double, { reponse: 'Je comprends.\n\n' + PHRASE_RAPPEL, contact: true });
  const sansMarque = lireReponse('Je regarde.\n\n\n\n' + PHRASE_RAPPEL.replace(/’/g, "'"), 'site');
  assert.deepStrictEqual(sansMarque, { reponse: 'Je regarde.\n\n' + PHRASE_RAPPEL, contact: true });
  const marqueAvant = lireReponse('Je regarde.\n\n[CONTACT]\n\n' + PHRASE_RAPPEL + '\n[ALLER:abonnement]', 'appli');
  assert.deepStrictEqual(marqueAvant, { reponse: 'Je regarde.\n\n' + PHRASE_RAPPEL, contact: true, actions: ['abonnement'] });
  // Appli avec la demande guidée : l'autre phrase, même si l'IA a recopié l'ancienne.
  assert.strictEqual(lireReponse('Écran fissuré. ' + PHRASE_RAPPEL + '\n[CONTACT]', 'appli', true).reponse, 'Écran fissuré.\n\n' + PHRASE_DECLARATION);
  assert.strictEqual(lireReponse('Écran fissuré.\n[CONTACT]', 'site', true).reponse, 'Écran fissuré.\n\n' + PHRASE_RAPPEL);
  assert.strictEqual(lireReponse('25 € par mois.', 'site').reponse, '25 € par mois.');
  assert.match(consigneMain('site', false), /Ne l'écris donc jamais toi-même/);
});

test('passage de main : une fois faite, elle n\'est pas répétée à chaque message', () => {
  const avant = [{ role: 'user', content: 'Double prélèvement' }, { role: 'assistant', content: 'L\'équipe doit vérifier.\n\n' + PHRASE_RAPPEL }, { role: 'user', content: 'Et je suis remboursée quand ?' }];
  assert.strictEqual(etatMain(avant), 'proposee');
  assert.strictEqual(etatMain(avant.slice(0, 1)), '');
  assert.match(consigneMain('appli', false, 'proposee'), /DÉJÀ été passée/);
  // Demande envoyée (la bulle l'écrit dans l'historique) : on ne la repropose plus.
  const apres = avant.concat([{ role: 'user', content: '(Demande de rappel envoyée)' }, { role: 'assistant', content: 'Merci ! Votre demande est bien arrivée.' }, { role: 'user', content: 'Et maintenant ?' }]);
  assert.strictEqual(etatMain(apres), 'envoyee');
  assert.match(consigneMain('site', false, 'envoyee'), /DÉJÀ envoyé sa demande/);
  assert.deepStrictEqual(lireReponse('Sous 14 jours.\n[CONTACT]', 'appli', false, 'proposee'), { reponse: 'Sous 14 jours.', contact: true });
  assert.deepStrictEqual(lireReponse('Nouveau souci.\n[CONTACT]', 'appli', false, 'envoyee'), { reponse: 'Nouveau souci.\n\n' + PHRASE_RAPPEL, contact: true });
});

test('passage de main : phrase selon la page et la bulle', () => {
  assert.match(consigneMain('site', true), /Laissez votre téléphone et votre e-mail/);
  assert.match(consigneMain('appli', false), /Laissez votre téléphone et votre e-mail/);
  assert.match(consigneMain('appli', true), /Remplissez la petite demande/);
  assert.match(consigneMain('appli', true), /Ne promets rien sur l’argent/);
  assert.match(consigneActions('site'), /déjà cliente/);
});

// Tanguy, 18/11 : tout responsable gère l'abonnement, pas seulement le propriétaire ; l'assistant ne doit pas dire l'inverse.
test('le guide dit que tout responsable gère l\'abonnement', () => {
  const guide = require('fs').readFileSync(require('path').join(__dirname, 'support-connaissances.md'), 'utf8');
  assert.ok(!/Seul le propriétaire de la famille|Elle seule règle la tablette/.test(guide));
  assert.ok(guide.includes('Tous les responsables de la famille voient ces boutons, qu\'ils paient ou non'));
});

test('contact : le chat demande pourquoi avant de passer la main, sauf pour un futur acheteur', () => {
  const { CONSIGNES } = require('./support')._test;
  assert.ok(CONSIGNES.includes('ne passe pas la main tout de suite. Demande d\'abord'));
  assert.ok(CONSIGNES.includes('elle insiste : ne redemande rien'));
  assert.ok(CONSIGNES.includes('quelqu\'un qui veut acheter'));
  assert.ok(CONSIGNES.includes('passe la main tout de suite, sans demander pourquoi'));
  assert.ok(!CONSIGNES.includes('ne discute pas et ne repose pas de question'));
});

test('contact : ni le guide ni le site ne renvoient vers l\'e-mail (hors pages légales et envoi d\'un document)', () => {
  const fs = require('fs');
  const path = require('path');
  const guide = fs.readFileSync(path.join(__dirname, 'support-connaissances.md'), 'utf8');
  const lignes = guide.split('\n').filter((l) => l.includes('contact@mapapote.fr'));
  assert.strictEqual(lignes.length, 2);
  assert.ok(lignes[0].includes('justificatif d\'hospitalisation'));
  assert.ok(lignes[1].includes('ne pas envoyer les gens vers contact@mapapote.fr'));
  const vitrine = path.join(__dirname, '..', 'vitrine');
  const legales = ['cgv.html', 'mentions.html', 'confidentialite.html', 'merci.html'];
  for (const f of fs.readdirSync(vitrine).filter((n) => n.endsWith('.html') && !legales.includes(n))) {
    const html = fs.readFileSync(path.join(vitrine, f), 'utf8');
    assert.ok(!/mailto:|contact@mapapote\.fr/.test(html), f + ' renvoie encore vers l\'e-mail');
    if (html.includes('data-ouvrir-chat')) assert.ok(html.includes('chat-support.js'), f + ' : bouton du chat sans la bulle');
  }
});

test('passage de main : une variante de la phrase écrite par l\'IA n\'est pas laissée en double', () => {
  const { lireReponse, PHRASE_RAPPEL } = require('./support')._test;
  const lu = lireReponse('Je ne vois pas la raison du refus. Laissez votre téléphone et votre e-mail ci-dessous, et quelqu\'un de l\'équipe vous recontactera.\n[CONTACT]', 'site', false, '');
  assert.strictEqual(lu.contact, true);
  assert.strictEqual(lu.reponse, 'Je ne vois pas la raison du refus.\n\n' + PHRASE_RAPPEL);
  assert.ok(require('./support')._test.CONSIGNES.includes('Tu ne poses cette question qu\'une seule fois'));
});

test('passage de main : une promesse « je transmets » sans formulaire affiche le formulaire', () => {
  const { lireReponse, PHRASE_RAPPEL } = require('./support')._test;
  for (const t of ['Je transmets votre question à l\'équipe Papote pour qu\'elle vérifie ce mail.', 'Merci, l\u2019équipe Papote vous répondra sous 48 heures.', 'Merci, votre numéro est bien noté.']) {
    const lu = lireReponse(t, 'site', false, '');
    assert.strictEqual(lu.contact, true, t);
    assert.ok(lu.reponse.endsWith(PHRASE_RAPPEL), t);
  }
  // Demande déjà envoyée : la même phrase est vraie, rien à réafficher.
  assert.strictEqual(lireReponse('L\'équipe Papote vous répondra sous 48 heures.', 'site', false, 'envoyee').contact, false);
  // Phrase générale sur le délai : pas un passage de main.
  assert.strictEqual(lireReponse('Sans numéro enregistré, la tablette appelle par internet.', 'appli', false, '').contact, false);
  assert.strictEqual(lireReponse('Papote n\'a pas de numéro : on passe par ce chat, et l\'équipe répond sous 48 h quand elle doit prendre le relais.', 'site', false, '').contact, false);
});

test('le guide garde les erreurs déjà commises à ne pas refaire', () => {
  const guide = require('fs').readFileSync(require('path').join(__dirname, 'support-connaissances.md'), 'utf8');
  for (const t of ['Qui appelle qui', 'pas la barre « Sonnerie »', 'ne jamais l\'envoyer vers « Commander »', 'Jamais pour une tablette en panne', 'TOUTES les tablettes Papote ont leur carte SIM']) assert.ok(guide.includes(t), t);
});
