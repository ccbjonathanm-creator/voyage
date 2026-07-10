/* Générateur de licences Voyage — logique.
   La clé privée n'est JAMAIS dans ce fichier. Elle est saisie une fois par toi,
   chiffrée (AES-GCM, mot de passe via PBKDF2) et gardée seulement dans ce téléphone. */

const LS_VAULT = 'voyagegen.vault';
// Partie PUBLIQUE de la clé (pour vérifier que tu colles la bonne clé secrète).
const PUB = { x: 'YbDelKNMSemSopaa1U9TrTA5L4XpkkJ1BHoxOp2lzKo', y: '4INPqTfFNgy7wPwqS3_hy9z7kH5vGEFgcGp3pYSDWUE' };

const enc = new TextEncoder();
const dec = new TextDecoder();
const el = (id) => document.getElementById(id);
let signKey = null; // clé de signature en mémoire, après déverrouillage

function b64e(buf) { let s = ''; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s); }
function b64d(str) { const s = atob(str); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }

async function deriveKey(pw, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptVault(privStr, pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pw, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(privStr));
  return { v: 1, salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) };
}
async function decryptVault(vault, pw) {
  const key = await deriveKey(pw, b64d(vault.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(vault.iv) }, key, b64d(vault.ct));
  return dec.decode(pt);
}
async function importSign(privStr) {
  const jwk = JSON.parse(privStr);
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}
// normalisation IDENTIQUE à app.js (trim + minuscules)
const normEmail = (e) => (e || '').trim().toLowerCase();
async function makeLicence(email) {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, enc.encode('voyage-licence:' + normEmail(email)));
  return b64e(sig);
}

function show(screen) {
  ['setup', 'unlock', 'gen'].forEach((s) => el(s).classList.toggle('hidden', s !== screen));
}
function getVault() { try { return JSON.parse(localStorage.getItem(LS_VAULT)); } catch (e) { return null; } }

// --- Écran 1 : configuration ---
el('s-go').addEventListener('click', async () => {
  const err = el('s-err'); err.textContent = '';
  const raw = el('s-key').value.trim();
  const pw = el('s-pw').value, pw2 = el('s-pw2').value;
  let jwk;
  try { jwk = JSON.parse(raw); } catch (e) { err.textContent = 'La clé secrète est illisible (JSON invalide).'; return; }
  if (jwk.x !== PUB.x || jwk.y !== PUB.y || !jwk.d) { err.textContent = "Cette clé ne correspond pas à l'appli Voyage."; return; }
  if (pw.length < 8) { err.textContent = 'Choisis un mot de passe d’au moins 8 caractères (idéalement une longue phrase).'; return; }
  if (pw !== pw2) { err.textContent = 'Les deux mots de passe ne correspondent pas.'; return; }
  try {
    signKey = await importSign(raw);              // valide la clé
    const vault = await encryptVault(raw, pw);
    localStorage.setItem(LS_VAULT, JSON.stringify(vault));
    el('s-key').value = ''; el('s-pw').value = ''; el('s-pw2').value = '';  // efface les traces
    show('gen');
  } catch (e) { err.textContent = 'Erreur : ' + e.message; }
});

// --- Écran 2 : déverrouillage ---
el('u-go').addEventListener('click', async () => {
  const err = el('u-err'); err.textContent = '';
  const vault = getVault();
  if (!vault) { show('setup'); return; }
  try {
    const privStr = await decryptVault(vault, el('u-pw').value);
    signKey = await importSign(privStr);
    el('u-pw').value = '';
    show('gen');
  } catch (e) { err.textContent = 'Mot de passe incorrect.'; }
});
el('u-reset').addEventListener('click', () => {
  if (confirm('Effacer la clé chiffrée de ce téléphone ? Tu devras la recoller pour reconfigurer.')) {
    localStorage.removeItem(LS_VAULT); signKey = null; show('setup');
  }
});

// --- Écran 3 : génération ---
el('g-go').addEventListener('click', async () => {
  const err = el('g-err'); err.textContent = ''; el('g-out').classList.add('hidden');
  const id = el('g-id').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) { err.textContent = 'Entre un e-mail valide.'; return; }
  if (!signKey) { show('unlock'); return; }
  try {
    el('g-key').textContent = await makeLicence(id);
    el('g-out').classList.remove('hidden');
    el('g-ok').textContent = '';
  } catch (e) { err.textContent = 'Erreur : ' + e.message; }
});
el('g-copy').addEventListener('click', async () => {
  const txt = el('g-key').textContent;
  try { await navigator.clipboard.writeText(txt); el('g-ok').textContent = 'Copié ✓'; }
  catch (e) {
    const r = document.createRange(); r.selectNodeContents(el('g-key'));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    el('g-ok').textContent = 'Sélectionne et copie la clé.';
  }
});
el('g-lock').addEventListener('click', () => { signKey = null; el('g-id').value = ''; el('g-out').classList.add('hidden'); show('unlock'); });

// --- Démarrage ---
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
show(getVault() ? 'unlock' : 'setup');
