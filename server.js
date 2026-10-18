'use strict';
/**
 * MonSaaS — un petit SaaS d'exemple connecté à SaaS H.
 * Node.js 18+, aucune dépendance.
 *
 * Ce que fait ce SaaS :
 *  - comptes utilisateurs, et un « Espace premium » accessible après acceptation d'une demande d'accès ;
 *  - envoie à SaaS H : demandes d'accès, usage (durée des sessions), pannes, événements (webhook) ;
 *  - expose une API de gestion que les boutons de SaaS H appellent (redémarrer, déployer, sauvegarder, ...) ;
 *  - expose /health, contrôlé par SaaS H toutes les minutes ;
 *  - reçoit les décisions (accepté / refusé) de SaaS H via un rappel signé ;
 *  - se synchronise avec l'interrupteur « maintenance » de SaaS H.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = {
  port: Number(process.env.PORT) || 3000,
  apiToken: process.env.API_TOKEN || crypto.randomBytes(16).toString('hex'),
  webhook: process.env.SAASH_WEBHOOK_URL || '',
  saashUrl: (process.env.SAASH_URL || '').replace(/\/+$/, ''),
  saashKey: process.env.SAASH_API_KEY || '',
  maintCode: process.env.SAASH_MAINT_CODE || 'maintenance',
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'data.json'),
  pollMs: Number(process.env.POLL_MS) || 15000,
};
if (!process.env.API_TOKEN) {
  console.log('API_TOKEN non défini. Jeton temporaire (démo uniquement) : ' + cfg.apiToken);
}

// ---------------------------------------------------------------- données
const defaults = () => ({
  users: [], requests: [], invites: [], maintenance: false,
  version: '1.0.0', logs: [], nextId: 1, cacheEntries: 0,
});

function loadDb() {
  try {
    return Object.assign(defaults(), JSON.parse(fs.readFileSync(cfg.dataFile, 'utf8')));
  } catch (e) {
    return defaults();
  }
}

const db = loadDb();
const runtime = { outage: false, startedAt: Date.now() };
const sessions = new Map(); // jeton -> { userId, start }
let saveTimer = null;

function saveNow() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(path.dirname(cfg.dataFile), { recursive: true });
    const tmp = cfg.dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, cfg.dataFile);
  } catch (e) {
    console.error('Sauvegarde impossible :', e.message);
  }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 200);
}
function log(text) {
  db.logs.unshift({ ts: Date.now(), text });
  if (db.logs.length > 50) db.logs.length = 50;
  save();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextId = () => db.nextId++;

// ---------------------------------------------------------------- mots de passe
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(pw, user) {
  const got = crypto.scryptSync(pw, user.salt, 64);
  const exp = Buffer.from(user.hash, 'hex');
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}

// ---------------------------------------------------------------- vers SaaS H
/** Envoie un événement à SaaS H (lien webhook). Ne bloque jamais l'utilisateur. */
async function notifySaasH(payload) {
  if (!cfg.webhook) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(cfg.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000), // un serveur gratuit peut mettre du temps à se réveiller
      });
      if (res.ok) {
        log('→ SaaS H : ' + payload.type + ' envoyé');
        return true;
      }
      log('→ SaaS H : HTTP ' + res.status + ' (' + payload.type + ')');
    } catch (e) {
      log('→ SaaS H : échec (' + e.message + ')');
    }
    if (attempt === 0) await sleep(3000);
  }
  return false;
}

/** Met à jour l'interrupteur « maintenance » de SaaS H (clé API). */
async function pushSwitch(on) {
  if (!cfg.saashUrl || !cfg.saashKey) return;
  try {
    await fetch(cfg.saashUrl + '/v1/controls/' + encodeURIComponent(cfg.maintCode) + '/state', {
      method: 'PUT',
      headers: { 'X-Api-Key': cfg.saashKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    log('→ SaaS H : interrupteur non mis à jour (' + e.message + ')');
  }
}

/** Lit l'interrupteur « maintenance » de SaaS H et s'aligne dessus. */
async function syncMaintenance() {
  if (!cfg.saashUrl || !cfg.saashKey) return;
  try {
    const res = await fetch(cfg.saashUrl + '/v1/controls/' + encodeURIComponent(cfg.maintCode), {
      headers: { 'X-Api-Key': cfg.saashKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const body = await res.json();
    if (typeof body.on === 'boolean' && body.on !== db.maintenance) setMaintenance(body.on, 'saash');
  } catch (e) {
    // SaaS H injoignable : on garde l'état actuel
  }
}

function setMaintenance(enabled, source) {
  db.maintenance = enabled;
  log('Maintenance ' + (enabled ? 'activée' : 'désactivée') + ' (' + source + ')');
  save();
  if (source === 'admin') {
    notifySaasH({ type: 'maintenance', state: enabled ? 'on' : 'off' });
    pushSwitch(enabled);
  }
}

function setOutage(enabled) {
  runtime.outage = enabled;
  log('Panne simulée ' + (enabled ? 'activée' : 'désactivée'));
  notifySaasH(enabled ? { type: 'incident', title: 'Panne simulée dans MonSaaS' } : { type: 'resolved' });
}

// ---------------------------------------------------------------- aides HTTP
function send(res, status, obj, headers) {
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(JSON.stringify(obj));
}
const fail = (status, message) => Object.assign(new Error(message), { status });

function readBody(req, limit) {
  limit = limit || 100000;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(fail(413, 'Corps trop gros'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJson(buf) {
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) {
    throw fail(400, 'JSON invalide');
  }
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function bearerOk(req) {
  const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(cfg.apiToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- sessions
const SESSION_MS = 8 * 3600 * 1000;

function endSession(token) {
  const s = sessions.get(token);
  if (!s) return;
  sessions.delete(token);
  const u = db.users.find((x) => x.id === s.userId);
  const minutes = Math.max(1, Math.round((Date.now() - s.start) / 60000));
  if (u) notifySaasH({ type: 'usage', user: u.name, minutes });
}

function currentUser(req) {
  const token = cookies(req).sid;
  const s = token && sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.start > SESSION_MS) {
    endSession(token);
    return null;
  }
  return db.users.find((u) => u.id === s.userId) || null;
}

function startSession(req, res, user, extra) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId: user.id, start: Date.now() });
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  send(res, 200, extra || publicUser(user), {
    'Set-Cookie': 'sid=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + SESSION_MS / 1000 + secure,
  });
}

const publicUser = (u) => {
  const last = db.requests.filter((r) => r.userId === u.id).pop();
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, granted: !!u.granted,
    request: last ? { id: last.id, state: last.state, reason: last.reason } : null,
  };
};

// limitation des essais de connexion
const attempts = new Map();
function tooManyAttempts(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.since > 10 * 60000) return false;
  return a.n >= 10;
}
function recordFailure(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.since > 10 * 60000) attempts.set(key, { n: 1, since: Date.now() });
  else a.n++;
}

// ---------------------------------------------------------------- fichiers statiques
const PUBLIC = path.join(__dirname, 'public');
const statics = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
const cache = {};
function serveStatic(res, p) {
  const [file, type] = statics[p];
  if (!cache[file]) cache[file] = fs.readFileSync(path.join(PUBLIC, file));
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(cache[file]);
}

// ---------------------------------------------------------------- signature des rappels SaaS H
function verifySignature(raw, header) {
  if (!cfg.saashKey || !header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', cfg.saashKey).update(raw).digest('hex');
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

// ---------------------------------------------------------------- routes
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && statics[p]) return serveStatic(res, p);

  // --- santé : appelée par SaaS H toutes les minutes
  if (m === 'GET' && p === '/health') {
    if (runtime.outage) return send(res, 503, { ok: false, error: 'panne simulée' });
    return send(res, 200, {
      ok: true, maintenance: db.maintenance, version: db.version,
      uptime: Math.round((Date.now() - runtime.startedAt) / 1000),
    });
  }

  // --- rappel signé de SaaS H
  if (m === 'POST' && p === '/saash/callback') {
    const raw = await readBody(req);
    if (!cfg.saashKey) throw fail(503, 'SAASH_API_KEY non configurée');
    if (!verifySignature(raw, req.headers['x-saash-signature'])) throw fail(401, 'Signature invalide');
    const b = parseJson(raw);
    if (typeof b.ts === 'number' && Math.abs(Date.now() - b.ts) > 10 * 60000) throw fail(400, 'Message trop ancien');
    handleCallback(b);
    return send(res, 200, { ok: true });
  }

  // --- API de gestion : appelée par les boutons de SaaS H (Authorization: Bearer <API_TOKEN>)
  if (['/restart', '/deploy', '/backup', '/cache/clear', '/maintenance', '/reports/send',
    '/users/invite', '/access/revoke', '/export'].includes(p)) {
    if (!bearerOk(req)) throw fail(401, 'Jeton invalide');
    return management(req, res, p, m);
  }

  // --- API de l'interface
  if (p.startsWith('/api/')) return api(req, res, p, m);

  throw fail(404, 'Introuvable');
}

function handleCallback(b) {
  if (b.type === 'request_decided') {
    const r = db.requests.find((x) => x.id === Number(b.ref) && x.state === 'pending');
    if (!r) return log('← SaaS H : décision ignorée (demande ' + str(String(b.ref), 20) + ')');
    const accepted = b.state === 'accepted';
    r.state = accepted ? 'accepted' : 'refused';
    const u = db.users.find((x) => x.id === r.userId);
    if (u && accepted) u.granted = true;
    log('← SaaS H : demande #' + r.id + ' ' + (accepted ? 'acceptée' : 'refusée') + ' par ' + str(b.by, 60));
    save();
  } else if (b.type === 'switch' && b.code === cfg.maintCode && typeof b.on === 'boolean') {
    setMaintenance(b.on, 'saash');
  } else {
    log('← SaaS H : ' + str(b.type, 30) + ' ' + str(b.code, 40));
  }
}

async function management(req, res, p, m) {
  const body = parseJson(await readBody(req));
  if (p === '/export' && m === 'GET') {
    return send(res, 200, {
      users: db.users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, granted: !!u.granted })),
      requests: db.requests, version: db.version,
    });
  }
  if (m !== 'POST') throw fail(405, 'Méthode non autorisée');

  switch (p) {
    case '/restart': {
      const n = sessions.size;
      for (const t of Array.from(sessions.keys())) endSession(t);
      runtime.startedAt = Date.now();
      log('Redémarrage demandé : ' + n + ' session(s) fermée(s)');
      return send(res, 200, { ok: true, message: 'Redémarré', sessionsClosed: n });
    }
    case '/deploy': {
      const parts = db.version.split('.').map(Number);
      parts[2] = (parts[2] || 0) + 1;
      db.version = parts.join('.');
      log('Déploiement : version ' + db.version);
      save();
      return send(res, 200, { ok: true, version: db.version });
    }
    case '/backup': {
      const dir = path.join(path.dirname(cfg.dataFile), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const name = 'backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      fs.writeFileSync(path.join(dir, name), JSON.stringify(db));
      const old = fs.readdirSync(dir).filter((f) => f.startsWith('backup-')).sort();
      while (old.length > 5) fs.unlinkSync(path.join(dir, old.shift()));
      log('Sauvegarde : ' + name);
      return send(res, 200, { ok: true, file: name });
    }
    case '/cache/clear': {
      const n = db.cacheEntries;
      db.cacheEntries = 0;
      log('Cache vidé (' + n + ' entrées)');
      save();
      return send(res, 200, { ok: true, cleared: n });
    }
    case '/maintenance': {
      if (typeof body.enabled !== 'boolean') throw fail(400, '« enabled » (true/false) requis');
      setMaintenance(body.enabled, 'saash');
      return send(res, 200, { ok: true, maintenance: db.maintenance });
    }
    case '/reports/send': {
      const report = {
        generatedAt: new Date().toISOString(), users: db.users.length,
        grantedUsers: db.users.filter((u) => u.granted).length,
        pendingRequests: db.requests.filter((r) => r.state === 'pending').length, version: db.version,
      };
      log('Rapport généré (' + report.users + ' utilisateurs)');
      return send(res, 200, { ok: true, report });
    }
    case '/users/invite': {
      const email = str(body.email, 120).toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'email invalide');
      if (!db.invites.includes(email)) db.invites.push(email);
      const u = db.users.find((x) => x.email === email);
      if (u) u.granted = true;
      log('Invitation : ' + email);
      save();
      return send(res, 200, { ok: true, email });
    }
    case '/access/revoke': {
      const email = str(body.email, 120).toLowerCase();
      const u = db.users.find((x) => x.email === email);
      if (!u) throw fail(404, 'Utilisateur inconnu');
      u.granted = false;
      log('Accès révoqué : ' + email);
      save();
      return send(res, 200, { ok: true, email });
    }
  }
  throw fail(404, 'Introuvable');
}

async function api(req, res, p, m) {
  if (m === 'GET' && p === '/api/status') {
    return send(res, 200, { name: 'MonSaaS', maintenance: db.maintenance, version: db.version });
  }
  if (m === 'POST' && !/application\/json/.test(req.headers['content-type'] || '')) {
    throw fail(415, 'Content-Type: application/json requis');
  }
  const body = m === 'POST' ? parseJson(await readBody(req)) : {};

  if (m === 'POST' && p === '/api/register') {
    if (db.maintenance) throw fail(503, 'Maintenance en cours');
    const name = str(body.name, 80);
    const email = str(body.email, 120).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    if (!name) throw fail(400, 'Nom requis');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'Email invalide');
    if (password.length < 8 || password.length > 200) throw fail(400, 'Mot de passe : 8 caractères minimum');
    if (db.users.some((u) => u.email === email)) throw fail(409, 'Email déjà utilisé');
    const invited = db.invites.includes(email);
    const user = Object.assign({
      id: nextId(), name, email, role: email === cfg.adminEmail ? 'admin' : 'user',
      granted: invited, createdAt: Date.now(),
    }, hashPassword(password));
    db.invites = db.invites.filter((e) => e !== email);
    db.users.push(user);
    save();
    return startSession(req, res, user);
  }

  if (m === 'POST' && p === '/api/login') {
    const email = str(body.email, 120).toLowerCase();
    const key = (req.socket.remoteAddress || '') + '|' + email;
    if (tooManyAttempts(key)) throw fail(429, 'Trop d\'essais, réessayez plus tard');
    const user = db.users.find((u) => u.email === email);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!user || !checkPassword(password, user)) {
      recordFailure(key);
      throw fail(401, 'Email ou mot de passe incorrect');
    }
    if (db.maintenance && user.role !== 'admin') throw fail(503, 'Maintenance en cours');
    attempts.delete(key);
    return startSession(req, res, user);
  }

  if (m === 'POST' && p === '/api/logout') {
    const token = cookies(req).sid;
    if (token) endSession(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  const user = currentUser(req);
  if (!user) throw fail(401, 'Non connecté');

  if (m === 'GET' && p === '/api/me') return send(res, 200, publicUser(user));

  if (db.maintenance && user.role !== 'admin') throw fail(503, 'Maintenance en cours');

  if (m === 'POST' && p === '/api/request-access') {
    if (user.granted) throw fail(409, 'Vous avez déjà accès');
    if (db.requests.some((r) => r.userId === user.id && r.state === 'pending')) throw fail(409, 'Une demande est déjà en attente');
    const reason = str(body.reason, 300);
    if (!reason) throw fail(400, 'Motif requis');
    const r = { id: nextId(), userId: user.id, reason, state: 'pending', createdAt: Date.now() };
    db.requests.push(r);
    save();
    // → SaaS H : la demande apparaît dans l'onglet « Demandes ». « ref » permet de retrouver la demande à la décision.
    notifySaasH({ type: 'access_request', user: user.name, reason, ref: String(r.id) });
    return send(res, 201, { ok: true, request: { id: r.id, state: r.state } });
  }

  if (m === 'GET' && p === '/api/premium') {
    if (!user.granted && user.role !== 'admin') throw fail(403, 'Accès non accordé');
    db.cacheEntries++;
    return send(res, 200, { title: 'Espace premium', content: 'Bienvenue ' + user.name + ' : ici se trouve le contenu réservé.' });
  }

  // --- administration locale
  if (p.startsWith('/api/admin/')) {
    if (user.role !== 'admin') throw fail(403, 'Réservé aux administrateurs');
    if (m === 'GET' && p === '/api/admin/state') {
      return send(res, 200, {
        users: db.users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, granted: !!u.granted })),
        requests: db.requests, logs: db.logs, maintenance: db.maintenance, outage: runtime.outage,
        version: db.version,
        saash: { webhook: !!cfg.webhook, callback: !!cfg.saashKey, api: !!(cfg.saashUrl && cfg.saashKey) },
      });
    }
    if (m === 'POST' && p === '/api/admin/maintenance') {
      setMaintenance(body.enabled === true, 'admin');
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/admin/outage') {
      setOutage(body.enabled === true);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/admin/test') {
      notifySaasH({ type: 'usage', user: user.name, minutes: 5 });
      return send(res, 200, { ok: true });
    }
  }
  throw fail(404, 'Introuvable');
}

// ---------------------------------------------------------------- démarrage
const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Erreur serveur' : e.message });
  }
});

if (require.main === module) {
  server.listen(cfg.port, () => console.log('MonSaaS démarré sur le port ' + cfg.port));
  if (cfg.saashUrl && cfg.saashKey) setInterval(syncMaintenance, cfg.pollMs);
  const stop = () => { saveNow(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { server, cfg };
