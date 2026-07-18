/*
 * install-pwa.js — Aide a l'installation d'une PWA, reutilisable sur toutes les apps.
 *
 * Ce que ca fait :
 *  - Android/Chrome (et desktop) : vrai bouton "Installer" (evenement beforeinstallprompt).
 *  - iPhone dans Safari : petit tuto "Partager -> Sur l'ecran d'accueil".
 *  - iPhone dans TikTok/Instagram/Facebook (mini-navigateur) : message "Ouvre dans Safari".
 *  - iPhone dans Chrome/Firefox iOS : message "Ouvre dans Safari" (seul Safari peut installer).
 *  - Deja installe : n'affiche rien.
 *
 * Integration (1 ligne avant </body>) :
 *   <script src="install-pwa.js" data-app-name="Resolv" data-accent="#00e5ff"></script>
 *
 * Apercu sur PC (sans telephone), force un etat :
 *   ?pwa_install_debug=ios-safari | ios-inapp | ios-otherbrowser | android-installable | android-inapp
 *
 * Aucune dependance. Ne charge aucun code distant.
 */
(function (root) {
  'use strict';

  // --------- Detection pure (testable hors navigateur) ---------
  // ua   : navigator.userAgent
  // opts : { standalone:boolean, maxTouchPoints:number, hasBeforeInstall:boolean }
  function detectPlatform(ua, opts) {
    ua = ua || '';
    opts = opts || {};

    if (opts.standalone) return 'installed';

    // Mini-navigateurs integres (webview d'apps) : l'install y est impossible.
    var inApp = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Line\/|Twitter|TikTok|musical_ly|Bytedance|Snapchat|Pinterest|LinkedInApp|WhatsApp|Messenger|GSA\/|DuckDuckGo/i;

    var isIOS = /iPad|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && (opts.maxTouchPoints || 0) > 1); // iPadOS 13+ se fait passer pour Mac

    if (isIOS) {
      if (inApp.test(ua)) return 'ios-inapp';
      // Chrome/Firefox/Edge/Opera sur iOS : ne peuvent PAS ajouter a l'ecran d'accueil.
      if (/CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(ua)) return 'ios-otherbrowser';
      // Vrai Safari iOS.
      if (/Safari/.test(ua) && /Version\//.test(ua)) return 'ios-safari';
      // iOS mais navigateur non identifie : quasi surement un webview -> guider vers Safari.
      return 'ios-inapp';
    }

    if (/Android/.test(ua)) {
      if (opts.hasBeforeInstall) return 'android-installable';
      if (inApp.test(ua)) return 'android-inapp';
      return 'android-generic';
    }

    if (opts.hasBeforeInstall) return 'desktop-installable';
    return 'desktop';
  }

  // Export pour les tests Node.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { detectPlatform: detectPlatform };
  }

  // --------- A partir d'ici : uniquement dans le navigateur ---------
  if (typeof document === 'undefined') return;

  var thisScript = document.currentScript;

  function opt(name, fallback) {
    if (thisScript && thisScript.dataset && thisScript.dataset[name] != null) return thisScript.dataset[name];
    if (root.PWA_INSTALL_CONFIG && root.PWA_INSTALL_CONFIG[name] != null) return root.PWA_INSTALL_CONFIG[name];
    return fallback;
  }

  var CFG = {
    appName: opt('appName', document.title || 'cette application'),
    accent: opt('accent', '#4f7cff'),
    // Nombre de jours avant de reproposer si l'utilisateur ferme le bandeau.
    remindDays: parseInt(opt('remindDays', '7'), 10)
  };

  var DISMISS_KEY = 'pwa_install_dismissed_until_v1';
  var deferredPrompt = null;

  function isStandalone() {
    return (root.matchMedia && root.matchMedia('(display-mode: standalone)').matches) ||
      root.navigator.standalone === true;
  }

  function dismissedRecently() {
    try {
      var until = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
      return Date.now() < until;
    } catch (e) { return false; }
  }

  function rememberDismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + CFG.remindDays * 864e5));
    } catch (e) { /* localStorage indispo : tant pis */ }
  }

  function debugState() {
    var m = /[?&]pwa_install_debug=([\w-]+)/.exec(root.location.search);
    return m ? m[1] : null;
  }

  // --------- Rendu ---------
  var PREFIX = 'pwaic';
  var mounted = false;

  function injectStyles() {
    if (document.getElementById(PREFIX + '-style')) return;
    var css =
      '.' + PREFIX + '-wrap{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom));z-index:2147483000;width:calc(100% - 24px);max-width:430px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;animation:' + PREFIX + '-in .35s ease}' +
      '@keyframes ' + PREFIX + '-in{from{opacity:0;transform:translate(-50%,16px)}to{opacity:1;transform:translate(-50%,0)}}' +
      '.' + PREFIX + '-card{position:relative;background:#151821;color:#f2f4f8;border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:16px 16px 14px;box-shadow:0 18px 50px rgba(0,0,0,.45)}' +
      '.' + PREFIX + '-top{display:flex;align-items:center;gap:12px}' +
      '.' + PREFIX + '-ico{flex:0 0 auto;width:44px;height:44px;border-radius:12px;background:var(--pwaic-accent);display:flex;align-items:center;justify-content:center}' +
      '.' + PREFIX + '-ico svg{width:24px;height:24px;display:block}' +
      '.' + PREFIX + '-ttl{font-size:15px;font-weight:700;line-height:1.25;margin:0}' +
      '.' + PREFIX + '-sub{font-size:13px;line-height:1.4;margin:3px 0 0;color:#c3c8d4}' +
      '.' + PREFIX + '-close{position:absolute;top:8px;right:8px;width:30px;height:30px;border:0;background:transparent;color:#8b93a5;font-size:20px;line-height:1;cursor:pointer;border-radius:8px}' +
      '.' + PREFIX + '-close:hover{background:rgba(255,255,255,.08);color:#fff}' +
      '.' + PREFIX + '-btn{display:block;width:100%;margin-top:12px;padding:12px 14px;border:0;border-radius:12px;background:var(--pwaic-accent);color:#fff;font-size:15px;font-weight:700;cursor:pointer}' +
      '.' + PREFIX + '-btn:active{filter:brightness(.92)}' +
      '.' + PREFIX + '-steps{margin:12px 0 0;padding:0;list-style:none;font-size:13.5px;color:#dfe3ec}' +
      '.' + PREFIX + '-steps li{display:flex;align-items:center;gap:8px;padding:5px 0}' +
      '.' + PREFIX + '-num{flex:0 0 auto;width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}' +
      '.' + PREFIX + '-chip{display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,.1);border-radius:7px;padding:2px 7px;font-weight:600}' +
      '.' + PREFIX + '-chip svg{width:15px;height:15px}' +
      '@media (prefers-color-scheme:light){.' + PREFIX + '-card{background:#ffffff;color:#12151c;border-color:rgba(0,0,0,.1);box-shadow:0 18px 50px rgba(0,0,0,.18)}.' + PREFIX + '-sub{color:#4a5162}.' + PREFIX + '-steps{color:#2a2f3a}.' + PREFIX + '-num,.' + PREFIX + '-chip{background:rgba(0,0,0,.07)}.' + PREFIX + '-close{color:#8b93a5}}';
    var s = document.createElement('style');
    s.id = PREFIX + '-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // Icones SVG inline
  var ICON = {
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><rect x="5" y="11" width="14" height="10" rx="2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 9v6M9 12h6"/></svg>',
    safari: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>'
  };

  function el(html) {
    var d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstChild;
  }

  function remove() {
    var w = document.getElementById(PREFIX + '-wrap');
    if (w) w.parentNode.removeChild(w);
    mounted = false;
  }

  function mount(inner, iconSvg) {
    if (mounted) remove();
    injectStyles();
    var wrap = el(
      '<div id="' + PREFIX + '-wrap" class="' + PREFIX + '-wrap" role="dialog" aria-label="Installer ' + CFG.appName + '" style="--pwaic-accent:' + CFG.accent + '">' +
      '<div class="' + PREFIX + '-card">' +
      '<button class="' + PREFIX + '-close" aria-label="Fermer">&times;</button>' +
      '<div class="' + PREFIX + '-top"><div class="' + PREFIX + '-ico">' + iconSvg + '</div><div>' + inner.head + '</div></div>' +
      (inner.body || '') +
      '</div></div>'
    );
    document.body.appendChild(wrap);
    mounted = true;
    wrap.querySelector('.' + PREFIX + '-close').addEventListener('click', function () {
      rememberDismiss();
      remove();
    });
    if (inner.onMount) inner.onMount(wrap);
  }

  function head(title, sub) {
    return '<p class="' + PREFIX + '-ttl">' + title + '</p>' + (sub ? '<p class="' + PREFIX + '-sub">' + sub + '</p>' : '');
  }

  // --------- Ecrans par plateforme ---------
  function showInstallButton() {
    mount({
      head: head('Installer ' + CFG.appName, "Ajoute l'application a ton ecran, elle s'ouvre en plein ecran, meme hors-ligne."),
      body: '<button class="' + PREFIX + '-btn" type="button">Installer l\'application</button>',
      onMount: function (wrap) {
        wrap.querySelector('.' + PREFIX + '-btn').addEventListener('click', function () {
          if (!deferredPrompt) { remove(); return; }
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then(function () {
            deferredPrompt = null;
            remove();
          });
        });
      }
    }, ICON.download);
  }

  function showIosSafari() {
    mount({
      head: head('Ajouter ' + CFG.appName + ' a l\'ecran d\'accueil', 'Deux etapes dans Safari :'),
      body: '<ol class="' + PREFIX + '-steps">' +
        '<li><span class="' + PREFIX + '-num">1</span> Appuie sur <span class="' + PREFIX + '-chip">' + ICON.share + 'Partager</span> en bas de l\'ecran</li>' +
        '<li><span class="' + PREFIX + '-num">2</span> Choisis <span class="' + PREFIX + '-chip">' + ICON.plus + 'Sur l\'ecran d\'accueil</span></li>' +
        '</ol>'
    }, ICON.share);
  }

  function showIosOpenInSafari(title) {
    mount({
      head: head(title, "L'installation sur iPhone ne marche que dans Safari. Ouvre cette page dans Safari :"),
      body: '<ol class="' + PREFIX + '-steps">' +
        '<li><span class="' + PREFIX + '-num">1</span> Touche <span class="' + PREFIX + '-chip">' + ICON.menu + '</span> ou l\'icone de partage</li>' +
        '<li><span class="' + PREFIX + '-num">2</span> Choisis <span class="' + PREFIX + '-chip">' + ICON.safari + 'Ouvrir dans Safari</span></li>' +
        '<li><span class="' + PREFIX + '-num">3</span> Puis Partager &rarr; Sur l\'ecran d\'accueil</li>' +
        '</ol>'
    }, ICON.safari);
  }

  function showAndroidInApp() {
    mount({
      head: head('Ouvre ' + CFG.appName + ' dans Chrome', "Pour installer l'application, ouvre cette page dans Chrome (menu ⋮ en haut a droite → Ouvrir dans le navigateur), puis Installer.")
    }, ICON.menu);
  }

  // --------- Router ---------
  function decide() {
    var forced = debugState();
    if (forced) {
      switch (forced) {
        case 'ios-safari': return showIosSafari();
        case 'ios-inapp': return showIosOpenInSafari('Ouvre ' + CFG.appName + ' dans Safari');
        case 'ios-otherbrowser': return showIosOpenInSafari('Passe sur Safari pour installer');
        case 'android-installable': return showInstallButton();
        case 'android-inapp': return showAndroidInApp();
        default: return;
      }
    }

    if (isStandalone()) return;        // deja installe
    if (dismissedRecently()) return;   // ferme recemment

    var state = detectPlatform(root.navigator.userAgent, {
      standalone: false,
      maxTouchPoints: root.navigator.maxTouchPoints,
      hasBeforeInstall: !!deferredPrompt
    });

    switch (state) {
      case 'ios-safari': return showIosSafari();
      case 'ios-inapp': return showIosOpenInSafari('Ouvre ' + CFG.appName + ' dans Safari');
      case 'ios-otherbrowser': return showIosOpenInSafari('Passe sur Safari pour installer');
      case 'android-inapp': return showAndroidInApp();
      // android-installable / desktop-installable : geres par l'evenement beforeinstallprompt.
      // android-generic / desktop : rien (pas d'install fiable a proposer).
    }
  }

  // beforeinstallprompt : Android/Chrome + desktop. Peut arriver apres le 1er rendu.
  root.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (debugState()) return;
    if (isStandalone() || dismissedRecently()) return;
    showInstallButton();
  });

  root.addEventListener('appinstalled', function () {
    rememberDismiss();
    remove();
  });

  function boot() {
    try { decide(); } catch (e) { /* ne jamais casser l'app hote */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(typeof self !== 'undefined' ? self : this);
