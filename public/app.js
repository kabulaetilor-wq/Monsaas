'use strict';
// Interface de MonSaaS. Tout le texte est inséré avec textContent : aucun HTML venant du serveur n'est interprété.
const view = document.getElementById('view');

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* réponse vide */ }
  if (!res.ok) throw new Error(data.error || 'Erreur ' + res.status);
  return data;
}

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'onclick') e.onclick = v;
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const card = (title, ...kids) => h('div', { class: 'card' }, title ? h('h2', {}, title) : '', ...kids);
const fmt = (ts) => new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function show(...nodes) {
  view.replaceChildren(...nodes);
}

async function refreshBanner() {
  try {
    const s = await api('/api/status');
    document.getElementById('banner').hidden = !s.maintenance;
  } catch (e) { /* ignoré */ }
}

// ------------------------------------------------------------ connexion
function authView() {
  let register = false;
  const err = h('div', { class: 'err' });
  const name = h('input', { autocomplete: 'name' });
  const email = h('input', { type: 'email', autocomplete: 'email' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password' });
  const nameRow = h('div', {}, h('label', {}, 'Votre nom'), name);
  const title = h('h2', {}, 'Connexion');
  const go = h('button', {}, 'Se connecter');
  const swap = h('button', { class: 'o' }, 'Créer un compte');

  function paint() {
    nameRow.hidden = !register;
    title.textContent = register ? 'Créer un compte' : 'Connexion';
    go.textContent = register ? 'Créer mon compte' : 'Se connecter';
    swap.textContent = register ? "J'ai déjà un compte" : 'Créer un compte';
  }
  swap.onclick = () => { register = !register; err.textContent = ''; paint(); };
  go.onclick = async () => {
    err.textContent = '';
    go.disabled = true;
    try {
      await api(register ? '/api/register' : '/api/login',
        { name: name.value, email: email.value, password: pass.value });
      start();
    } catch (e) {
      err.textContent = e.message;
    } finally {
      go.disabled = false;
    }
  };
  paint();
  show(card(null, title, nameRow, h('label', {}, 'Email'), email, h('label', {}, 'Mot de passe (8 caractères min.)'), pass, err, go, swap));
}

// ------------------------------------------------------------ utilisateur
async function homeView(me) {
  document.getElementById('who').textContent = me.name + (me.role === 'admin' ? ' (admin)' : '');
  const logout = h('button', { class: 'o' }, 'Se déconnecter');
  logout.onclick = async () => { await api('/api/logout', {}); start(); };
  const nodes = [];

  const access = card('Espace premium');
  if (me.granted || me.role === 'admin') {
    const out = h('p', {});
    const open = h('button', {}, "Ouvrir l'espace premium");
    open.onclick = async () => {
      try { const r = await api('/api/premium'); out.textContent = r.content; } catch (e) { out.textContent = e.message; }
    };
    access.append(h('p', { class: 'ok' }, 'Accès accordé ✓'), open, out);
  } else if (me.request && me.request.state === 'pending') {
    access.append(h('p', { class: 'warn' }, "Demande en attente de validation…"),
      h('p', { class: 'small' }, 'Motif : ' + me.request.reason));
    const refresh = h('button', { class: 'o' }, 'Actualiser');
    refresh.onclick = start;
    access.append(refresh);
  } else {
    if (me.request && me.request.state === 'refused') access.append(h('p', { class: 'down' }, 'Votre dernière demande a été refusée.'));
    const reason = h('textarea', { rows: '3', maxlength: '300' });
    const err = h('div', { class: 'err' });
    const send = h('button', {}, "Demander l'accès");
    send.onclick = async () => {
      err.textContent = '';
      try { await api('/api/request-access', { reason: reason.value }); start(); } catch (e) { err.textContent = e.message; }
    };
    access.append(h('label', {}, "Pourquoi avez-vous besoin de l'accès ?"), reason, err, send);
  }
  nodes.push(access);
  if (me.role === 'admin') nodes.push(await adminView());
  nodes.push(logout);
  show(...nodes);
}

// ------------------------------------------------------------ administration
async function adminView() {
  const s = await api('/api/admin/state');
  const dot = (ok) => h('span', { class: ok ? 'ok' : 'warn' }, ok ? 'oui' : 'non');
  const box = card('Administration');

  const maint = h('button', { class: 'o' }, s.maintenance ? 'Désactiver la maintenance' : 'Activer la maintenance');
  maint.onclick = async () => { await api('/api/admin/maintenance', { enabled: !s.maintenance }); start(); };
  const outage = h('button', { class: 'o' }, s.outage ? 'Terminer la panne simulée' : 'Simuler une panne');
  outage.onclick = async () => { await api('/api/admin/outage', { enabled: !s.outage }); start(); };
  const test = h('button', { class: 'o' }, 'Envoyer un test à SaaS H');
  test.onclick = async () => { await api('/api/admin/test', {}); start(); };

  box.append(
    h('p', { class: 'small' }, 'Version ' + s.version + ' · maintenance : ' + (s.maintenance ? 'active' : 'inactive') +
      ' · panne simulée : ' + (s.outage ? 'oui' : 'non')),
    h('p', { class: 'small' }, 'Connexion à SaaS H — webhook : ', dot(s.saash.webhook), ' · rappel signé : ', dot(s.saash.callback), ' · API : ', dot(s.saash.api)),
    maint, outage, test,
    h('h2', { style: 'margin-top:18px' }, 'Utilisateurs'),
    h('table', {}, ...s.users.map((u) => h('tr', {}, h('td', {}, u.name), h('td', {}, u.email), h('td', {}, u.granted ? 'accès ✓' : '—')))),
    h('h2', { style: 'margin-top:18px' }, 'Journal'),
    ...s.logs.slice(0, 15).map((l) => h('div', { class: 'log' }, fmt(l.ts) + '  ' + l.text))
  );
  return box;
}

// ------------------------------------------------------------ démarrage
async function start() {
  refreshBanner();
  try {
    const me = await api('/api/me');
    await homeView(me);
  } catch (e) {
    document.getElementById('who').textContent = '';
    authView();
  }
}
start();
setInterval(refreshBanner, 20000);
