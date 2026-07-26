/*
 * mesure.js — comptage d'usage des applications, sans cookie et sans code distant.
 *
 * POURQUOI CETTE BRIQUE EXISTE
 * Le script de mesure officiel d'Umami se charge depuis leur serveur. Toutes
 * les applications de Generation App interdisent le code distant
 * (`script-src 'self'` dans leur CSP), et c'est un principe de securite qu'on
 * ne casse pas pour du confort de statistiques. Ce fichier envoie donc les
 * evenements par une simple requete POST vers l'API d'Umami. Seul
 * `connect-src` doit etre elargi, pas `script-src`.
 *
 * CE QU'IL COMPTE
 *   app_ouverte   : une fois par session, avec le mode (installee / navigateur)
 *   app_installee : quand la personne installe vraiment l'application
 *
 * CE QU'IL N'ENVOIE JAMAIS
 * Aucune donnee saisie dans l'application, aucun identifiant persistant, aucun
 * cookie, aucune ecriture sur l'appareil. Le "Ne pas me pister" du navigateur
 * est respecte. Si la requete echoue, l'application n'en sait rien.
 *
 * INSTALLATION DANS UNE APPLICATION
 *   1. copier ce fichier a cote de index.html
 *   2. <script src="mesure.js" data-app="coffre" defer></script>
 *   3. ajouter le domaine de mesure au connect-src de la CSP
 *   4. ajouter "mesure.js" a la liste du cache du service worker
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Configuration. L'identifiant est le meme que celui du site : Umami
  // enregistre le nom de domaine, on filtre ensuite application par
  // application. C'est ce qui permet de rester dans l'offre gratuite.
  // ---------------------------------------------------------------------
  var WEBSITE_ID = '9573ab0b-be13-4474-aeaa-a593b564f70f';
  var ENDPOINT = 'https://cloud.umami.is/api/send';

  // Le temoin est reconstruit morceau par morceau EXPRES : si on remplacait
  // ici le mot en clair, un chercher-remplacer de l'identifiant modifierait
  // aussi cette ligne et le garde-fou se declencherait pour toujours, sans
  // le moindre message. Piege rencontre pour de vrai le 2026-07-26.
  var TEMOIN = ['A', 'REMPLIR'].join('_');
  if (!WEBSITE_ID || WEBSITE_ID === TEMOIN) return;

  // Respect du reglage "Ne pas me pister" du navigateur.
  try {
    var dnt = navigator.doNotTrack || window.doNotTrack;
    if (dnt === '1' || dnt === 'yes') return;
  } catch (e) {
    /* certains navigateurs n'exposent pas la propriete */
  }

  // Nom de l'application : lu sur la balise script, sinon deduit du domaine.
  function nomApp() {
    try {
      var s = document.currentScript || document.querySelector('script[data-app]');
      if (s && s.getAttribute('data-app')) return s.getAttribute('data-app');
    } catch (e) {}
    var h = location.hostname.split('.')[0];
    return h || 'inconnue';
  }
  var APP = nomApp();

  // Installee sur l'ecran d'accueil, ou simplement ouverte dans le navigateur ?
  function mode() {
    try {
      if (window.matchMedia('(display-mode: standalone)').matches) return 'installee';
      if (navigator.standalone === true) return 'installee';
    } catch (e) {}
    return 'navigateur';
  }

  function envoyer(nom, details) {
    var corps = {
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: location.hostname,
        url: location.pathname,
        name: nom,
        data: details || {},
      },
    };
    try {
      corps.payload.language = navigator.language;
      corps.payload.screen = screen.width + 'x' + screen.height;
      if (document.referrer) corps.payload.referrer = document.referrer;
    } catch (e) {}

    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corps),
        keepalive: true,
        // Aucun cookie n'est envoye ni accepte.
        credentials: 'omit',
        mode: 'cors',
      }).catch(function () {
        /* hors ligne ou bloque : on abandonne en silence */
      });
    } catch (e) {
      /* la mesure ne doit jamais casser l'application */
    }
  }

  // Une seule ouverture comptee par session de navigation, pour ne pas
  // gonfler le quota quand la personne navigue entre les ecrans.
  try {
    if (!sessionStorage.getItem('mesure_ouverture')) {
      sessionStorage.setItem('mesure_ouverture', '1');
      envoyer('app_ouverte', { app: APP, mode: mode() });
    }
  } catch (e) {
    envoyer('app_ouverte', { app: APP, mode: mode() });
  }

  // Installation reelle sur l'appareil. C'est LE chiffre qui repond a la
  // question "combien de personnes ont telecharge l'application".
  window.addEventListener('appinstalled', function () {
    envoyer('app_installee', { app: APP });
  });

  // Rend l'envoi disponible aux applications qui veulent compter un moment
  // precis (essai demarre, licence activee...). Usage : window.mesure('nom').
  window.mesure = function (nom, details) {
    envoyer(nom, Object.assign({ app: APP }, details || {}));
  };
})();
