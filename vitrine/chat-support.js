// Chat de support Papote : bouton « Une question ? » en bas de page qui ouvre une petite
// conversation avec l'assistant (fonction supportChat). Fichier autonome, à inclure par
//   <script src="https://mapapote.fr/chat-support.js" defer></script>
// sur le site vitrine comme dans l'appli famille. Attributs facultatifs sur la balise :
//   data-cote="gauche"   bouton à gauche (par défaut à droite)
//   data-bas="96"        distance au bas de l'écran en pixels (par défaut 20)
(function () {
  if (window.__papoteSupport) return;
  window.__papoteSupport = true;

  var API = 'https://europe-west1-papote-famille.cloudfunctions.net/supportChat';
  var EMAIL = 'contact@mapapote.fr';
  var CLE = 'papote-support';
  var script = document.currentScript || {};
  var cote = script.dataset && script.dataset.cote === 'gauche' ? 'left' : 'right';
  var bas = (script.dataset && parseInt(script.dataset.bas, 10)) || 20;
  // Dans l'appli famille, la personne est déjà cliente : l'assistant la guide dans l'appli.
  var PAGE = ['papote-famille.web.app', 'app.mapapote.fr'].indexOf(location.hostname) !== -1 ? 'appli' : 'site';
  var SUGGESTIONS = ['Combien ça coûte ?', 'Faut-il une box internet ?', 'Comment se passe l’installation ?'];

  var css = '' +
    '.ps-bouton,.ps-panneau{--ps-fond:#fdfaf5;--ps-carte:#fff;--ps-texte:#24212f;--ps-gris:#5f5a6b;--ps-ligne:#e9e1d4;--ps-indigo:#4f46e5;--ps-indigo-fonce:#3730a3;--ps-doux:#e8e6fd;' +
    'font-family:"Atkinson Hyperlegible","Segoe UI",system-ui,sans-serif;position:fixed;z-index:2147483000;' + cote + ':20px;bottom:' + bas + 'px}' +
    '.ps-bouton{display:flex;align-items:center;gap:.5rem;border:0;border-radius:999px;background:var(--ps-indigo);color:#fff;font-family:inherit;font-weight:700;font-size:1.05rem;line-height:1;padding:.9rem 1.2rem;box-shadow:0 6px 20px rgba(36,33,47,.25);cursor:pointer}' +
    '.ps-bouton:hover{background:var(--ps-indigo-fonce)}' +
    '.ps-bouton:focus-visible,.ps-panneau button:focus-visible,.ps-panneau textarea:focus-visible{outline:3px solid #4338ca;outline-offset:2px}' +
    '.ps-panneau{width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - ' + (bas + 40) + 'px));display:none;flex-direction:column;background:var(--ps-fond);color:var(--ps-texte);border:1px solid var(--ps-ligne);border-radius:18px;box-shadow:0 12px 40px rgba(36,33,47,.28);overflow:hidden}' +
    '.ps-panneau.ps-ouvert{display:flex}' +
    '.ps-tete{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.9rem 1rem;background:var(--ps-carte);border-bottom:1px solid var(--ps-ligne)}' +
    '.ps-tete strong{font:700 1.15rem/1.2 "Bricolage Grotesque","Segoe UI",system-ui,sans-serif}' +
    '.ps-tete button{border:0;background:none;color:var(--ps-gris);font-size:1.6rem;line-height:1;cursor:pointer;padding:.2rem .5rem;border-radius:8px}' +
    '.ps-fil{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.6rem}' +
    '.ps-msg{max-width:85%;padding:.7rem .9rem;border-radius:14px;font-size:1.05rem;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}' +
    '.ps-msg a{color:inherit}' +
    '.ps-ia{align-self:flex-start;background:var(--ps-carte);border:1px solid var(--ps-ligne)}' +
    '.ps-moi{align-self:flex-end;background:var(--ps-indigo);color:#fff}' +
    '.ps-attente{color:var(--ps-gris);font-style:italic}' +
    '.ps-idees{display:flex;flex-wrap:wrap;gap:.4rem}' +
    '.ps-idees button{border:1px solid var(--ps-indigo);background:var(--ps-doux);color:var(--ps-indigo-fonce);border-radius:999px;padding:.45rem .8rem;font:inherit;font-size:.95rem;cursor:pointer}' +
    '.ps-saisie{display:flex;gap:.5rem;padding:.75rem;background:var(--ps-carte);border-top:1px solid var(--ps-ligne)}' +
    '.ps-saisie textarea{flex:1;resize:none;border:1px solid var(--ps-ligne);border-radius:12px;padding:.6rem .7rem;font:inherit;font-size:1.05rem;color:var(--ps-texte);background:var(--ps-fond);max-height:7rem}' +
    '.ps-saisie button{border:0;border-radius:12px;background:var(--ps-indigo);color:#fff;font:inherit;font-weight:700;padding:0 1rem;cursor:pointer}' +
    '.ps-saisie button:disabled{opacity:.5;cursor:default}' +
    '.ps-rappel{align-self:stretch;display:flex;flex-direction:column;gap:.5rem;background:var(--ps-carte);border:1px solid var(--ps-indigo);border-radius:14px;padding:.8rem}' +
    '.ps-rappel label{font-size:.95rem;color:var(--ps-gris);display:flex;flex-direction:column;gap:.25rem}' +
    '.ps-rappel input{border:1px solid var(--ps-ligne);border-radius:10px;padding:.55rem .7rem;font:inherit;font-size:1.05rem;color:var(--ps-texte);background:var(--ps-fond)}' +
    '.ps-rappel button{border:0;border-radius:12px;background:var(--ps-indigo);color:#fff;font:inherit;font-weight:700;padding:.7rem;cursor:pointer}' +
    '.ps-rappel button:disabled{opacity:.5;cursor:default}' +
    '.ps-erreur{color:#b91c1c;font-size:.95rem}' +
    '.ps-note{font-size:.8rem;color:var(--ps-gris);text-align:center;padding:0 .75rem .6rem;background:var(--ps-carte)}';

  var historique = [];
  try { historique = JSON.parse(sessionStorage.getItem(CLE)) || []; } catch (e) { historique = []; }

  function el(tag, cls, texte) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (texte) n.textContent = texte;
    return n;
  }

  function demarrer() {
    var style = el('style');
    style.textContent = css;
    document.head.appendChild(style);

    var bouton = el('button', 'ps-bouton');
    bouton.type = 'button';
    bouton.setAttribute('aria-expanded', 'false');
    bouton.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg><span>Une question ?</span>';

    var panneau = el('div', 'ps-panneau');
    panneau.setAttribute('role', 'dialog');
    panneau.setAttribute('aria-label', 'Assistance Papote');
    var tete = el('div', 'ps-tete');
    tete.appendChild(el('strong', '', 'Assistance Papote'));
    var fermer = el('button', '', '×');
    fermer.type = 'button';
    fermer.setAttribute('aria-label', 'Fermer');
    tete.appendChild(fermer);
    var fil = el('div', 'ps-fil');
    fil.setAttribute('aria-live', 'polite');
    var saisie = el('form', 'ps-saisie');
    var zone = el('textarea');
    zone.rows = 1;
    zone.maxLength = 1000;
    zone.placeholder = 'Écrivez votre question';
    zone.setAttribute('aria-label', 'Votre question');
    var envoyer = el('button', '', 'Envoyer');
    envoyer.type = 'submit';
    saisie.appendChild(zone);
    saisie.appendChild(envoyer);
    var note = el('div', 'ps-note', 'Réponses données par une IA. Pour une commande : ' + EMAIL);
    panneau.appendChild(tete);
    panneau.appendChild(fil);
    panneau.appendChild(saisie);
    panneau.appendChild(note);
    document.body.appendChild(bouton);
    document.body.appendChild(panneau);

    function ajouter(role, texte, cls) {
      var bulle = el('div', 'ps-msg ' + (role === 'user' ? 'ps-moi' : 'ps-ia') + (cls ? ' ' + cls : ''));
      // Texte brut, puis l'e-mail de support rendu cliquable.
      texte.split(EMAIL).forEach(function (morceau, i) {
        if (i) {
          var a = el('a', '', EMAIL);
          a.href = 'mailto:' + EMAIL;
          bulle.appendChild(a);
        }
        bulle.appendChild(document.createTextNode(morceau));
      });
      fil.appendChild(bulle);
      fil.scrollTop = fil.scrollHeight;
      return bulle;
    }

    // Formulaire « être recontacté », proposé seulement quand l'assistant n'a pas pu répondre.
    function proposerRappel() {
      var form = el('form', 'ps-rappel');
      form.noValidate = true;
      var lNom = el('label', '', 'Votre prénom');
      var nom = el('input');
      nom.autocomplete = 'given-name';
      nom.maxLength = 60;
      lNom.appendChild(nom);
      var lTel = el('label', '', 'Votre téléphone');
      var tel = el('input');
      tel.type = 'tel';
      tel.autocomplete = 'tel';
      tel.maxLength = 30;
      tel.required = true;
      lTel.appendChild(tel);
      var lMel = el('label', '', 'Votre e-mail');
      var mel = el('input');
      mel.type = 'email';
      mel.autocomplete = 'email';
      mel.maxLength = 120;
      mel.required = true;
      lMel.appendChild(mel);
      var erreur = el('div', 'ps-erreur');
      var go = el('button', '', 'Être recontacté');
      go.type = 'submit';
      form.appendChild(lNom);
      form.appendChild(lTel);
      form.appendChild(lMel);
      form.appendChild(erreur);
      form.appendChild(go);
      form.onsubmit = function (e) {
        e.preventDefault();
        var t = tel.value.trim();
        var m = mel.value.trim();
        if (t.replace(/\D/g, '').length < 9) {
          erreur.textContent = 'Indiquez votre numéro de téléphone.';
          tel.focus();
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) {
          erreur.textContent = 'Indiquez votre adresse e-mail.';
          mel.focus();
          return;
        }
        erreur.textContent = '';
        go.disabled = true;
        var conversation = historique.slice(-12);
        while (conversation.length && conversation[conversation.length - 1].role !== 'user') conversation.pop();
        fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: conversation, contact: { nom: nom.value, telephone: t, email: m } }),
        })
          .then(function (r) { return r.json().then(function (d) { return r.ok && d.ok ? d : Promise.reject(d); }); })
          .then(function () {
            form.remove();
            var merci = 'Merci ! Votre demande est bien arrivée, quelqu\u2019un de l\u2019équipe va vous recontacter.';
            historique.push({ role: 'user', content: '(Demande de rappel envoyée)' });
            historique.push({ role: 'assistant', content: merci });
            sauver();
            ajouter('assistant', merci);
          })
          .catch(function (d) {
            go.disabled = false;
            erreur.textContent = (d && d.erreur) || ('Envoi impossible. Écrivez-nous à ' + EMAIL + '.');
          });
      };
      fil.appendChild(form);
      fil.scrollTop = fil.scrollHeight;
      nom.focus();
    }

    function sauver() {
      try { sessionStorage.setItem(CLE, JSON.stringify(historique.slice(-20))); } catch (e) { /* navigation privée */ }
    }

    function afficher() {
      fil.textContent = '';
      ajouter('assistant', 'Bonjour ! Je réponds à vos questions sur Papote : la tablette, les tarifs, l’installation ou l’appli famille.');
      if (!historique.length) {
        var idees = el('div', 'ps-idees');
        SUGGESTIONS.forEach(function (q) {
          var b = el('button', '', q);
          b.type = 'button';
          b.onclick = function () { poser(q); };
          idees.appendChild(b);
        });
        fil.appendChild(idees);
      }
      historique.forEach(function (m) { ajouter(m.role, m.content); });
    }

    function ouvrir(oui) {
      panneau.classList.toggle('ps-ouvert', oui);
      bouton.style.display = oui ? 'none' : '';
      bouton.setAttribute('aria-expanded', String(oui));
      if (oui) { afficher(); zone.focus(); } else { bouton.focus(); }
    }

    function poser(question) {
      question = question.trim();
      if (!question || envoyer.disabled) return;
      var idees = fil.querySelector('.ps-idees');
      if (idees) idees.remove();
      var rappel = fil.querySelector('.ps-rappel');
      if (rappel) rappel.remove();
      historique.push({ role: 'user', content: question });
      ajouter('user', question);
      zone.value = '';
      envoyer.disabled = true;
      var attente = ajouter('assistant', 'Je cherche…', 'ps-attente');
      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: historique.slice(-12), page: PAGE }),
      })
        .then(function (r) { return r.json(); })
        .catch(function () { return {}; })
        .then(function (d) {
          attente.remove();
          var reponse = d.reponse || ('Je suis indisponible pour le moment. Écrivez-nous à ' + EMAIL + '.');
          historique.push({ role: 'assistant', content: reponse });
          ajouter('assistant', reponse);
          sauver();
          envoyer.disabled = false;
          if (d.contact) proposerRappel(); else zone.focus();
        });
    }

    bouton.onclick = function () { ouvrir(true); };
    fermer.onclick = function () { ouvrir(false); };
    panneau.addEventListener('keydown', function (e) { if (e.key === 'Escape') ouvrir(false); });
    saisie.onsubmit = function (e) { e.preventDefault(); poser(zone.value); };
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); poser(zone.value); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer);
  else demarrer();
})();
