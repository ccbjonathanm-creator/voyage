/* ============================================================
   Garde-fou d'affichage — fichier commun à toutes les applis Génération App.
   Identique d'une appli à l'autre : ne pas le personnaliser, il se règle tout seul.

   POURQUOI CE FICHIER EXISTE. Un client a vu l'appli s'afficher en vrac : touches du
   clavier décalées, barre du bas au milieu du contenu, éléments normalement masqués
   devenus visibles. Cause : la feuille de style n'était pas appliquée, alors que la page
   et le reste du code se chargeaient normalement. Le navigateur ne signale rien dans ce
   cas précis, il affiche simplement une page sans mise en page.

   COMMENT ON LE DÉTECTE. Quand une feuille arrive mais n'est pas du CSS (par exemple du
   HTML servi par erreur à sa place), le navigateur déclenche quand même « load » et
   laisse un objet feuille en place : seul son nombre de règles vaut zéro. C'est donc ce
   nombre qui est vérifié, et non la présence de l'objet.

   CE QU'IL FAIT ENSUITE. Il recharge la feuille sous une URL unique, ce qui contourne
   aussi bien le cache du navigateur qu'un service worker servant une réponse erronée.
   En dernier recours il affiche un message lisible plutôt qu'une interface cassée.

   À placer dans le <head>, après les <link> : à ce moment le navigateur a fini de les
   résoudre, l'état lu est donc définitif. Aucun fichier CSS n'a besoin d'être modifié.
   ============================================================ */
(function () {
  'use strict';

  var MAX_TENTATIVES = 2;

  function cassee(lien) {
    try {
      var f = lien.sheet;
      // Pas de feuille du tout, ou une feuille sans la moindre règle : le contenu
      // reçu n'était pas du CSS exploitable.
      if (!f) return true;
      return f.cssRules.length === 0;
    } catch (e) {
      // Feuille illisible (autre origine) : on ne touche à rien. Un faux positif
      // serait pire que le défaut qu'on cherche à corriger.
      return false;
    }
  }

  function urlDeSecours(lien, tentative) {
    var href = lien.href;
    return href + (href.indexOf('?') === -1 ? '?' : '&') + 'secours=' + Date.now() + '-' + tentative;
  }

  function recharge(lien, tentative, ensuite) {
    var neuf = document.createElement('link');
    neuf.rel = 'stylesheet';
    // Marqué pour que le second passage ne reprenne pas les liens de secours déjà
    // posés : sans ça, chaque contrôle relançait une réparation sur les précédents.
    neuf.setAttribute('data-garde-secours', '1');
    neuf.href = urlDeSecours(lien, tentative);
    neuf.onload = function () { setTimeout(function () { ensuite(neuf); }, 0); };
    neuf.onerror = function () { setTimeout(function () { ensuite(neuf); }, 0); };
    (document.head || document.documentElement).appendChild(neuf);
  }

  function repare(lien, critique, tentative) {
    if (!cassee(lien)) {
      // Réparation aboutie : on retire le message de secours s'il avait été affiché.
      var msg = document.getElementById('garde-style-msg');
      if (msg && msg.parentNode) msg.parentNode.removeChild(msg);
      return;
    }
    if (tentative > MAX_TENTATIVES) {
      if (critique) prevenir();
      return;
    }
    recharge(lien, tentative, function (neuf) { repare(neuf, critique, tentative + 1); });
  }

  function prevenir() {
    function afficher() {
      if (!document.body || document.getElementById('garde-style-msg')) return;
      var boite = document.createElement('div');
      boite.id = 'garde-style-msg';
      boite.setAttribute('style', [
        // top/right/bottom/left plutôt que inset : c'est un écran de secours,
        // il doit s'afficher même sur un navigateur ancien.
        'position:fixed', 'top:0', 'right:0', 'bottom:0', 'left:0', 'z-index:2147483647',
        'display:flex', 'align-items:center', 'justify-content:center',
        'padding:24px', 'background:#0b0f1a', 'color:#eef2ff',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        'text-align:center', 'line-height:1.5',
      ].join(';'));
      boite.innerHTML =
        '<div style="max-width:340px">' +
        '<div style="font-size:19px;font-weight:700;margin-bottom:12px">Affichage incomplet</div>' +
        '<div style="font-size:15px;color:#93a0c2;margin-bottom:22px">' +
        'Un fichier d’affichage n’a pas pu être chargé, l’application ne peut pas ' +
        's’afficher correctement. Vérifie ta connexion, puis réessaie.' +
        '</div>' +
        '<button type="button" id="garde-style-retry" style="' +
        'padding:13px 26px;font-size:15px;font-weight:600;border:0;border-radius:12px;' +
        'background:#6d7cff;color:#fff">Réessayer</button>' +
        '</div>';
      document.body.appendChild(boite);
      var bouton = document.getElementById('garde-style-retry');
      if (bouton) {
        bouton.addEventListener('click', function () {
          location.replace(location.pathname + '?r=' + Date.now());
        });
      }
    }
    if (document.body) afficher();
    else document.addEventListener('DOMContentLoaded', afficher);
  }

  function controler() {
    var liens = document.querySelectorAll('link[rel="stylesheet"]:not([data-garde-secours])');
    for (var i = 0; i < liens.length; i++) {
      // La première feuille porte la structure de la page : si elle manque, l'appli
      // est inutilisable. Les suivantes ne sont que des couches visuelles.
      repare(liens[i], i === 0, 1);
    }
  }

  controler();
  // Second passage une fois le DOM prêt, au cas où une feuille arriverait en retard.
  document.addEventListener('DOMContentLoaded', controler);
})();
