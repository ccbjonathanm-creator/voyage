/* ==========================================================================
   Voyage — itinéraires de voyage IA, personnalisés et vérifiés.
   100% local (localStorage), sans compte, sans serveur.
   - IA : Gemini, avec la CLÉ DE L'UTILISATEUR (BYOK). Jamais de clé côté dev.
   - Vérification : OpenStreetMap (Nominatim) pour l'existence des lieux,
     Open-Meteo pour la météo réelle sur les dates du voyage.
   ========================================================================== */
'use strict';

/* -------------------------------------------------------------------------
   1. STOCKAGE LOCAL
   ------------------------------------------------------------------------- */
const APP_VERSION = 'v11';
const STORE_KEY = 'boussole.v1';
/* Fournisseurs d'IA supportés (BYOK : la clé de l'utilisateur, appel direct depuis le navigateur).
   Groq par défaut : free tier vraiment généreux (des milliers de requêtes/jour), rapide,
   sans les blocages de quota rencontrés sur Gemini. Gemini reste dispo en option. */
const PROVIDERS = {
  groq: {
    label: 'Groq — gratuit et généreux (recommandé)',
    kind: 'openai',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    keyStore: 'boussole.key.groq',
    keyPrefix: 'gsk_',
    keyUrl: 'https://console.groq.com/keys',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (qualité, recommandé)' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (plus rapide)' },
    ],
    defaultModel: 'llama-3.3-70b-versatile',
  },
  gemini: {
    label: 'Google Gemini',
    kind: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    keyStore: 'boussole.geminikey',
    keyPrefix: 'AIza',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-2.5-flash', label: 'Flash 2.5' },
      { id: 'gemini-2.5-flash-lite', label: 'Flash-Lite 2.5' },
      { id: 'gemini-2.0-flash', label: '2.0 Flash' },
    ],
    defaultModel: 'gemini-2.5-flash',
  },
};
const PROVIDER_STORE = 'boussole.provider';
const MODEL_STORE_PREFIX = 'boussole.model.'; // un modèle mémorisé par fournisseur
function getProviderId() { try { return localStorage.getItem(PROVIDER_STORE) || 'groq'; } catch (e) { return 'groq'; } }
function setProviderId(p) { try { localStorage.setItem(PROVIDER_STORE, PROVIDERS[p] ? p : 'groq'); } catch (e) {} }
function provider() { return PROVIDERS[getProviderId()] || PROVIDERS.groq; }
function getModel() { const p = provider(); try { return localStorage.getItem(MODEL_STORE_PREFIX + getProviderId()) || p.defaultModel; } catch (e) { return p.defaultModel; } }
function setModel(m) { try { localStorage.setItem(MODEL_STORE_PREFIX + getProviderId(), m || provider().defaultModel); } catch (e) {} }

let state = { trips: [] };
let route = { name: 'home', tripId: null }; // home | key | wizard | trip
let wizard = null;
let swReg = null;

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) state = JSON.parse(raw);
    if (!Array.isArray(state.trips)) state.trips = [];
  } catch (e) { state = { trips: [] }; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Sauvegarde impossible (stockage plein ?)'); }
}
function getKey() { try { return localStorage.getItem(provider().keyStore) || ''; } catch (e) { return ''; } }
function setKey(k) { try { localStorage.setItem(provider().keyStore, k || ''); } catch (e) {} }
function hasKey() { return getKey().trim().length > 10; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* -------------------------------------------------------------------------
   1bis. LICENCE — essai de 2 générations gratuites, puis déblocage à vie.
   100% hors-ligne : licence signée (ECDSA P-256) et liée à l'appareil.
   La clé publique est ci-dessous ; la clé privée reste dans le générateur du vendeur.
   Note assumée : l'essai local se remet à zéro si on réinstalle (limite de tout
   système sans serveur). Le déblocage payant, lui, est solide et permanent.
   ------------------------------------------------------------------------- */
const LIC = { device: 'voyage.device', licence: 'voyage.licence', licemail: 'voyage.licemail', gencount: 'voyage.gencount', trialEmail: 'voyage.trial_email' };
const TRIAL_GENERATIONS = 2;
// Compteur d'essais CÔTÉ SERVEUR (Worker partagé), indexé par e-mail haché.
// But : réinstaller l'app ne redonne pas de générations gratuites.
// Repli honnête (fail-open) : si le Worker est injoignable, on laisse passer.
const TRIAL_WORKER = 'https://resolv-trials.contactweb71.workers.dev';
const TRIAL_APP = 'voyage';
let trialEmail = null;
let srvUsesLeft = null;               // null = inconnu (hors-ligne) -> fail-open
let srvLimit = TRIAL_GENERATIONS;
const PRICE = '15 €';
const PAY_URL = ''; // lien de paiement (PayPal.me / Lydia) — à renseigner par le vendeur
const LICENCE_PUBKEY = { kty: 'EC', crv: 'P-256', x: 'pEqmof4mLTrlhAD5j73kprot94Jup0Bn7A0sgybOJTg', y: 'I76Z0LcxF7yShbqjcasPUv_PZS_UlJCLPIDtP_RsNrQ' };
let licensed = false;
const _enc = new TextEncoder();
const _dec = new TextDecoder();
function _fromB64(s) { const b = atob((s || '').replace(/\s+/g, '')); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
function _b64(buf) { let s = ''; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s); }
async function _deriveAes(pw, salt) {
  const base = await crypto.subtle.importKey('raw', _enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Identifiant d'appareil : aléatoire, stable, non secret. C'est lui qui est signé.
function genDeviceId() {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans I,O,0,1,L
  const r = crypto.getRandomValues(new Uint8Array(8));
  let s = ''; for (const b of r) s += a[b % a.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}
function getDeviceId() { let id = localStorage.getItem(LIC.device); if (!id) { id = genDeviceId(); localStorage.setItem(LIC.device, id); } return id; }
// normalisation IDENTIQUE côté vérif et côté générateur
const normEmail = (e) => (e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail(e));

// --- Essai serveur ---
function loadTrialEmail() { try { trialEmail = localStorage.getItem(LIC.trialEmail) || null; } catch (e) { trialEmail = null; } }
function hasTrialEmail() { return !!trialEmail; }
async function setTrialEmail(e) { trialEmail = normEmail(e); try { localStorage.setItem(LIC.trialEmail, trialEmail); } catch (_) {} await trialStatus(); }
async function _trialApi(path) {
  const r = await fetch(TRIAL_WORKER + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: TRIAL_APP, email: trialEmail })
  });
  if (!r.ok) throw new Error('HTTP_' + r.status);
  return r.json();
}
async function trialStatus() { if (!trialEmail) return; try { const j = await _trialApi('/api/status'); srvUsesLeft = j.usesLeft; srvLimit = j.limit; } catch (e) { srvUsesLeft = null; } }
async function trialConsume() { if (!trialEmail) return { allowed: true, offline: true }; try { const j = await _trialApi('/api/consume'); srvUsesLeft = j.usesLeft; srvLimit = j.limit; return j; } catch (e) { return { allowed: true, offline: true }; } }
// Générations restantes pour l'affichage (hors-ligne : on montre la limite).
function trialLeft() { return srvUsesLeft == null ? srvLimit : srvUsesLeft; }
// Autorisé à générer ? licence OU (e-mail fourni ET (hors-ligne OU quota restant)).
function canGenerate() {
  if (licensed) return true;
  if (!trialEmail) return false;           // il faut d'abord fournir un e-mail
  return srvUsesLeft == null || srvUsesLeft > 0; // hors-ligne = fail-open
}
async function verifyLicence(key, email) {
  if (!key) return false;
  try {
    const pub = await crypto.subtle.importKey('jwk', LICENCE_PUBKEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, _fromB64(key), _enc.encode('voyage-licence:' + normEmail(email)));
  } catch (e) { return false; }
}
async function refreshLicence() { licensed = await verifyLicence(localStorage.getItem(LIC.licence), localStorage.getItem(LIC.licemail)); return licensed; }
async function submitLicence(email, raw) {
  const clean = (raw || '').trim().replace(/\s+/g, '');
  const ok = await verifyLicence(clean, email);
  if (ok) { localStorage.setItem(LIC.licence, clean); localStorage.setItem(LIC.licemail, normEmail(email)); licensed = true; }
  return ok;
}
function openLicenceSheet(essaiTermine) {
  const statut = licensed
    ? '✓ Version à vie active. Merci !'
    : (essaiTermine ? 'Ton essai gratuit est terminé.' : 'Essai : ' + trialLeft() + ' génération(s) gratuite(s) restante(s).');
  openSheet(`
    <h2>Débloquer Voyage (${PRICE})</h2>
    <p class="small ${licensed ? 'muted' : ''}" ${licensed ? '' : 'style="color:var(--warn)"'}>${statut}</p>
    ${licensed ? '' : `
    <p class="small muted mt">Déblocage à vie, un seul paiement, valable sur tous tes appareils (même après réinstallation). ${PAY_URL ? 'Paie ici : <a href="' + PAY_URL + '" target="_blank" rel="noopener">payer ' + PRICE + '</a>, puis' : 'Pour payer,'} envoie ton e-mail au vendeur et colle la clé reçue.</p>
    <label class="field">Ton e-mail d'achat</label>
    <input type="email" id="lic-email" placeholder="Ton e-mail d'achat" autocomplete="email" autocapitalize="off" spellcheck="false">
    <label class="field">Clé de licence reçue</label>
    <input type="text" id="lic-key" placeholder="Colle ta clé ici" autocomplete="off" spellcheck="false">
    <button class="btn primary mt" id="lic-go">Activer</button>
    <div id="lic-err" class="small mt" style="color:var(--bad)"></div>`}
    <button class="btn ghost mt" id="lic-close">Fermer</button>`);
  document.getElementById('lic-close').onclick = closeSheet;
  if (!licensed) {
    document.getElementById('lic-go').onclick = async () => {
      const email = document.getElementById('lic-email').value.trim();
      const key = document.getElementById('lic-key').value;
      if (!email) { document.getElementById('lic-err').textContent = 'Saisis ton e-mail d\'achat.'; return; }
      const ok = await submitLicence(email, key);
      if (ok) { closeSheet(); toast('Version à vie activée ✓ Merci !'); render(); }
      else document.getElementById('lic-err').textContent = 'E-mail ou clé incorrects.';
    };
  }
}

// Gate e-mail bloquant au démarrage : demande l'e-mail avant d'utiliser l'app,
// pour que réinstaller ne redonne pas d'essai. onDone() est appelé une fois l'e-mail saisi.
function showTrialEmailGate(onDone) {
  if (document.getElementById('trial-gate')) return;
  const back = document.createElement('div');
  back.id = 'trial-gate';
  back.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(10,12,20,.72);display:flex;align-items:center;justify-content:center;padding:20px';
  back.innerHTML = `<div class="card" style="max-width:420px;width:100%">
    <h2>🧭 Bienvenue sur Voyage</h2>
    <p class="small muted mt">Entre ton e-mail pour activer ton <b>essai gratuit (${TRIAL_GENERATIONS} itinéraires)</b>. Il garde ton essai même si tu réinstalles l'application.</p>
    <label class="field">Ton e-mail</label>
    <input type="email" id="tg-email" placeholder="ton@mail.com" autocomplete="email" autocapitalize="off" spellcheck="false">
    <button class="btn primary mt" id="tg-go">Commencer</button>
    <div id="tg-err" class="small mt" style="color:var(--bad)"></div>
    <button class="btn ghost mt" id="tg-lic">J'ai déjà acheté (activer ma licence)</button>
  </div>`;
  document.body.appendChild(back);
  document.getElementById('tg-go').onclick = async () => {
    const email = document.getElementById('tg-email').value.trim();
    const err = document.getElementById('tg-err');
    if (!validEmail(email)) { err.textContent = 'Entre une adresse e-mail valide.'; return; }
    err.textContent = 'Un instant…';
    await setTrialEmail(email);
    back.remove();
    if (typeof onDone === 'function') onDone();
  };
  document.getElementById('tg-lic').onclick = () => { back.remove(); openLicenceSheet(false); };
}

/* ---- Générateur de licences intégré (accès caché : appui long sur la version) ----
   Réservé au vendeur (Jonathan). La clé privée n'est PAS dans le code : il la colle
   une fois, elle est chiffrée (AES-GCM + mot de passe) et gardée sur ce seul appareil. */
const GEN_LS = 'voyage.genvault';
let genSignKey = null;
function genVault() { try { return JSON.parse(localStorage.getItem(GEN_LS)); } catch (e) { return null; } }
async function genEncrypt(privStr, pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await _deriveAes(pw, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, _enc.encode(privStr));
  return { v: 1, salt: _b64(salt), iv: _b64(iv), ct: _b64(ct) };
}
async function genDecrypt(vault, pw) {
  const key = await _deriveAes(pw, _fromB64(vault.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _fromB64(vault.iv) }, key, _fromB64(vault.ct));
  return _dec.decode(pt);
}
function genImportSign(privStr) { return crypto.subtle.importKey('jwk', JSON.parse(privStr), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); }
async function genMakeLicence(email) {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, genSignKey, _enc.encode('voyage-licence:' + normEmail(email)));
  return _b64(sig);
}
// --- Registre des ventes (e-mail -> clé + date), gardé sur cet appareil ---
const GEN_LEDGER = 'voyage.ledger';
function ledgerGet() { try { return JSON.parse(localStorage.getItem(GEN_LEDGER)) || []; } catch (e) { return []; } }
function ledgerSave(l) { localStorage.setItem(GEN_LEDGER, JSON.stringify(l)); }
function ledgerAdd(email, key) {
  email = normEmail(email);
  const l = ledgerGet(); const i = l.findIndex((x) => x.email === email);
  const e = { email, key, date: new Date().toISOString().slice(0, 10) };
  if (i >= 0) l[i] = e; else l.push(e); ledgerSave(l);
}
function ledgerEsc(s) { return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function genRenderLedger() {
  openSheet(`
    <h2>📋 Registre des ventes</h2>
    <p class="small" style="opacity:.75;margin:0 0 12px">Tes acheteurs, gardés sur cet appareil. Cherche un e-mail pour vérifier un achat et recopier sa clé.</p>
    <input id="ld-q" type="search" placeholder="Chercher un e-mail…" autocomplete="off" style="width:100%">
    <div id="ld-list" style="max-height:44vh;overflow:auto;margin-top:8px"></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn ghost" id="ld-exp" style="flex:1">⬇ Sauvegarder</button>
      <button class="btn ghost" id="ld-imp" style="flex:1">⬆ Restaurer</button>
    </div>
    <button class="btn primary mt" id="ld-back">← Retour</button>
    <input id="ld-file" type="file" accept=".json,application/json" class="hidden">`);
  const $ = (id) => document.getElementById(id);
  const render = () => {
    const q = ($('ld-q').value || '').trim().toLowerCase();
    const list = ledgerGet().filter((x) => !q || x.email.includes(q)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const box = $('ld-list');
    if (!list.length) { box.innerHTML = `<p class="small" style="text-align:center;opacity:.7;padding:10px">${q ? 'Aucun e-mail ne correspond.' : "Aucune vente enregistrée pour l'instant."}</p>`; return; }
    box.innerHTML = list.map((x, i) => `<div style="display:flex;align-items:center;gap:10px;padding:10px 2px;border-bottom:1px solid var(--line)">
      <div style="flex:1;min-width:0"><div style="font-weight:700;word-break:break-all">${ledgerEsc(x.email)}</div><div class="small" style="opacity:.7">acheté le ${x.date || '?'}</div></div>
      <button class="btn ghost" data-i="${i}" style="flex:none;width:auto;padding:8px 12px">Copier</button></div>`).join('');
    box.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => {
      const x = list[+b.dataset.i]; if (navigator.clipboard) navigator.clipboard.writeText(x.key).catch(() => {}); toast('Clé de ' + x.email + ' copiée');
    }));
  };
  render();
  $('ld-q').addEventListener('input', render);
  $('ld-back').onclick = () => genRender('generate');
  $('ld-exp').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(ledgerGet(), null, 1)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'voyage-registre-' + new Date().toISOString().slice(0, 10) + '.json'; a.click(); URL.revokeObjectURL(url); toast('Registre sauvegardé');
  };
  $('ld-imp').onclick = () => $('ld-file').click();
  $('ld-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const arr = JSON.parse(await f.text()); if (!Array.isArray(arr)) throw 0;
      const m = new Map(ledgerGet().map((x) => [x.email, x]));
      for (const x of arr) { if (x && x.email && x.key) { const em = normEmail(x.email); m.set(em, { email: em, key: x.key, date: x.date || '' }); } }
      ledgerSave([...m.values()]); toast('Registre restauré'); render();
    } catch (_) { toast('Fichier invalide'); }
    e.target.value = '';
  });
}
function openGeneratorSheet() { genSignKey = null; genRender(genVault() ? 'unlock' : 'setup'); }
function genRender(screen) {
  if (screen === 'setup') {
    openSheet(`
      <h2>🔑 Générateur — configuration</h2>
      <p class="small muted">Réservé au vendeur. Colle ta clé secrète et choisis un mot de passe maître. La clé sera chiffrée et gardée uniquement sur cet appareil.</p>
      <label class="field">Clé secrète (fournie par Claude)</label>
      <textarea id="gs-key" rows="4" placeholder='{"key_ops":["sign"],...}' style="width:100%" spellcheck="false"></textarea>
      <label class="field">Mot de passe maître</label>
      <input id="gs-pw" type="password" placeholder="Un mot de passe fort">
      <label class="field">Confirme le mot de passe</label>
      <input id="gs-pw2" type="password" placeholder="Retape-le">
      <button class="btn primary mt" id="gs-go">🔒 Chiffrer et enregistrer</button>
      <div id="gs-err" class="small mt" style="color:var(--bad)"></div>
      <button class="btn ghost mt" id="gen-close">Fermer</button>`);
    document.getElementById('gs-go').onclick = genDoSetup;
    document.getElementById('gen-close').onclick = closeSheet;
  } else if (screen === 'unlock') {
    openSheet(`
      <h2>🔑 Générateur</h2>
      <label class="field">Mot de passe maître</label>
      <input id="gu-pw" type="password" placeholder="Ton mot de passe">
      <button class="btn primary mt" id="gu-go">Déverrouiller</button>
      <div id="gu-err" class="small mt" style="color:var(--bad)"></div>
      <button class="btn danger ghost mt" id="gu-reset">Réinitialiser (effacer la clé de ce tél)</button>
      <button class="btn ghost mt" id="gen-close">Fermer</button>`);
    document.getElementById('gu-go').onclick = genDoUnlock;
    document.getElementById('gu-reset').onclick = () => {
      if (confirm('Effacer la clé chiffrée de cet appareil ?')) { localStorage.removeItem(GEN_LS); genSignKey = null; genRender('setup'); }
    };
    document.getElementById('gen-close').onclick = closeSheet;
  } else {
    openSheet(`
      <h2>🔑 Générer une licence</h2>
      <label class="field">E-mail du client</label>
      <input id="gg-id" type="email" placeholder="client@mail.com" autocapitalize="off" spellcheck="false" style="text-align:center;font-weight:700">
      <button class="btn primary mt" id="gg-go">Générer la clé</button>
      <div id="gg-out" class="hidden mt">
        <label class="field">Clé à donner au client</label>
        <div id="gg-key" style="word-break:break-all;user-select:all;background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:14px;font-family:monospace;font-size:13px"></div>
        <button class="btn ghost mt" id="gg-copy">📋 Copier la clé</button>
        <div id="gg-ok" class="small mt" style="color:var(--ok)"></div>
      </div>
      <div id="gg-err" class="small mt" style="color:var(--bad)"></div>
      <button class="btn ghost mt" id="gg-ledger">📋 Registre des ventes (${ledgerGet().length})</button>
      <button class="btn ghost mt" id="gg-lock">🔒 Verrouiller</button>`);
    document.getElementById('gg-go').onclick = genDoGenerate;
    document.getElementById('gg-ledger').onclick = genRenderLedger;
    document.getElementById('gg-lock').onclick = () => { genSignKey = null; genRender('unlock'); };
  }
}
async function genDoSetup() {
  const err = document.getElementById('gs-err'); err.textContent = '';
  const raw = document.getElementById('gs-key').value.trim();
  const pw = document.getElementById('gs-pw').value, pw2 = document.getElementById('gs-pw2').value;
  let jwk;
  try { jwk = JSON.parse(raw); } catch (e) { err.textContent = 'Clé illisible (JSON invalide).'; return; }
  if (jwk.x !== LICENCE_PUBKEY.x || jwk.y !== LICENCE_PUBKEY.y || !jwk.d) { err.textContent = "Cette clé ne correspond pas à Voyage."; return; }
  if (pw.length < 8) { err.textContent = 'Mot de passe : 8 caractères minimum.'; return; }
  if (pw !== pw2) { err.textContent = 'Les deux mots de passe diffèrent.'; return; }
  try {
    genSignKey = await genImportSign(raw);
    localStorage.setItem(GEN_LS, JSON.stringify(await genEncrypt(raw, pw)));
    genRender('generate');
  } catch (e) { err.textContent = 'Erreur : ' + e.message; }
}
async function genDoUnlock() {
  const err = document.getElementById('gu-err'); err.textContent = '';
  const v = genVault(); if (!v) { genRender('setup'); return; }
  try {
    genSignKey = await genImportSign(await genDecrypt(v, document.getElementById('gu-pw').value));
    genRender('generate');
  } catch (e) { err.textContent = 'Mot de passe incorrect.'; }
}
async function genDoGenerate() {
  const err = document.getElementById('gg-err'); err.textContent = ''; document.getElementById('gg-out').classList.add('hidden');
  const id = document.getElementById('gg-id').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) { err.textContent = 'Entre un e-mail valide.'; return; }
  if (!genSignKey) { genRender('unlock'); return; }
  try {
    const key = await genMakeLicence(id);
    ledgerAdd(id, key);
    document.getElementById('gg-key').textContent = key;
    document.getElementById('gg-out').classList.remove('hidden');
    document.getElementById('gg-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(document.getElementById('gg-key').textContent); document.getElementById('gg-ok').textContent = 'Copié ✓'; }
      catch (e) { document.getElementById('gg-ok').textContent = 'Sélectionne et copie la clé.'; }
    };
  } catch (e) { err.textContent = 'Erreur : ' + e.message; }
}

// Détecte un appui long (700 ms), souris et tactile.
function bindLongPress(node, cb, ms) {
  if (!node) return;
  let t = null;
  const start = () => { t = setTimeout(cb, ms || 700); };
  const cancel = () => { clearTimeout(t); };
  node.addEventListener('touchstart', start, { passive: true });
  node.addEventListener('touchend', cancel);
  node.addEventListener('touchmove', cancel, { passive: true });
  node.addEventListener('mousedown', start);
  node.addEventListener('mouseup', cancel);
  node.addEventListener('mouseleave', cancel);
}

/* -------------------------------------------------------------------------
   2. OUTILS DATES
   ------------------------------------------------------------------------- */
function fmtISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function todayISO() { return fmtISO(new Date()); }
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }
function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }
function nbDaysInclusive(a, b) { return Math.max(1, daysBetween(a, b) + 1); }

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const JOURS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
function humanDate(iso) { const d = parseISO(iso); return d.getDate() + ' ' + MOIS[d.getMonth()]; }
function humanDayFull(iso) { const d = parseISO(iso); return JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()]; }
function humanRange(a, b) {
  const db = parseISO(b);
  return humanDate(a) + ' → ' + humanDate(b) + ' ' + db.getFullYear();
}
function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '📍';
  const A = 0x1F1E6;
  return String.fromCodePoint(A + cc.toUpperCase().charCodeAt(0) - 65, A + cc.toUpperCase().charCodeAt(1) - 65);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* -------------------------------------------------------------------------
   3. RÉSEAU
   ------------------------------------------------------------------------- */
async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('HTTP ' + res.status + (t ? ' ' + t.slice(0, 200) : '')); }
  return res.json();
}

// Géocodage ville via Open-Meteo (gratuit, sans clé) pour l'autocomplétion.
async function geocodeVille(name) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search?count=6&language=fr&format=json&name=' + encodeURIComponent(name);
  const data = await fetchJSON(url);
  return (data.results || []).map(r => ({
    name: r.name, admin1: r.admin1 || '', country: r.country || '',
    cc: r.country_code || '', lat: r.latitude, lon: r.longitude,
  }));
}

/* Météo Open-Meteo sur [start,end]. Prévision si <=16 j, sinon moyennes de l'an dernier.
   Retourne un objet { 'YYYY-MM-DD': {tmax,tmin,code,source} }. */
async function getWeatherRange(lat, lon, start, end) {
  const out = {};
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const horizon = addDays(today, 15);
  const startD = parseISO(start), endD = parseISO(end);
  const daily = 'temperature_2m_max,temperature_2m_min,weathercode';

  // Prévision (couvre la partie dans les 16 jours)
  if (endD >= today && startD <= horizon) {
    const s = fmtISO(startD < today ? today : startD);
    const e = fmtISO(endD > horizon ? horizon : endD);
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=${daily}&timezone=auto&start_date=${s}&end_date=${e}`;
      const d = await fetchJSON(url);
      (d.daily?.time || []).forEach((t, i) => {
        out[t] = { tmax: d.daily.temperature_2m_max[i], tmin: d.daily.temperature_2m_min[i], code: d.daily.weathercode[i], source: 'prévision' };
      });
    } catch (e) { /* on continue */ }
  }
  // Archive de l'an dernier pour les jours non couverts
  const manquants = [];
  for (let i = 0; i < nbDaysInclusive(start, end); i++) {
    const iso = fmtISO(addDays(startD, i));
    if (!out[iso]) manquants.push(iso);
  }
  if (manquants.length) {
    const lastYear = (iso) => { const d = parseISO(iso); d.setFullYear(d.getFullYear() - 1); return fmtISO(d); };
    const s = lastYear(manquants[0]), e = lastYear(manquants[manquants.length - 1]);
    try {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&daily=${daily}&timezone=auto&start_date=${s}&end_date=${e}`;
      const d = await fetchJSON(url);
      const map = {};
      (d.daily?.time || []).forEach((t, i) => { map[t] = { tmax: d.daily.temperature_2m_max[i], tmin: d.daily.temperature_2m_min[i], code: d.daily.weathercode[i] }; });
      manquants.forEach(iso => { const ly = lastYear(iso); if (map[ly]) out[iso] = { ...map[ly], source: 'moyenne an dernier' }; });
    } catch (e) { /* pas de météo pour ces jours */ }
  }
  return out;
}
function weatherEmoji(code) {
  if (code == null) return '🌡️';
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌧️';
  if (code <= 86) return '❄️';
  return '⛈️';
}

/* Vérification d'existence d'un lieu via OpenStreetMap Nominatim.
   Renvoie {found, lat, lon} ou {found:false}. Throttlé (politesse Nominatim). */
let lastNomiCall = 0;
async function verifyLieu(nom, villeCtx) {
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastNomiCall)); // ~1 req/s max
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastNomiCall = Date.now();
  const q = encodeURIComponent(nom + ', ' + villeCtx);
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${q}`;
    const data = await fetchJSON(url, { headers: { 'Accept-Language': 'fr' } });
    if (data && data.length) return { found: true, lat: +data[0].lat, lon: +data[0].lon };
  } catch (e) { /* réseau/quota : on retombe en "à confirmer" */ }
  return { found: false };
}

/* -------------------------------------------------------------------------
   4. IA — multi-fournisseurs (BYOK), appel direct depuis le navigateur.
   Groq (format OpenAI) ou Gemini. La clé de l'utilisateur n'est jamais envoyée
   ailleurs qu'au fournisseur choisi.
   ------------------------------------------------------------------------- */

// Lit un message d'erreur exploitable dans une réponse (formats Google et OpenAI/Groq).
async function litDetailErreur(res) {
  try {
    const j = await res.json();
    if (j && j.error) return (typeof j.error === 'string') ? j.error : (j.error.message || '');
    return '';
  } catch (e) { return ''; }
}

// Construit la requête selon le fournisseur.
function prepareRequete(p, key, prompt, json) {
  if (p.kind === 'gemini') {
    const url = `${p.endpoint}/models/${getModel()}:generateContent?key=${encodeURIComponent(key)}`;
    const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5 } };
    if (json) body.generationConfig.responseMimeType = 'application/json';
    return { url, headers: { 'Content-Type': 'application/json' }, body };
  }
  // OpenAI-compatible (Groq)
  const body = {
    model: getModel(),
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
  };
  if (json) body.response_format = { type: 'json_object' };
  return { url: p.endpoint, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }, body };
}

// Extrait le texte de la réponse selon le fournisseur.
function extraireTexte(p, data) {
  if (p.kind === 'gemini') return data?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '';
  return data?.choices?.[0]?.message?.content || '';
}

async function callAI(prompt, { json = false, onStatus = null } = {}) {
  const p = provider();
  const key = getKey().trim();
  if (!key) throw new Error('Aucune clé enregistrée.');
  console.log('[Voyage] appel', getProviderId(), 'modèle', getModel());
  const { url, headers, body } = prepareRequete(p, key, prompt, json);

  const unAppel = async () => {
    try { return await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }); }
    catch (e) { throw new Error('Réseau indisponible.'); }
  };

  let res = await unAppel();

  // Réessai auto une fois si le fournisseur indique un court délai (429).
  if (res.status === 429) {
    const detail = await litDetailErreur(res);
    const m = detail.match(/(?:retry in|try again in|after)\s*([\d.]+)\s*s/i);
    const ra = parseFloat(res.headers.get('retry-after') || '');
    const attente = m ? parseFloat(m[1]) : (isFinite(ra) ? ra : 0);
    if (attente > 0 && attente <= 65) {
      onStatus && onStatus('Limite momentanée atteinte. Nouvelle tentative dans ' + Math.ceil(attente) + ' s… (patiente)');
      await new Promise(r => setTimeout(r, (attente + 2) * 1000));
      res = await unAppel();
    } else {
      throw new Error('Quota du modèle « ' + getModel() + ' » atteint. Attends un peu, ou change de modèle/fournisseur (menu 🔑).' + (detail ? ' [' + detail + ']' : ''));
    }
  }

  if (!res.ok) {
    const detail = await litDetailErreur(res);
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error('Clé refusée ou invalide.' + (detail ? ' [' + detail + ']' : ''));
    if (res.status === 404) throw new Error('Le modèle « ' + getModel() + ' » n\'est pas disponible pour ta clé. Choisis-en un autre (menu 🔑).' + (detail ? ' [' + detail + ']' : ''));
    if (res.status === 429) throw new Error('Quota encore atteint après attente. Réessaie dans 1 min.' + (detail ? ' [' + detail + ']' : ''));
    throw new Error('Le fournisseur a répondu ' + res.status + '.' + (detail ? ' [' + detail + ']' : ''));
  }
  const data = await res.json();
  const txt = extraireTexte(p, data);
  if (!txt) throw new Error('Réponse vide du fournisseur.');
  return txt;
}

// Validation de clé (onboarding). Renvoie { ok, status, reason }.
async function testerCle(key) {
  const p = provider();
  const { url, headers, body } = prepareRequete(p, key.trim(), 'Réponds juste: ok', false);
  let res;
  try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }); }
  catch (e) { return { ok: false, status: 0, reason: 'Réseau indisponible.' }; }
  if (res.ok) return { ok: true, status: 200 };
  const detail = await litDetailErreur(res);
  return { ok: false, status: res.status, reason: detail || ('HTTP ' + res.status) };
}

// Diagnostic : liste les modèles utilisables par la clé.
async function listerModeles(key) {
  const p = provider();
  if (p.kind === 'gemini') {
    const res = await fetch(`${p.endpoint}/models?key=${encodeURIComponent(key.trim())}`);
    if (!res.ok) throw new Error((await litDetailErreur(res)) || ('HTTP ' + res.status));
    const data = await res.json();
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => (m.name || '').replace('models/', ''));
  }
  // OpenAI-compatible (Groq)
  const res = await fetch(p.modelsUrl, { headers: { 'Authorization': 'Bearer ' + key.trim() } });
  if (!res.ok) throw new Error((await litDetailErreur(res)) || ('HTTP ' + res.status));
  const data = await res.json();
  return (data.data || []).map(m => m.id);
}

function construirePrompt(w) {
  const n = nbDaysInclusive(w.startDate, w.endDate);
  const dest = w.dest;
  const interets = (w.interets || []).join(', ') || 'découverte générale';
  return `Tu es un conseiller en voyages expert et honnête. Crée un itinéraire de ${n} jour(s) à ${dest.name} (${dest.country}).

CONTEXTE VOYAGEUR :
- Dates : du ${humanDate(w.startDate)} au ${humanDate(w.endDate)}
- Voyageurs : ${w.voyageurs}
- Ville de départ : ${w.depart || 'non précisée'}
- Budget indicatif : ${w.budget || 'non précisé'}
- Centres d'intérêt : ${interets}
- Rythme souhaité : ${w.rythme}

RÈGLES STRICTES (très important) :
1. N'utilise QUE des lieux, restaurants, musées, sites RÉELS et connus qui existent vraiment à ${dest.name}. Si tu n'es pas sûr qu'un établissement précis existe, décris un TYPE de lieu (ex: "un café dans le quartier X") plutôt que d'inventer un nom.
2. Reste réaliste sur les distances et le temps : n'enchaîne pas des lieux à l'opposé de la ville dans la même demi-journée.
3. Adapte au budget et au rythme demandés.
4. Donne des estimations de coût en euros, réalistes et prudentes.
5. Le champ "lieu" doit être le nom cherchable sur une carte (nom de l'établissement ou du site), sans adresse complète.

Réponds UNIQUEMENT en JSON valide, sans texte autour, avec EXACTEMENT cette structure :
{
  "resume": "2 phrases qui résument l'esprit du séjour",
  "budget_estime": "estimation prudente du budget sur place par personne, HORS vol et hôtel (ex: 'environ 250-350 € / personne pour ${n} jours : repas, visites, transports locaux')",
  "iata_depart": "code IATA (3 lettres majuscules) de l'aéroport principal le plus proche de la ville de départ, ou '' si inconnu",
  "iata_arrivee": "code IATA (3 lettres majuscules) de l'aéroport principal desservant ${dest.name}, ou '' si inconnu",
  "jours": [
    {
      "titre": "titre court de la journée",
      "activites": [
        {
          "nom": "nom de l'activité",
          "lieu": "nom du lieu cherchable sur une carte",
          "categorie": "visite | repas | activite | transport | hebergement | detente",
          "moment": "matin | midi | apres-midi | soir",
          "cout_estime": "ex: 15-20 € / gratuit",
          "astuce": "conseil pratique court et utile"
        }
      ]
    }
  ]
}
Il doit y avoir exactement ${n} objet(s) dans "jours".`;
}

// Parse robuste du JSON renvoyé (au cas où du texte entoure le JSON).
function parseItineraire(txt) {
  let s = txt.trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const obj = JSON.parse(s);
  if (!obj || !Array.isArray(obj.jours)) throw new Error('Format inattendu.');
  return obj;
}

/* -------------------------------------------------------------------------
   5. GÉNÉRATION COMPLÈTE (IA + vérification)
   ------------------------------------------------------------------------- */
async function genererVoyage(w, onStep) {
  onStep && onStep('Génération de l\'itinéraire par l\'IA…');
  const txt = await callAI(construirePrompt(w), { json: true, onStatus: onStep });
  const it = parseItineraire(txt);

  // Météo par date
  onStep && onStep('Récupération de la météo réelle…');
  let weather = {};
  try { weather = await getWeatherRange(w.dest.lat, w.dest.lon, w.startDate, w.endDate); } catch (e) {}

  // Vérification des lieux (limitée pour rester poli avec OSM)
  const villeCtx = w.dest.name + ', ' + w.dest.country;
  let aVerifier = [];
  it.jours.forEach(j => (j.activites || []).forEach(a => { if (a.lieu) aVerifier.push(a); }));
  const MAX_VERIF = 25;
  let done = 0;
  for (const a of aVerifier.slice(0, MAX_VERIF)) {
    done++;
    onStep && onStep(`Vérification des lieux… (${done}/${Math.min(aVerifier.length, MAX_VERIF)})`);
    const r = await verifyLieu(a.lieu, villeCtx);
    a.verifie = r.found ? 'ok' : 'warn';
    if (r.found) { a.lat = r.lat; a.lon = r.lon; }
  }
  aVerifier.slice(MAX_VERIF).forEach(a => { a.verifie = 'pending'; });

  const trip = {
    id: uid(),
    dest: w.dest,
    startDate: w.startDate,
    endDate: w.endDate,
    voyageurs: w.voyageurs,
    depart: w.depart || '',
    budget: w.budget,
    interets: w.interets,
    rythme: w.rythme,
    resume: it.resume || '',
    budget_estime: it.budget_estime || '',
    iata_depart: (it.iata_depart || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3),
    iata_arrivee: (it.iata_arrivee || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3),
    jours: it.jours,
    weather,
    createdAt: Date.now(),
  };
  return trip;
}

function scoreFiabilite(trip) {
  let ok = 0, total = 0;
  trip.jours.forEach(j => (j.activites || []).forEach(a => {
    if (!a.lieu) return;
    total++;
    if (a.verifie === 'ok') ok++;
  }));
  if (!total) return null;
  return Math.round((ok / total) * 100);
}

/* -------------------------------------------------------------------------
   6. UI — TOAST & FEUILLE
   ------------------------------------------------------------------------- */
let toastT = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 2600);
}
function openSheet(html) {
  const s = document.getElementById('sheet'), b = document.getElementById('sheet-backdrop');
  s.innerHTML = '<div class="grabber"></div>' + html;
  s.classList.remove('hidden'); b.classList.remove('hidden');
}
function closeSheet() {
  document.getElementById('sheet').classList.add('hidden');
  document.getElementById('sheet-backdrop').classList.add('hidden');
}

/* -------------------------------------------------------------------------
   7. RENDU
   ------------------------------------------------------------------------- */
const view = () => document.getElementById('view');
const topbar = () => document.getElementById('topbar');

function render() {
  if (route.name === 'home') return renderHome();
  if (route.name === 'key') return renderKey();
  if (route.name === 'wizard') return renderWizard();
  if (route.name === 'trip') return renderTrip();
}

/* --- Accueil --- */
function renderHome() {
  topbar().innerHTML = `
    <div class="title">🧭 Voyage</div>
    <div class="spacer"></div>
    <button class="iconbtn" id="btn-key" title="Ma clé IA">🔑</button>`;
  document.getElementById('btn-key').onclick = () => { route = { name: 'key', back: 'home' }; render(); };

  let html = '';
  if (!hasKey()) {
    html += `<div class="card">
      <b>Bienvenue !</b>
      <p class="muted small mt">Voyage crée tes itinéraires avec ta propre clé d'IA gratuite (Groq conseillé). Ça reste sur ton téléphone, aucun serveur.</p>
      <button class="btn primary mt" id="btn-setup">Configurer ma clé (2 min)</button>
    </div>`;
  }

  if (!state.trips.length) {
    html += `<div class="empty"><div class="big">🗺️</div>Aucun voyage pour l'instant.<br>Crée ton premier itinéraire.</div>`;
  } else {
    html += '<div class="mt">';
    state.trips.slice().sort((a, b) => b.createdAt - a.createdAt).forEach(t => {
      html += `<div class="card trip-card" data-id="${t.id}">
        <div class="emoji">${flagEmoji(t.dest.cc)}</div>
        <div class="grow">
          <div class="name">${esc(t.dest.name)}</div>
          <div class="meta">${humanRange(t.startDate, t.endDate)} · ${t.jours.length} jour(s)</div>
        </div>
        <div class="badge ${badgeClass(scoreFiabilite(t))}">${scoreLabel(scoreFiabilite(t))}</div>
      </div>`;
    });
    html += '</div>';
  }
  html += `<button class="btn primary mt2" id="btn-new">＋ Nouvel itinéraire</button>`;

  // Bandeau licence / essai
  if (licensed) {
    html += `<p class="small muted center mt2">✓ Version à vie active. Merci !</p>`;
  } else {
    const left = trialLeft();
    html += `<div class="card mt2" id="lic-banner" style="cursor:pointer">
      <b>${left > 0 ? '🎁 Essai gratuit' : '🔒 Essai terminé'}</b>
      <p class="small muted mt">${left > 0
        ? left + ' itinéraire(s) gratuit(s) restant(s). Débloque la version à vie (' + PRICE + ') quand tu veux.'
        : 'Débloque la version à vie (' + PRICE + ', un seul paiement) pour continuer à générer.'}</p>
    </div>`;
  }
  html += `<p class="small muted center mt2" id="ver-foot" style="user-select:none">Voyage ${APP_VERSION}</p>`;
  view().innerHTML = html;

  const setup = document.getElementById('btn-setup');
  if (setup) setup.onclick = () => { route = { name: 'key', back: 'home' }; render(); };
  document.getElementById('btn-new').onclick = startWizard;
  const banner = document.getElementById('lic-banner');
  if (banner) banner.onclick = () => openLicenceSheet(trialLeft() === 0);
  bindLongPress(document.getElementById('ver-foot'), openGeneratorSheet); // accès caché au générateur
  view().querySelectorAll('.trip-card').forEach(c => c.onclick = () => { route = { name: 'trip', tripId: c.dataset.id }; render(); });
}
function badgeClass(score) { if (score == null) return 'pending'; if (score >= 70) return 'ok'; if (score >= 40) return 'warn'; return 'pending'; }
function scoreLabel(score) { if (score == null) return '—'; return score + '% ✓'; }

/* --- Écran clé (BYOK) --- */
function renderKey() {
  topbar().innerHTML = `<button class="iconbtn" id="back">←</button><div class="title" style="margin-left:8px">Ma clé IA</div>`;
  document.getElementById('back').onclick = () => { route = { name: route.back || 'home' }; render(); };
  const p = provider();
  const tuto = getProviderId() === 'groq'
    ? ['Va sur <a href="' + p.keyUrl + '" target="_blank" rel="noopener">console.groq.com/keys</a>',
       'Crée un compte gratuit (email ou Google), sans carte bancaire',
       'Clique « Create API Key »',
       'Copie la clé (elle commence par « gsk_… »)',
       'Colle-la ci-dessous']
    : ['Va sur <a href="' + p.keyUrl + '" target="_blank" rel="noopener">aistudio.google.com/apikey</a>',
       'Connecte-toi avec ton compte Google',
       'Clique « Create API key »',
       'Copie la clé (elle commence par « AIza… »)',
       'Colle-la ci-dessous'];

  view().innerHTML = `
    <div class="card">
      <label class="field">Fournisseur d'IA</label>
      <select id="prov-sel">
        ${Object.keys(PROVIDERS).map(id => `<option value="${id}" ${getProviderId() === id ? 'selected' : ''}>${PROVIDERS[id].label}</option>`).join('')}
      </select>
      <p class="muted small mt">BYOK : tu utilises TA clé, gratuite. Tes recherches ne passent que par ton appareil et le fournisseur choisi. <b>Groq</b> est conseillé (free tier large, pas de blocage de quota).</p>
    </div>
    <div class="card">
      <b>Obtenir ta clé (gratuit)</b>
      <ol class="tuto">${tuto.map(s => '<li>' + s + '</li>').join('')}</ol>
    </div>
    <div class="card">
      <label class="field">Ta clé (${esc(getProviderId() === 'groq' ? 'Groq' : 'Gemini')})</label>
      <input type="password" id="key-input" placeholder="${p.keyPrefix}…" value="${esc(getKey())}" autocomplete="off" autocapitalize="off" spellcheck="false" />
      <label class="small muted mt" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="key-show" style="width:auto"> Afficher</label>
      <label class="field">Modèle</label>
      <select id="model-sel">
        ${p.models.map(m => `<option value="${m.id}" ${getModel() === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
      </select>
      <p class="small muted mt">En cas de « quota atteint », l'app patiente et réessaie automatiquement. Si un modèle est « non disponible », clique « Voir les modèles dispo ».</p>
      <button class="btn primary mt" id="key-save">Tester et enregistrer</button>
      <button class="btn ghost mt" id="key-diag">🔍 Voir les modèles dispo pour ma clé</button>
      ${hasKey() ? '<button class="btn danger ghost mt" id="key-del">Supprimer ma clé</button>' : ''}
      <div id="key-msg" class="small mt"></div>
      <p class="small muted mt">🔒 Ta clé reste sur cet appareil (stockage local du navigateur). Elle n'est jamais envoyée ailleurs qu'au fournisseur choisi.</p>
    </div>`;

  const input = document.getElementById('key-input');
  const msg = document.getElementById('key-msg');
  const showMsg = (html, color) => { msg.style.color = color || 'var(--txt-dim)'; msg.innerHTML = html; };
  document.getElementById('prov-sel').onchange = (e) => { setProviderId(e.target.value); render(); };
  document.getElementById('key-show').onchange = (e) => { input.type = e.target.checked ? 'text' : 'password'; };
  document.getElementById('model-sel').onchange = (e) => { setModel(e.target.value); };

  document.getElementById('key-save').onclick = async () => {
    const k = input.value.trim();
    if (k.length < 10) { toast('Clé trop courte.'); return; }
    const btn = document.getElementById('key-save');
    btn.disabled = true; btn.textContent = 'Test en cours…'; showMsg('');
    const r = await testerCle(k);
    btn.disabled = false; btn.textContent = 'Tester et enregistrer';
    if (r.ok) {
      setKey(k); toast('Clé valide et enregistrée ✅'); route = { name: route.back || 'home' }; render();
    } else if (r.status === 429) {
      // Clé VALIDE mais limite/quota atteint : on autorise l'enregistrement.
      setKey(k);
      showMsg('⚠️ Clé enregistrée, mais le quota du modèle « ' + getModel() + ' » est atteint maintenant.<br>Réponse du fournisseur : <i>' + esc(r.reason) + '</i><br>Attends quelques minutes, ou utilise le diagnostic ci-dessous pour choisir un autre modèle.', 'var(--warn)');
    } else if (r.status === 400 || r.status === 401 || r.status === 403) {
      showMsg('❌ Clé refusée (' + r.status + ').<br><i>' + esc(r.reason) + '</i>', 'var(--bad)');
    } else if (r.status === 404) {
      showMsg('❌ Le modèle « ' + getModel() + ' » n\'est pas disponible pour ta clé.<br>Clique « Voir les modèles dispo » et choisis-en un dans la liste.', 'var(--bad)');
    } else {
      showMsg('❌ Test échoué (' + r.status + ').<br><i>' + esc(r.reason) + '</i>', 'var(--bad)');
    }
  };

  document.getElementById('key-diag').onclick = async () => {
    const k = input.value.trim();
    if (k.length < 10) { toast('Colle d\'abord ta clé.'); return; }
    showMsg('Recherche des modèles…');
    try {
      const mods = await listerModeles(k);
      if (!mods.length) { showMsg('Aucun modèle de génération disponible pour cette clé.', 'var(--bad)'); return; }
      const dispo = mods.filter(m => /flash|pro/.test(m)).slice(0, 12);
      showMsg('✅ Ta clé fonctionne. Modèles utilisables :<br>' + dispo.map(m => '• ' + esc(m)).join('<br>') + '<br><br>Choisis-en un dans le menu ci-dessus (Flash-Lite conseillé).', 'var(--ok)');
    } catch (e) {
      showMsg('❌ Impossible de lister les modèles.<br><i>' + esc(e.message) + '</i>', 'var(--bad)');
    }
  };

  const del = document.getElementById('key-del');
  if (del) del.onclick = () => { setKey(''); toast('Clé supprimée.'); render(); };
}

/* --- Assistant de création --- */
const INTERETS = [
  { id: 'gastronomie', label: 'Gastronomie', e: '🍽️' },
  { id: 'culture', label: 'Culture / musées', e: '🏛️' },
  { id: 'nature', label: 'Nature', e: '🌿' },
  { id: 'fete', label: 'Vie nocturne', e: '🍸' },
  { id: 'shopping', label: 'Shopping', e: '🛍️' },
  { id: 'histoire', label: 'Histoire', e: '📜' },
  { id: 'plage', label: 'Plage / mer', e: '🏖️' },
  { id: 'aventure', label: 'Aventure', e: '🧗' },
  { id: 'detente', label: 'Détente', e: '🧘' },
  { id: 'famille', label: 'En famille', e: '👨‍👩‍👧' },
];
const RYTHMES = [
  { id: 'chill', label: 'Tranquille' },
  { id: 'equilibre', label: 'Équilibré' },
  { id: 'intense', label: 'Intense' },
];

function startWizard() {
  if (!hasKey()) { toast('Configure d\'abord ta clé IA.'); route = { name: 'key', back: 'home' }; render(); return; }
  const start = todayISO();
  const end = fmtISO(addDays(parseISO(start), 3));
  wizard = { dest: null, query: '', startDate: start, endDate: end, voyageurs: 'couple', depart: 'Lyon', budget: '', interets: [], rythme: 'equilibre' };
  route = { name: 'wizard' }; render();
}

function renderWizard() {
  topbar().innerHTML = `<button class="iconbtn" id="back">←</button><div class="title" style="margin-left:8px">Nouvel itinéraire</div>`;
  document.getElementById('back').onclick = () => { route = { name: 'home' }; render(); };
  const w = wizard;

  view().innerHTML = `
    <div class="card">
      <label class="field">Destination</label>
      <input type="text" id="dest" placeholder="Ex: Lisbonne, Rome, Marrakech…" value="${esc(w.dest ? w.dest.name : w.query)}" autocomplete="off" />
      <div id="autolist"></div>
    </div>
    <div class="card">
      <div class="row">
        <div><label class="field">Départ</label><input type="date" id="start" value="${w.startDate}"></div>
        <div><label class="field">Retour</label><input type="date" id="end" value="${w.endDate}"></div>
      </div>
      <div class="small muted mt" id="nb-jours"></div>
    </div>
    <div class="card">
      <label class="field">Qui voyage ?</label>
      <div class="chips" id="voyageurs">
        ${['solo', 'couple', 'famille', 'amis'].map(v => `<div class="chip ${w.voyageurs === v ? 'on' : ''}" data-v="${v}">${v}</div>`).join('')}
      </div>
      <label class="field">Ville de départ (pour les liens de vols)</label>
      <input type="text" id="depart" placeholder="Ex: Lyon, Paris…" value="${esc(w.depart || '')}">
      <label class="field">Budget indicatif (optionnel)</label>
      <input type="text" id="budget" placeholder="Ex: 800 € pour 2, petit budget…" value="${esc(w.budget)}">
    </div>
    <div class="card">
      <label class="field">Centres d'intérêt</label>
      <div class="chips" id="interets">
        ${INTERETS.map(i => `<div class="chip ${w.interets.includes(i.id) ? 'on' : ''}" data-i="${i.id}">${i.e} ${i.label}</div>`).join('')}
      </div>
      <label class="field">Rythme</label>
      <div class="chips" id="rythme">
        ${RYTHMES.map(r => `<div class="chip ${w.rythme === r.id ? 'on' : ''}" data-r="${r.id}">${r.label}</div>`).join('')}
      </div>
    </div>
    <button class="btn primary mt2" id="go">✨ Générer mon itinéraire</button>
    <p class="small muted center mt">L'IA propose, Voyage vérifie les lieux et la météo.</p>`;

  const majJours = () => {
    const n = nbDaysInclusive(document.getElementById('start').value, document.getElementById('end').value);
    document.getElementById('nb-jours').textContent = n + ' jour(s) sur place';
  };
  majJours();

  // Destination + autocomplétion
  const destInput = document.getElementById('dest');
  const autolist = document.getElementById('autolist');
  let debounce = null;
  destInput.oninput = () => {
    w.dest = null; w.query = destInput.value;
    clearTimeout(debounce);
    const q = destInput.value.trim();
    if (q.length < 2) { autolist.innerHTML = ''; return; }
    debounce = setTimeout(async () => {
      try {
        const opts = await geocodeVille(q);
        autolist.innerHTML = `<div class="autolist">${opts.map((o, i) =>
          `<div class="opt" data-i="${i}">${flagEmoji(o.cc)} <div><b>${esc(o.name)}</b> <span class="muted small">${esc([o.admin1, o.country].filter(Boolean).join(', '))}</span></div></div>`
        ).join('')}</div>`;
        autolist.querySelectorAll('.opt').forEach(el => el.onclick = () => {
          w.dest = opts[+el.dataset.i]; w.query = w.dest.name;
          destInput.value = w.dest.name; autolist.innerHTML = '';
        });
      } catch (e) { autolist.innerHTML = ''; }
    }, 350);
  };

  document.getElementById('start').onchange = (e) => {
    w.startDate = e.target.value;
    if (parseISO(w.endDate) < parseISO(w.startDate)) { w.endDate = w.startDate; document.getElementById('end').value = w.endDate; }
    majJours();
  };
  document.getElementById('end').onchange = (e) => { w.endDate = e.target.value; majJours(); };
  document.getElementById('depart').oninput = (e) => { w.depart = e.target.value; };
  document.getElementById('budget').oninput = (e) => { w.budget = e.target.value; };

  bindChips('voyageurs', 'v', (v) => { w.voyageurs = v; }, false);
  bindChips('rythme', 'r', (r) => { w.rythme = r; }, false);
  bindChips('interets', 'i', (id) => {
    const k = w.interets.indexOf(id);
    if (k >= 0) w.interets.splice(k, 1); else w.interets.push(id);
  }, true);

  document.getElementById('go').onclick = lancerGeneration;
}

function bindChips(containerId, attr, onPick, multi) {
  const cont = document.getElementById(containerId);
  cont.querySelectorAll('.chip').forEach(chip => chip.onclick = () => {
    if (!multi) cont.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
    chip.classList.toggle('on');
    onPick(chip.dataset[attr]);
  });
}

async function lancerGeneration() {
  const w = wizard;
  if (!w.dest) { toast('Choisis une destination dans la liste.'); return; }
  if (nbDaysInclusive(w.startDate, w.endDate) > 14) { toast('Limite-toi à 14 jours pour de bons résultats.'); return; }

  // Verrou essai/licence.
  await refreshLicence();
  if (!licensed && !hasTrialEmail()) { showTrialEmailGate(() => lancerGeneration()); return; }
  if (!licensed) await trialStatus();               // état frais avant de décider
  if (!canGenerate()) { openLicenceSheet(true); return; }

  topbar().innerHTML = `<div class="title">✨ Création…</div>`;
  view().innerHTML = `<div class="loader"><div class="spinner"></div><div class="steps" id="steps">Préparation…</div><p class="small muted">Ça prend 20 à 60 secondes.</p><p class="small muted">Modèle utilisé : <b>${esc(getModel())}</b> · app ${APP_VERSION}</p></div>`;
  const step = (m) => { const el = document.getElementById('steps'); if (el) el.textContent = m; };

  try {
    const trip = await genererVoyage(w, step);
    state.trips.push(trip); save();
    if (!licensed) await trialConsume(); // l'essai ne décompte (serveur) que sur une génération réussie
    route = { name: 'trip', tripId: trip.id }; render();
    toast('Itinéraire prêt ✅');
  } catch (e) {
    view().innerHTML = `<div class="card">
      <b>Échec de la génération</b>
      <p class="muted small mt">${esc(e.message || 'Erreur inconnue.')}</p>
      <button class="btn mt" id="retry">← Revenir au formulaire</button>
    </div>`;
    document.getElementById('retry').onclick = () => { route = { name: 'wizard' }; render(); };
  }
}

/* --- Affichage d'un itinéraire --- */
const CAT_EMOJI = { visite: '👀', repas: '🍽️', activite: '🎫', transport: '🚕', hebergement: '🏨', detente: '🌿' };
const MOMENT_LABEL = { matin: 'Matin', midi: 'Midi', 'apres-midi': 'Après-midi', soir: 'Soir' };

function nbAdultes(voyageurs) {
  if (voyageurs === 'solo') return 1;
  if (voyageurs === 'famille' || voyageurs === 'amis') return 3;
  return 2; // couple par défaut
}

/* Carte "Vols & hébergement" : l'app ne réserve pas, elle ouvre les vrais sites
   avec destination, dates et voyageurs PRÉ-REMPLIS. Gratuit, aucune API, prix réels. */
function carteReservation(t) {
  const dest = t.dest.name;
  const adultes = nbAdultes(t.voyageurs);
  const depart = (t.depart || '').trim();

  const booking = 'https://www.booking.com/searchresults.html?ss=' + encodeURIComponent(dest) +
    '&checkin=' + t.startDate + '&checkout=' + t.endDate + '&group_adults=' + adultes;
  const airbnb = 'https://www.airbnb.fr/s/' + encodeURIComponent(dest) + '/homes?checkin=' +
    t.startDate + '&checkout=' + t.endDate + '&adults=' + adultes;

  // Vols : Kayak se pré-remplit vraiment, mais il faut les codes aéroport (IATA).
  const oa = t.iata_depart, da = t.iata_arrivee;
  let volsHtml;
  if (oa && da) {
    const kayak = 'https://www.kayak.fr/flights/' + oa + '-' + da + '/' + t.startDate + '/' + t.endDate + '?sort=bestflight_a';
    const gflights = 'https://www.google.com/travel/flights?q=' +
      encodeURIComponent('vols ' + oa + ' ' + da + ' ' + t.startDate + ' retour ' + t.endDate);
    volsHtml = `<div class="small muted mt">✈️ Vols ${esc(oa)} → ${esc(da)}${depart ? ' (depuis ' + esc(depart) + ')' : ''}</div>
      <a class="btn mt" href="${kayak}" target="_blank" rel="noopener">Kayak (pré-rempli)</a>
      <a class="btn ghost mt" href="${gflights}" target="_blank" rel="noopener">Google Flights</a>`;
  } else {
    // Pas de code aéroport (ancien voyage ou ville non reconnue) : recherche simple.
    const gflights = 'https://www.google.com/travel/flights?q=' +
      encodeURIComponent('vols ' + (depart ? depart + ' ' : '') + dest);
    volsHtml = `<div class="small muted mt">✈️ Vols</div>
      <a class="btn mt" href="${gflights}" target="_blank" rel="noopener">Chercher un vol (Google Flights)</a>
      <p class="small muted mt">Codes aéroport indisponibles : régénère l'itinéraire avec une ville de départ pour un lien Kayak pré-rempli.</p>`;
  }

  return `<div class="card">
    <b>🧳 Vols & hébergement</b>
    ${t.budget_estime ? `<p class="small mt" style="color:var(--accent2)">💶 ${esc(t.budget_estime)}</p>` : ''}
    <p class="small muted mt">Boussole ne réserve pas à ta place : ces liens ouvrent les vrais sites avec tes dates déjà remplies. Prix réels, tu réserves toi-même.</p>
    ${volsHtml}
    <div class="small muted mt2">🏨 Hébergement (${adultes} voyageur(s))</div>
    <a class="btn mt" href="${booking}" target="_blank" rel="noopener">Booking.com</a>
    <a class="btn ghost mt" href="${airbnb}" target="_blank" rel="noopener">Airbnb</a>
  </div>`;
}

function renderTrip() {
  const t = state.trips.find(x => x.id === route.tripId);
  if (!t) { route = { name: 'home' }; render(); return; }

  topbar().innerHTML = `
    <button class="iconbtn" id="back">←</button>
    <div class="title" style="margin-left:8px">${flagEmoji(t.dest.cc)} ${esc(t.dest.name)}</div>
    <div class="spacer"></div>
    <button class="iconbtn" id="menu">⋯</button>`;
  document.getElementById('back').onclick = () => { route = { name: 'home' }; render(); };
  document.getElementById('menu').onclick = () => tripMenu(t);

  const score = scoreFiabilite(t);
  let html = `<div class="card">
    <div class="muted small">${humanRange(t.startDate, t.endDate)} · ${t.voyageurs} · ${t.jours.length} jour(s)</div>
    ${t.resume ? `<p class="mt">${esc(t.resume)}</p>` : ''}
    ${score != null ? `<div class="score mt2">
      <div class="big">${score}%</div>
      <div class="bar"><span style="width:${score}%"></span></div>
      <div class="small muted">lieux<br>vérifiés</div>
    </div>
    <p class="small muted mt">✅ vérifié sur OpenStreetMap · ⚠️ à confirmer sur place</p>` : ''}
  </div>`;

  html += carteReservation(t);

  t.jours.forEach((j, idx) => {
    const iso = fmtISO(addDays(parseISO(t.startDate), idx));
    const wx = t.weather[iso];
    html += `<div class="day">
      <div class="day-head">
        <div class="day-num">${idx + 1}</div>
        <div>
          <div class="day-title">${esc(j.titre || 'Jour ' + (idx + 1))}</div>
          <div class="small muted">${humanDayFull(iso)}</div>
        </div>
        ${wx ? `<div class="day-weather">${weatherEmoji(wx.code)} ${Math.round(wx.tmin)}°/${Math.round(wx.tmax)}°</div>` : ''}
      </div>`;
    (j.activites || []).forEach(a => {
      const badge = a.verifie === 'ok'
        ? '<span class="badge ok">✅ vérifié</span>'
        : a.verifie === 'warn' ? '<span class="badge warn">⚠️ à confirmer</span>'
          : '<span class="badge pending">· non vérifié</span>';
      const mapUrl = (a.lat && a.lon)
        ? `https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lon}#map=17/${a.lat}/${a.lon}`
        : `https://www.openstreetmap.org/search?query=${encodeURIComponent((a.lieu || a.nom) + ', ' + t.dest.name)}`;
      html += `<div class="act">
        <div class="act-top">
          <span class="act-emoji">${CAT_EMOJI[a.categorie] || '📍'}</span>
          <div style="flex:1;min-width:0">
            <div class="act-name">${esc(a.nom)}</div>
            ${a.lieu ? `<div class="act-place">📍 <a class="maplink" href="${mapUrl}" target="_blank" rel="noopener">${esc(a.lieu)}</a></div>` : ''}
          </div>
          ${badge}
        </div>
        <div class="act-meta">
          ${a.moment ? `<span>🕑 ${MOMENT_LABEL[a.moment] || a.moment}</span>` : ''}
          ${a.cout_estime ? `<span>💶 ${esc(a.cout_estime)}</span>` : ''}
        </div>
        ${a.astuce ? `<div class="act-tip">💡 ${esc(a.astuce)}</div>` : ''}
      </div>`;
    });
    html += `</div>`;
  });

  view().innerHTML = html;
}

function tripMenu(t) {
  openSheet(`
    <h2>${esc(t.dest.name)}</h2>
    <p class="small muted">${humanRange(t.startDate, t.endDate)}</p>
    <button class="btn mt2" id="m-share">📤 Partager (copier le texte)</button>
    <button class="btn mt" id="m-regen">🔄 Regénérer cet itinéraire</button>
    <button class="btn danger mt" id="m-del">🗑️ Supprimer</button>
    <button class="btn ghost mt" id="m-close">Annuler</button>`);
  document.getElementById('m-close').onclick = closeSheet;
  document.getElementById('m-share').onclick = () => { partager(t); };
  document.getElementById('m-del').onclick = () => {
    state.trips = state.trips.filter(x => x.id !== t.id); save(); closeSheet();
    route = { name: 'home' }; render(); toast('Voyage supprimé.');
  };
  document.getElementById('m-regen').onclick = () => {
    closeSheet();
    wizard = { dest: t.dest, query: t.dest.name, startDate: t.startDate, endDate: t.endDate, voyageurs: t.voyageurs, depart: t.depart || 'Lyon', budget: t.budget, interets: t.interets || [], rythme: t.rythme || 'equilibre' };
    lancerGeneration();
  };
}

function partager(t) {
  let txt = `🧭 ${t.dest.name} — ${humanRange(t.startDate, t.endDate)}\n`;
  if (t.resume) txt += t.resume + '\n';
  t.jours.forEach((j, i) => {
    txt += `\nJour ${i + 1} — ${j.titre || ''}\n`;
    (j.activites || []).forEach(a => {
      txt += `• ${a.nom}${a.lieu ? ' (' + a.lieu + ')' : ''}${a.cout_estime ? ' — ' + a.cout_estime : ''}\n`;
    });
  });
  txt += `\nCréé avec Voyage`;
  if (navigator.share) { navigator.share({ title: 'Voyage à ' + t.dest.name, text: txt }).catch(() => {}); }
  else { navigator.clipboard.writeText(txt).then(() => toast('Itinéraire copié ✅')).catch(() => toast('Copie impossible.')); closeSheet(); }
}

/* -------------------------------------------------------------------------
   8. SERVICE WORKER & DÉMARRAGE
   ------------------------------------------------------------------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => { swReg = reg; }).catch(() => {});
  });
}
document.getElementById('sheet-backdrop').addEventListener('click', closeSheet);

load();
loadTrialEmail();
render();
// Démarrage async : licence -> gate e-mail si besoin -> état d'essai serveur.
(async function boot() {
  await refreshLicence();
  if (!licensed && !hasTrialEmail()) {
    // Ni licence, ni e-mail d'essai : on demande l'e-mail avant tout (anti-reset d'essai).
    showTrialEmailGate(() => render());
    return;
  }
  if (!licensed) await trialStatus();
  render();
})();
