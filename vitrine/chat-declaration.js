// Déclaration guidée dans la bulle d'aide de l'appli famille (chantier 3 du chat, 18/11/2026).
// Chargé par chat-support.js, seulement dans l'appli (la personne est connectée). Quand l'assistant passe la main,
// la bulle montre cette petite demande au lieu de « laissez votre téléphone et votre e-mail » :
//   1. ce qui se passe (chargeur, écran, tablette abîmée, vol ou perte, colis, panne, données, autre) ;
//   2. deux questions à toucher, un mot si besoin, et 1 à 3 photos (appareil photo ou galerie), réduites ici
//      avant l'envoi. Photo obligatoire pour l'écran, la tablette abîmée et le colis ;
//   3. un seul envoi à declarationChat (functions/declaration.js) avec le jeton de l'appli : la demande arrive
//      dans l'admin avec l'état de la tablette, et par e-mail à l'équipe, photos jointes.
// Gestes : double appui = un seul envoi (bouton bloqué + même clé côté serveur) ; coupure réseau = « Réessayer »
// avec la même clé, rien n'est perdu ni envoyé deux fois. Le formulaire en cours (réponses, photos) reste si on
// ferme puis rouvre la bulle. Aucune boîte confirm/alert.
// Interface avec l'appli : window.papoteJeton() → Promise<jeton|null>, window.papoteFamille() → id de la famille.
(function () {
  if (window.PapoteDeclaration) return;

  var API = 'https://europe-west1-papote-famille.cloudfunctions.net/declarationChat';
  var EMAIL = 'contact@mapapote.fr';
  var MAX_PHOTOS = 3;
  var COTE_MAX = 1600; // px : assez pour voir une fissure, léger à envoyer (≈ 200 à 400 Ko)

  // q : questions à toucher (multi = plusieurs réponses possibles) ; t : champ texte facultatif ;
  // photo : 'oui' obligatoire, 'non' pas de photo, sinon facultative ; aide : phrase sous les photos.
  var MOTIFS = [
    { id: 'chargeur', libelle: 'Chargeur perdu ou abîmé', photo: 'facultative',
      q: [
        { titre: 'Le chargeur est…', choix: ['Perdu', 'Abîmé (câble ou prise)', 'Il ne charge plus'] },
        { titre: 'Avez-vous essayé un autre chargeur USB-C, celui d’un téléphone par exemple ?', choix: ['Oui, ça ne charge toujours pas', 'Je n’en ai pas', 'Pas encore'],
          conseil: { 'Pas encore': 'Essayez d’abord : n’importe quel chargeur et câble USB-C convient, et cela règle presque toujours le problème.' } },
      ] },
    { id: 'ecran', libelle: 'Écran fissuré ou cassé', photo: 'oui', aide: 'Photographiez l’écran en entier, puis la fissure de près.',
      q: [
        { titre: 'Que s’est-il passé ?', choix: ['Une chute', 'Un choc', 'Je ne sais pas'] },
        { titre: 'La tablette marche-t-elle encore ?', choix: ['Oui, normalement', 'Oui, mais l’écran répond mal', 'Non, écran noir'] },
      ] },
    { id: 'casse', libelle: 'Tablette abîmée (coque, socle, bouton)', photo: 'oui', aide: 'Photographiez la tablette en entier, puis ce qui est abîmé.',
      q: [
        { titre: 'Qu’est-ce qui est abîmé ?', choix: ['La coque ou le dos', 'Le socle', 'Un bouton', 'Autre chose'] },
        { titre: 'La tablette marche-t-elle encore ?', choix: ['Oui, normalement', 'Oui, mais pas bien', 'Non'] },
      ] },
    { id: 'vol', libelle: 'Tablette volée ou perdue', photo: 'facultative', aide: 'Si vous avez déposé plainte, une photo du récépissé nous aide.',
      q: [
        { titre: 'Que s’est-il passé ?', choix: ['Elle a été volée', 'Elle est perdue', 'Je ne sais pas'] },
        { titre: 'Depuis quand ?', choix: ['Aujourd’hui', 'Cette semaine', 'Plus longtemps'] },
      ], t: 'Où était-elle ? (facultatif)' },
    { id: 'colis', libelle: 'Colis abîmé ou incomplet', photo: 'oui', aide: 'Photographiez le colis, puis ce qui est abîmé ou ce qui reste dans le carton.',
      q: [
        { titre: 'Qu’est-ce qui ne va pas ?', choix: ['Le carton est abîmé', 'Il manque quelque chose', 'La tablette est abîmée'], multi: true },
      ], t: 'Que manque-t-il ? (facultatif)' },
    { id: 'panne', libelle: 'Panne, malgré les essais', photo: 'facultative', aide: 'Une photo de l’écran peut nous aider.',
      q: [
        { titre: 'Qu’est-ce qui ne marche pas ?', choix: ['Écran noir', 'Elle ne charge plus', 'Les appels', 'Les photos n’arrivent pas', 'Autre chose'] },
        { titre: 'Qu’avez-vous déjà essayé ?', choix: ['Redémarrer depuis l’appli', 'Un autre chargeur', 'Appui long sur le bouton d’allumage', 'Rien encore'], multi: true },
      ] },
    { id: 'donnees', libelle: 'Mes données personnelles', photo: 'non',
      q: [
        { titre: 'Vous souhaitez…', choix: ['Recevoir une copie de mes données', 'Corriger mes données', 'Effacer mes données', 'Autre chose'] },
      ] },
    { id: 'autre', libelle: 'Autre chose', photo: 'facultative', q: [], messageObligatoire: true },
  ];

  var css = '' +
    '.ps-decl{align-self:stretch;display:flex;flex-direction:column;gap:.7rem;background:var(--ps-carte);border:1px solid var(--ps-indigo);border-radius:14px;padding:.85rem}' +
    '.ps-decl h3{margin:0;font:700 1.05rem/1.3 "Bricolage Grotesque","Segoe UI",system-ui,sans-serif}' +
    '.ps-decl p{margin:0}' +
    '.ps-decl .ps-d-motifs{display:flex;flex-direction:column;gap:.4rem}' +
    '.ps-decl button{font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
    '.ps-decl .ps-d-motifs button,.ps-decl .ps-d-choix button{min-height:44px;text-align:left;border:1px solid var(--ps-ligne);background:var(--ps-fond);color:var(--ps-texte);border-radius:12px;padding:.55rem .8rem;font-size:1rem;overflow-wrap:anywhere}' +
    '.ps-decl .ps-d-motifs button:active,.ps-decl .ps-d-choix button:active{background:var(--ps-doux)}' +
    // Choix les uns sous les autres, tous de la même largeur (boutons de même taille, faciles à toucher).
    '.ps-decl .ps-d-choix{display:flex;flex-direction:column;gap:.4rem}' +
    '.ps-decl .ps-d-choix button[aria-pressed=true]{background:var(--ps-indigo);border-color:var(--ps-indigo);color:#fff;font-weight:700}' +
    '.ps-decl fieldset{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:.4rem;min-width:0}' +
    '.ps-decl legend{padding:0;margin-bottom:.35rem;font-weight:700;font-size:1rem}' +
    '.ps-decl .ps-d-conseil{background:var(--ps-doux);border-radius:10px;padding:.55rem .7rem;font-size:.95rem}' +
    '.ps-decl label.ps-d-champ{display:flex;flex-direction:column;gap:.25rem;font-size:.95rem;color:var(--ps-gris)}' +
    '.ps-decl textarea,.ps-decl input[type=text]{border:1px solid var(--ps-ligne);border-radius:10px;padding:.55rem .7rem;font:inherit;font-size:1.05rem;color:var(--ps-texte);background:var(--ps-fond);resize:vertical}' +
    '.ps-decl .ps-d-photos{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}' +
    '.ps-decl .ps-d-vignette{position:relative;width:76px;height:76px;border-radius:10px;overflow:hidden;background:var(--ps-ligne);flex:none}' +
    '.ps-decl .ps-d-vignette img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.ps-decl .ps-d-vignette button{position:absolute;top:2px;right:2px;width:32px;height:32px;border-radius:50%;border:0;background:rgba(36,33,47,.78);color:#fff;font-size:1.1rem;line-height:1;display:flex;align-items:center;justify-content:center}' +
    '.ps-decl .ps-d-vignette.ps-d-prepa{display:flex;align-items:center;justify-content:center;font-size:.8rem;color:var(--ps-gris)}' +
    '.ps-decl .ps-d-ajout,.ps-decl .ps-d-prendre{min-height:44px;border:1.5px dashed var(--ps-indigo);background:#fff;color:var(--ps-indigo-fonce);border-radius:12px;padding:.55rem .9rem;font-weight:700}' +
    '.ps-decl .ps-d-ajout:disabled,.ps-decl .ps-d-prendre:disabled{opacity:.5;cursor:default}' +
    '.ps-decl .ps-d-petit{font-size:.85rem;color:var(--ps-gris)}' +
    '.ps-decl .ps-d-lien{align-self:flex-start;border:0;background:none;color:var(--ps-indigo-fonce);text-decoration:underline;padding:.3rem 0;min-height:44px;font-size:.95rem}' +
    '.ps-decl .ps-d-envoyer{border:0;border-radius:12px;background:var(--ps-indigo);color:#fff;font-weight:700;padding:.8rem;min-height:48px;display:flex;align-items:center;justify-content:center;gap:.5rem}' +
    '.ps-decl .ps-d-envoyer.ps-envoi{opacity:.85;cursor:default}' +
    '.ps-decl .ps-d-envoyer.ps-envoi::before{content:"";width:1rem;height:1rem;border-radius:50%;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;animation:ps-tourne .8s linear infinite}' +
    '.ps-decl .ps-erreur:empty{display:none}';

  function el(tag, cls, texte) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (texte) n.textContent = texte;
    return n;
  }
  function bouton(cls, texte, faire) {
    var b = el('button', cls, texte);
    b.type = 'button';
    b.onclick = faire;
    return b;
  }

  function nouvelleCle() {
    var a = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  // Photo du téléphone → JPEG de 1600 px au plus, dans le bon sens (EXIF), en base64 + adresse pour la vignette.
  function ouvrirImage(fichier) {
    if (window.createImageBitmap) {
      return createImageBitmap(fichier, { imageOrientation: 'from-image' }).catch(function () { return parBalise(fichier); });
    }
    return parBalise(fichier);
  }
  function parBalise(fichier) {
    return new Promise(function (ok, ko) {
      var url = URL.createObjectURL(fichier);
      var img = new Image();
      img.onload = function () { ok(img); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); };
      img.onerror = function () { URL.revokeObjectURL(url); ko(new Error('illisible')); };
      img.src = url;
    });
  }
  function reduire(fichier) {
    return ouvrirImage(fichier).then(function (image) {
      var l = image.width, h = image.height;
      if (!l || !h) throw new Error('illisible');
      var k = Math.min(1, COTE_MAX / Math.max(l, h));
      var c = document.createElement('canvas');
      c.width = Math.round(l * k);
      c.height = Math.round(h * k);
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(image, 0, 0, c.width, c.height);
      if (image.close) image.close();
      return new Promise(function (ok, ko) {
        c.toBlob(function (blob) {
          if (!blob) return ko(new Error('illisible'));
          var r = new FileReader();
          r.onload = function () { ok({ base64: String(r.result).split(',')[1], url: URL.createObjectURL(blob), octets: blob.size }); };
          r.onerror = function () { ko(r.error); };
          r.readAsDataURL(blob);
        }, 'image/jpeg', 0.82);
      });
    });
  }

  var formulaire = null; // carte en cours : gardée si la bulle se ferme puis se rouvre
  var styleMis = false;

  // outils : { fil, historique() , ajouter(role, texte), sauver(), fermer() } fournis par chat-support.js.
  function proposer(outils) {
    if (!styleMis) {
      var s = el('style');
      s.textContent = css;
      document.head.appendChild(s);
      styleMis = true;
    }
    if (formulaire && !formulaire.fini) {
      outils.fil.appendChild(formulaire.carte);
      formulaire.outils = outils;
      outils.fil.scrollTop = outils.fil.scrollHeight;
      return;
    }
    formulaire = creer(outils);
    outils.fil.appendChild(formulaire.carte);
    outils.fil.scrollTop = outils.fil.scrollHeight;
  }

  function creer(outils) {
    var f = { outils: outils, carte: el('div', 'ps-decl'), cle: nouvelleCle(), motif: null, reponses: {}, photos: [], enPrepa: 0, envoi: false, fini: false };
    f.carte.setAttribute('role', 'group');
    f.carte.setAttribute('aria-label', 'Demande à l’équipe Papote');
    choisirMotif(f);
    return f;
  }

  function choisirMotif(f) {
    f.carte.textContent = '';
    f.carte.appendChild(el('h3', '', 'Que se passe-t-il ?'));
    f.carte.appendChild(el('p', 'ps-d-petit', 'Votre demande arrive à l’équipe avec l’état de la tablette : inutile de tout réexpliquer.'));
    var liste = el('div', 'ps-d-motifs');
    MOTIFS.forEach(function (m) {
      liste.appendChild(bouton('', m.libelle, function () {
        if (f.motif !== m.id) { f.motif = m.id; f.reponses = {}; }
        details(f);
      }));
    });
    f.carte.appendChild(liste);
  }

  function motifDe(f) {
    for (var i = 0; i < MOTIFS.length; i++) if (MOTIFS[i].id === f.motif) return MOTIFS[i];
    return null;
  }

  function details(f) {
    var m = motifDe(f);
    var carte = f.carte;
    carte.textContent = '';
    carte.appendChild(el('h3', '', m.libelle));
    carte.appendChild(bouton('ps-d-lien', 'Ce n’est pas ça ? Changer', function () { if (!f.envoi) choisirMotif(f); }));

    m.q.forEach(function (q, iq) {
      var groupe = el('fieldset');
      groupe.appendChild(el('legend', '', q.titre));
      var choix = el('div', 'ps-d-choix');
      var conseil = el('p', 'ps-d-conseil');
      conseil.hidden = true;
      var montrer = function () {
        var pris = f.reponses[iq] || [];
        Array.prototype.forEach.call(choix.children, function (b) { b.setAttribute('aria-pressed', String(pris.indexOf(b.textContent) !== -1)); });
        var texteConseil = q.conseil && pris.map(function (p) { return q.conseil[p]; }).filter(Boolean)[0];
        conseil.textContent = texteConseil || '';
        conseil.hidden = !texteConseil;
      };
      q.choix.forEach(function (c) {
        choix.appendChild(bouton('', c, function () {
          if (f.envoi) return;
          var pris = f.reponses[iq] || [];
          if (q.multi) {
            var i = pris.indexOf(c);
            f.reponses[iq] = i === -1 ? pris.concat([c]) : pris.filter(function (x) { return x !== c; });
          } else {
            f.reponses[iq] = [c];
          }
          montrer();
          f.erreur.textContent = '';
        }));
      });
      groupe.appendChild(choix);
      groupe.appendChild(conseil);
      carte.appendChild(groupe);
      montrer();
    });

    if (m.t) {
      var lt = el('label', 'ps-d-champ', m.t);
      f.champTexte = el('input');
      f.champTexte.type = 'text';
      f.champTexte.maxLength = 200;
      f.champTexte.value = f.texte || '';
      f.champTexte.oninput = function () { f.texte = f.champTexte.value; };
      lt.appendChild(f.champTexte);
      carte.appendChild(lt);
    } else {
      f.champTexte = null;
    }

    if (m.photo !== 'non') {
      var gp = el('fieldset');
      gp.appendChild(el('legend', '', m.photo === 'oui' ? 'Photos (au moins une, 3 au plus)' : 'Photos (facultatif, 3 au plus)'));
      if (m.aide) gp.appendChild(el('p', 'ps-d-petit', m.aide));
      f.zonePhotos = el('div', 'ps-d-photos');
      gp.appendChild(f.zonePhotos);
      carte.appendChild(gp);
      dessinerPhotos(f);
    } else {
      f.zonePhotos = null;
    }

    var lm = el('label', 'ps-d-champ', m.messageObligatoire ? 'Dites-nous en quelques mots' : 'Un mot de plus ? (facultatif)');
    f.champMessage = el('textarea');
    f.champMessage.rows = 3;
    f.champMessage.maxLength = 1500;
    f.champMessage.value = f.message || '';
    f.champMessage.oninput = function () { f.message = f.champMessage.value; f.erreur.textContent = ''; };
    lm.appendChild(f.champMessage);
    carte.appendChild(lm);

    f.erreur = el('div', 'ps-erreur');
    f.erreur.setAttribute('role', 'alert');
    carte.appendChild(f.erreur);
    f.boutonEnvoyer = bouton('ps-d-envoyer', 'Envoyer la demande', function () { envoyer(f); });
    carte.appendChild(f.boutonEnvoyer);
    carte.appendChild(el('p', 'ps-d-petit', 'Nous vous répondons sous 48 h, par e-mail.'));
    f.outils.fil.scrollTop = f.outils.fil.scrollHeight;
  }

  function dessinerPhotos(f) {
    var z = f.zonePhotos;
    if (!z) return;
    z.textContent = '';
    f.photos.forEach(function (p, i) {
      var v = el('div', 'ps-d-vignette');
      var img = el('img');
      img.src = p.url;
      img.alt = 'Photo ' + (i + 1);
      v.appendChild(img);
      var x = bouton('', '×', function () {
        if (f.envoi) return;
        URL.revokeObjectURL(p.url);
        f.photos.splice(f.photos.indexOf(p), 1);
        dessinerPhotos(f);
      });
      x.setAttribute('aria-label', 'Retirer la photo ' + (i + 1));
      v.appendChild(x);
      z.appendChild(v);
    });
    for (var k = 0; k < f.enPrepa; k++) z.appendChild(el('div', 'ps-d-vignette ps-d-prepa', 'Préparation…'));
    var place = MAX_PHOTOS - f.photos.length - f.enPrepa;
    if (place > 0) {
      // Deux boutons, comme dans l'appli (Tanguy, 27/11) : sur Android, un seul champ n'ouvrait que la galerie.
      var prendre = bouton('ps-d-prendre', '📷 Prendre une photo', function () { prendrePhotos(f, true); });
      var ajout = bouton('ps-d-ajout', '🖼️ Choisir dans la galerie', function () { prendrePhotos(f, false); });
      prendre.disabled = ajout.disabled = f.envoi;
      z.appendChild(prendre);
      z.appendChild(ajout);
    }
  }

  // « capture » ouvre l'appareil photo (une photo à la fois) ; sans, la galerie (plusieurs d'un coup).
  function prendrePhotos(f, appareil) {
    if (f.envoi) return;
    var champ = el('input');
    champ.type = 'file';
    champ.accept = 'image/*';
    if (appareil) champ.setAttribute('capture', 'environment');
    else champ.multiple = true;
    champ.style.display = 'none';
    champ.onchange = function () {
      var fichiers = Array.prototype.slice.call(champ.files || [], 0, MAX_PHOTOS - f.photos.length - f.enPrepa);
      champ.remove();
      if (!fichiers.length) return;
      f.erreur.textContent = '';
      f.enPrepa += fichiers.length;
      dessinerPhotos(f);
      fichiers.forEach(function (fichier) {
        // Les photos gardent l'ordre du choix, même si une petite est prête avant une grande.
        var rang = f.rang = (f.rang || 0) + 1;
        reduire(fichier).then(function (p) {
          p.rang = rang;
          f.photos.push(p);
          f.photos.sort(function (x, y) { return x.rang - y.rang; });
        }, function () {
          f.erreur.textContent = 'Une photo ne s’ouvre pas. Choisissez-en une autre.';
        }).then(function () {
          f.enPrepa--;
          dessinerPhotos(f);
        });
      });
    };
    document.body.appendChild(champ);
    champ.click();
  }

  function manque(f) {
    var m = motifDe(f);
    for (var i = 0; i < m.q.length; i++) {
      if (!(f.reponses[i] || []).length) return 'Répondez à « ' + m.q[i].titre + ' ».';
    }
    if (m.messageObligatoire && !(f.message || '').trim()) return 'Dites-nous en quelques mots ce qui se passe.';
    if (f.enPrepa) return 'Une photo est en préparation, un instant…';
    if (m.photo === 'oui' && !f.photos.length) return 'Ajoutez au moins une photo, elle nous aide à vous répondre vite.';
    return null;
  }

  function envoyer(f) {
    if (f.envoi || f.fini) return; // double appui : un seul envoi
    var probleme = manque(f);
    if (probleme) { f.erreur.textContent = probleme; return; }
    var m = motifDe(f);
    f.envoi = true;
    f.erreur.textContent = '';
    f.boutonEnvoyer.classList.add('ps-envoi');
    f.boutonEnvoyer.setAttribute('aria-disabled', 'true');
    f.boutonEnvoyer.textContent = 'Envoi…';
    dessinerPhotos(f);
    var reponses = m.q.map(function (q, i) { return { question: q.titre, reponse: (f.reponses[i] || []).join(', ') }; });
    if (m.t && (f.texte || '').trim()) reponses.push({ question: m.t.replace(/ \(facultatif\)$/, ''), reponse: f.texte.trim() });
    var corps = {
      famille: window.papoteFamille ? window.papoteFamille() : null,
      cle: f.cle,
      motif: m.id,
      reponses: reponses,
      message: (f.message || '').trim(),
      photos: f.photos.map(function (p) { return p.base64; }),
      conversation: f.outils.historique().slice(-12),
    };
    var minuterie = null;
    var controle = window.AbortController ? new AbortController() : null;
    Promise.resolve(window.papoteJeton ? window.papoteJeton() : null)
      .then(function (jeton) {
        if (!jeton) return Promise.reject({ erreur: 'Reconnectez-vous à l’appli, puis recommencez.' });
        if (controle) minuterie = setTimeout(function () { controle.abort(); }, 45000);
        return fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jeton },
          body: JSON.stringify(corps),
          signal: controle ? controle.signal : undefined,
        });
      })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) { return r.ok && d.ok ? d : Promise.reject(d); });
      })
      .then(function () {
        clearTimeout(minuterie);
        reussi(f, m);
      }, function (d) {
        clearTimeout(minuterie);
        f.envoi = false;
        f.boutonEnvoyer.classList.remove('ps-envoi');
        f.boutonEnvoyer.removeAttribute('aria-disabled');
        f.boutonEnvoyer.textContent = 'Réessayer';
        f.erreur.textContent = (d && d.erreur) || ('Envoi impossible : vérifiez la connexion internet, puis touchez « Réessayer ». Vous pouvez aussi nous écrire à ' + EMAIL + '.');
        dessinerPhotos(f);
      });
  }

  function reussi(f, m) {
    f.fini = true;
    f.carte.remove();
    f.photos.forEach(function (p) { URL.revokeObjectURL(p.url); });
    var o = f.outils;
    var merci = 'C’est envoyé ! Votre demande « ' + m.libelle + ' » est bien arrivée' +
      (f.photos.length ? (f.photos.length > 1 ? ', avec vos ' + f.photos.length + ' photos' : ', avec votre photo') : '') +
      '. Nous vous répondons sous 48 h, par e-mail.';
    var h = o.historique();
    // Repère lu par le serveur (support.js, etatMain) : « (Déclaration … envoyée) », sans parenthèse à l'intérieur.
    h.push({ role: 'user', content: '(Déclaration « ' + m.libelle.replace(/\s*\([^)]*\)/g, '') + ' » envoyée)' });
    h.push({ role: 'assistant', content: merci });
    o.sauver();
    o.ajouter('assistant', merci);
    var fin = bouton('ps-fin', 'Fermer le chat', function () { o.fermer(true); });
    o.fil.appendChild(fin);
    o.fil.scrollTop = o.fil.scrollHeight;
    fin.focus();
  }

  window.PapoteDeclaration = { proposer: proposer, _motifs: MOTIFS };
})();
