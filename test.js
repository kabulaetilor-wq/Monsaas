'use strict';
// Test de bout en bout : lance MonSaaS contre un FAUX SaaS H local et vérifie toute la connexion.
//   node test.js
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MOCK = 19101;
const APP = 19102;
const API_KEY = 'sk_test';
const TOKEN = 'tok-gestion';
const mock = { webhooks: [], puts: [], maint: false };

// ---- faux SaaS H
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/webhooks/tok') {
      mock.webhooks.push(JSON.parse(body));
      return res.end('{"ok":true}');
    }
    if (req.url.startsWith('/v1/controls/maintenance')) {
      if (req.headers['x-api-key'] !== API_KEY) { res.writeHead(401); return res.end('{}'); }
      if (req.method === 'GET') return res.end(JSON.stringify({ code: 'maintenance', type: 'switch', on: mock.maint }));
      if (req.method === 'PUT') { const b = JSON.parse(body); mock.puts.push(b); mock.maint = b.on; return res.end('{"ok":true}'); }
    }
    res.writeHead(404); res.end('{}');
  });
});

// ---- outils
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
  return null;
}
function client() {
  let cookie = '';
  return async (method, p, body, headers) => {
    const res = await fetch('http://127.0.0.1:' + APP + p, {
      method,
      headers: Object.assign({}, body !== undefined ? { 'Content-Type': 'application/json' } : {}, cookie ? { Cookie: cookie } : {}, headers || {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) { const c = sc.split(';')[0]; cookie = c === 'sid=' ? '' : c; }
    let data = null;
    try { data = await res.json(); } catch (e) { /* vide */ }
    return { status: res.status, data };
  };
}
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', API_KEY).update(raw).digest('hex');
const mgmt = (c, method, p, body) => c(method, p, body, { Authorization: 'Bearer ' + TOKEN });
const countType = (t) => mock.webhooks.filter((w) => w.type === t).length;

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    const ok = await fn();
    if (ok === false) throw new Error('condition fausse');
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name + ' — ' + e.message);
  }
}
const eq = (a, b) => { if (a !== b) throw new Error('attendu ' + JSON.stringify(b) + ', reçu ' + JSON.stringify(a)); return true; };

(async () => {
  await new Promise((r) => mockServer.listen(MOCK, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monsaas-'));
  const app = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(APP), API_TOKEN: TOKEN, ADMIN_EMAIL: 'admin@x.com', DATA_FILE: path.join(dir, 'data.json'),
      SAASH_WEBHOOK_URL: 'http://127.0.0.1:' + MOCK + '/webhooks/tok', SAASH_URL: 'http://127.0.0.1:' + MOCK,
      SAASH_API_KEY: API_KEY, POLL_MS: '300',
    }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const up = await waitFor(async () => { try { return (await fetch('http://127.0.0.1:' + APP + '/health')).ok; } catch (e) { return false; } }, 8000);
  if (!up) { console.log('Le serveur ne démarre pas'); app.kill(); process.exit(1); }

  const admin = client();
  const bob = client();
  const anon = client();
  let bobReq;

  console.log('\nSanté et comptes');
  await check('GET /health répond 200', async () => eq((await anon('GET', '/health')).status, 200));
  await check("l'admin (email ADMIN_EMAIL) est créé avec le rôle admin", async () => {
    const r = await admin('POST', '/api/register', { name: 'Admin', email: 'admin@x.com', password: 'motdepasse1' });
    eq(r.status, 200); return eq(r.data.role, 'admin');
  });
  await check('un utilisateur normal est créé', async () => {
    const r = await bob('POST', '/api/register', { name: 'Bob', email: 'bob@x.com', password: 'motdepasse2' });
    eq(r.status, 200); return eq(r.data.role, 'user');
  });
  await check('mot de passe trop court refusé', async () => eq((await anon('POST', '/api/register', { name: 'X', email: 'x@x.com', password: '123' })).status, 400));
  await check('email déjà utilisé refusé', async () => eq((await anon('POST', '/api/register', { name: 'B', email: 'bob@x.com', password: 'motdepasse2' })).status, 409));
  await check('POST sans Content-Type JSON refusé (anti-CSRF)', async () => {
    const res = await fetch('http://127.0.0.1:' + APP + '/api/login', { method: 'POST', body: 'a=b', headers: { 'Content-Type': 'text/plain' } });
    return eq(res.status, 415);
  });
  await check("l'espace premium est interdit sans accès", async () => eq((await bob('GET', '/api/premium')).status, 403));

  console.log('\nDemande d\'accès → SaaS H');
  await check("la demande d'accès arrive dans SaaS H avec une référence", async () => {
    const r = await bob('POST', '/api/request-access', { reason: 'Besoin du rapport' });
    eq(r.status, 201);
    bobReq = await waitFor(() => mock.webhooks.find((w) => w.type === 'access_request'));
    if (!bobReq) throw new Error('aucun webhook reçu');
    eq(bobReq.user, 'Bob'); eq(bobReq.reason, 'Besoin du rapport'); return eq(bobReq.ref, String(r.data.request.id));
  });
  await check('une 2e demande en attente est refusée', async () => eq((await bob('POST', '/api/request-access', { reason: 'encore' })).status, 409));

  console.log('\nDécision de SaaS H (rappel signé)');
  const decision = (state, extra) => JSON.stringify(Object.assign({ type: 'request_decided', state, user: 'Bob', ref: bobReq.ref, by: 'Marie', ts: Date.now() }, extra || {}));
  await check('rappel sans signature refusé', async () => {
    const res = await fetch('http://127.0.0.1:' + APP + '/saash/callback', { method: 'POST', body: decision('accepted') });
    return eq(res.status, 401);
  });
  await check('rappel avec mauvaise signature refusé', async () => {
    const res = await fetch('http://127.0.0.1:' + APP + '/saash/callback', { method: 'POST', headers: { 'X-SaaSH-Signature': 'sha256=' + '0'.repeat(64) }, body: decision('accepted') });
    return eq(res.status, 401);
  });
  await check('rappel ancien (rejeu) refusé', async () => {
    const raw = decision('accepted', { ts: Date.now() - 3600 * 1000 });
    const res = await fetch('http://127.0.0.1:' + APP + '/saash/callback', { method: 'POST', headers: { 'X-SaaSH-Signature': sign(raw) }, body: raw });
    return eq(res.status, 400);
  });
  await check("rappel signé « accepté » donne l'accès à Bob", async () => {
    const raw = decision('accepted');
    const res = await fetch('http://127.0.0.1:' + APP + '/saash/callback', { method: 'POST', headers: { 'X-SaaSH-Signature': sign(raw) }, body: raw });
    eq(res.status, 200);
    eq((await bob('GET', '/api/me')).data.granted, true);
    return eq((await bob('GET', '/api/premium')).status, 200);
  });
  await check('la même décision rejouée est ignorée sans erreur', async () => {
    const raw = decision('refused');
    const res = await fetch('http://127.0.0.1:' + APP + '/saash/callback', { method: 'POST', headers: { 'X-SaaSH-Signature': sign(raw) }, body: raw });
    eq(res.status, 200);
    return eq((await bob('GET', '/api/me')).data.granted, true);
  });

  console.log('\nAPI de gestion (boutons de SaaS H)');
  await check('sans jeton : 401', async () => eq((await anon('POST', '/deploy', {})).status, 401));
  await check('mauvais jeton : 401', async () => eq((await anon('POST', '/deploy', {}, { Authorization: 'Bearer faux' })).status, 401));
  await check('/deploy incrémente la version', async () => eq((await mgmt(anon, 'POST', '/deploy')).data.version, '1.0.1'));
  await check('/backup crée un fichier', async () => {
    const r = await mgmt(anon, 'POST', '/backup');
    eq(r.status, 200); return fs.existsSync(path.join(dir, 'backups', r.data.file));
  });
  await check('/cache/clear fonctionne', async () => eq((await mgmt(anon, 'POST', '/cache/clear')).data.ok, true));
  await check('/reports/send renvoie un rapport', async () => eq((await mgmt(anon, 'POST', '/reports/send')).data.report.users, 2));
  await check('/export ne contient aucun mot de passe', async () => {
    const r = await mgmt(anon, 'GET', '/export');
    eq(r.status, 200); return !JSON.stringify(r.data).match(/hash|salt|password/i);
  });
  await check('/users/invite accepte un email valide, refuse un invalide', async () => {
    eq((await mgmt(anon, 'POST', '/users/invite', { email: 'nouveau@x.com' })).status, 200);
    return eq((await mgmt(anon, 'POST', '/users/invite', { email: 'pasunemail' })).status, 400);
  });
  await check('un utilisateur invité a accès dès son inscription', async () => {
    const c = client();
    const r = await c('POST', '/api/register', { name: 'Nouveau', email: 'nouveau@x.com', password: 'motdepasse3' });
    return eq(r.data.granted, true);
  });
  await check('JSON invalide : 400', async () => {
    const res = await fetch('http://127.0.0.1:' + APP + '/maintenance', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: '{pas du json' });
    return eq(res.status, 400);
  });
  await check('/access/revoke retire l\'accès de Bob', async () => {
    eq((await mgmt(anon, 'POST', '/access/revoke', { email: 'bob@x.com' })).status, 200);
    eq((await bob('GET', '/api/premium')).status, 403);
    return eq((await mgmt(anon, 'POST', '/access/revoke', { email: 'inconnu@x.com' })).status, 404);
  });

  console.log('\nUsage → SaaS H');
  await check('la déconnexion envoie la durée de session', async () => {
    const before = countType('usage');
    await bob('POST', '/api/logout', {});
    const ev = await waitFor(() => (countType('usage') > before ? mock.webhooks.filter((w) => w.type === 'usage').pop() : null));
    if (!ev) throw new Error('pas de webhook usage');
    eq(ev.user, 'Bob'); return ev.minutes >= 1;
  });
  await check('/restart ferme les sessions et envoie leur usage', async () => {
    const before = countType('usage');
    const r = await mgmt(anon, 'POST', '/restart');
    eq(r.status, 200);
    eq((await admin('GET', '/api/me')).status, 401);
    const ok = await waitFor(() => countType('usage') > before);
    return !!ok;
  });

  console.log('\nPannes → SaaS H');
  await admin('POST', '/api/login', { email: 'admin@x.com', password: 'motdepasse1' });
  await check('panne simulée : /health 503 + incident envoyé', async () => {
    eq((await admin('POST', '/api/admin/outage', { enabled: true })).status, 200);
    eq((await anon('GET', '/health')).status, 503);
    const ev = await waitFor(() => mock.webhooks.find((w) => w.type === 'incident'));
    return !!ev;
  });
  await check('fin de panne : /health 200 + « resolved » envoyé', async () => {
    await admin('POST', '/api/admin/outage', { enabled: false });
    eq((await anon('GET', '/health')).status, 200);
    return !!(await waitFor(() => mock.webhooks.find((w) => w.type === 'resolved')));
  });
  await check("un non-admin ne peut pas utiliser l'administration", async () => {
    await bob('POST', '/api/login', { email: 'bob@x.com', password: 'motdepasse2' });
    return eq((await bob('POST', '/api/admin/outage', { enabled: true })).status, 403);
  });

  console.log('\nMaintenance (interrupteur de SaaS H)');
  await check('/maintenance depuis SaaS H bloque les utilisateurs, pas l\'admin', async () => {
    mock.maint = true; // SaaS H a basculé son interrupteur
    eq((await mgmt(anon, 'POST', '/maintenance', { enabled: true })).data.maintenance, true);
    eq((await anon('GET', '/health')).data.maintenance, true);
    eq((await bob('GET', '/api/premium')).status, 503);
    const c = client();
    eq((await c('POST', '/api/login', { email: 'bob@x.com', password: 'motdepasse2' })).status, 503);
    return eq((await c('POST', '/api/login', { email: 'admin@x.com', password: 'motdepasse1' })).status, 200);
  });
  await check('/maintenance sans booléen : 400', async () => eq((await mgmt(anon, 'POST', '/maintenance', {})).status, 400));
  await check('rappel « switch maintenance=false » rétablit le service', async () => {
    mock.maint = false;
    const raw = JSON.stringify({ type: 'switch', code: 'maintenance', on: false, by: 'Marie', ts: Date.now() });
    const res = await fetch('http://127.0.0.1:' + APP + '/saash/callback', { method: 'POST', headers: { 'X-SaaSH-Signature': sign(raw) }, body: raw });
    eq(res.status, 200);
    return eq((await anon('GET', '/health')).data.maintenance, false);
  });
  await check("l'interrupteur de SaaS H est lu régulièrement (synchronisation)", async () => {
    mock.maint = true;
    const on = await waitFor(async () => (await anon('GET', '/health')).data.maintenance === true, 5000);
    if (!on) throw new Error('maintenance non synchronisée');
    mock.maint = false;
    return !!(await waitFor(async () => (await anon('GET', '/health')).data.maintenance === false, 5000));
  });
  await check("la maintenance activée dans MonSaaS met à jour SaaS H", async () => {
    mock.puts.length = 0;
    await admin('POST', '/api/admin/maintenance', { enabled: true });
    const put = await waitFor(() => mock.puts.find((p) => p.on === true));
    await admin('POST', '/api/admin/maintenance', { enabled: false });
    return !!put && !!(await waitFor(() => mock.maint === false));
  });

  console.log('\nSécurité');
  await check('10 mauvais mots de passe → 429', async () => {
    const c = client();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await c('POST', '/api/login', { email: 'victime@x.com', password: 'faux' + i })).status;
    return eq(last, 429);
  });
  await check('corps trop gros : 413', async () => {
    try {
      const res = await fetch('http://127.0.0.1:' + APP + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(200000) }) });
      return eq(res.status, 413);
    } catch (e) { return true; } // connexion coupée par le serveur : acceptable
  });
  await check('le texte saisi par un utilisateur n\'est jamais interprété comme HTML (textContent)', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
    return !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src);
  });

  console.log('\n' + passed + ' réussis, ' + failed + ' échoués');
  app.kill('SIGTERM');
  mockServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
