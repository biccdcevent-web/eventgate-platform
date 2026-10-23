/* Admin app: sign-in, events list, users, and each event's dashboard and backups.
   The event Settings tab lives in admin-settings.js. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = EG.esc;
  const nf = new Intl.NumberFormat('en-US');
  const ICON = {
    check: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    plus: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    warn: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 2.5 20h19L12 4z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>',
  };
  const STATUS_LABEL = { draft: 'Draft', open: 'Open', closed: 'Closed', archived: 'Archived' };

  // ------------------------------------------------------------ server calls
  async function api(path, opts) {
    const r = await fetch(path, { credentials: 'same-origin', ...opts });
    if (r.status === 401) { showLogin(); throw new Error('signed out'); }
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      if (r.status === 403 && b.mustChange && me) { showChangePassword(me); throw new Error('signed out'); }
      const e = new Error(b.message || `HTTP ${r.status}`); e.field = b.field; throw e;
    }
    return r.json();
  }
  const post = (path, body, method = 'POST') => api(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

  // ------------------------------------------------------------ dialog
  // fields: [{ id, label, type: text|password|select, value, help, options: [[value, label]] }]
  function openDialog({ title, body, fields = [], confirmWord, okLabel = 'OK', danger = false, wide = false, run, afterOpen, cancelLabel = 'Cancel' }) {
    const dlg = $('dlg');
    dlg.style.width = wide ? 'min(640px, calc(100vw - 32px))' : '';
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML = body || '';
    $('dlgErr').textContent = '';
    const all = [...fields];
    if (confirmWord) all.push({ id: 'confirm', label: `Type ${confirmWord} to confirm`, type: 'text', value: '' });
    $('dlgFields').innerHTML = all.map((f) => {
      const control = f.type === 'select'
        ? `<select id="dlg_${f.id}">${f.options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(f.value ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`
        : f.type === 'html' ? f.html
        : `<input id="dlg_${f.id}" type="${f.type || 'text'}" value="${esc(f.value || '')}" autocomplete="${f.autocomplete || 'off'}" spellcheck="false" autocapitalize="none"${f.maxlength ? ` maxlength="${f.maxlength}"` : ''}>`;
      return `<div class="field" style="margin-bottom:12px">${f.label ? `<label for="dlg_${f.id}">${esc(f.label)}</label>` : ''}${f.prefix ? `<div class="prefix"><span>${esc(f.prefix)}</span>${control}</div>` : control}${f.help ? `<p class="help" id="dlg_${f.id}_help">${esc(f.help)}</p>` : ''}</div>`;
    }).join('');
    const ok = $('dlgOk');
    ok.textContent = okLabel;
    ok.hidden = !run;
    $('dlgCancel').textContent = run ? cancelLabel : 'Close';
    ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    const word = confirmWord && $('dlg_confirm');
    const sync = () => { ok.disabled = Boolean(word) && word.value.trim().toUpperCase() !== String(confirmWord).toUpperCase(); };
    if (word) word.addEventListener('input', sync);
    sync();
    $('dlgForm').onsubmit = async (e) => {
      e.preventDefault();
      if (ok.disabled || !run) return;
      const values = Object.fromEntries(all.filter((f) => f.type !== 'html').map((f) => [f.id, $(`dlg_${f.id}`).value]));
      ok.disabled = true; $('dlgErr').textContent = '';
      try { await run(values); dlg.close(); }
      catch (err) { if (err.message !== 'signed out') $('dlgErr').textContent = err.message; }
      finally { ok.disabled = false; sync(); }
    };
    $('dlgCancel').onclick = () => dlg.close();
    dlg.showModal();
    if (afterOpen) afterOpen();
    const first = $('dlgFields').querySelector('input, select');
    if (first) first.focus(); else (run ? ok : $('dlgCancel')).focus();
  }

  // ------------------------------------------------------------ formatting
  let tz = 'Asia/Manila';
  const fmt = (opts) => (iso) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(new Date(iso));
  const timeOf = (iso) => fmt({ hour: 'numeric', minute: '2-digit' })(iso);
  const dateTimeOf = (iso) => fmt({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })(iso);
  const dayLabel = (day, long) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(long ? { weekday: 'short' } : {}) }).format(new Date(day + 'T00:00:00Z'));
  const minutesLabel = (m) => { const h = Math.floor(m / 60), mm = m % 60; return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const plural = (n, one, many) => `${nf.format(n)} ${n === 1 ? one : many}`;
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return dateTimeOf(iso);
  }

  // ------------------------------------------------------------ sign in / out
  let me = null;
  const isOwner = () => me && me.role === 'owner';
  // The platform administrator, or a client administrator (who manages only their client's events and accounts).
  const canEdit = () => me && (me.role === 'owner' || me.role === 'manager');
  const ROLE_LABEL = { owner: 'Platform admin', manager: 'Client admin', client: 'Viewer' };
  function showLogin(message) {
    try { sessionStorage.removeItem('eg_signed_in_tab'); } catch {}
    closeStream();
    if ($('dlg').open) $('dlg').close();
    $('appView').hidden = true; $('pwView').hidden = true; $('loginView').hidden = false;
    $('key').value = '';
    $('loginErr').textContent = message || '';
    ($('user').value ? $('key') : $('user')).focus();
  }
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginErr').textContent = '';
    try {
      const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: $('user').value, password: $('key').value }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { $('loginErr').textContent = body.message || 'Sign-in failed. Try again.'; return; }
      lastPassword = $('key').value;
      start(body.user);
    } catch { $('loginErr').textContent = 'The server could not be reached. Check your connection.'; }
  });
  $('signOut').addEventListener('click', async () => {
    if (!leaveOk()) return;
    await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
    history.replaceState(null, '', location.pathname);
    showLogin();
  });
  $('myPw').addEventListener('click', () => openDialog({
    title: 'Change your password',
    fields: [
      { id: 'current', label: 'Current password', type: 'password', autocomplete: 'current-password' },
      { id: 'next', label: 'New password', type: 'password', autocomplete: 'new-password', help: 'At least 8 characters.' },
      { id: 'again', label: 'New password again', type: 'password', autocomplete: 'new-password' },
    ],
    okLabel: 'Change password',
    run: async (v) => {
      if (v.next !== v.again) throw new Error('The two new passwords don’t match.');
      await post('/api/admin/me/password', { current: v.current, next: v.next });
    },
  }));

  // First sign-in with a password the administrator set: the client chooses their own before continuing.
  let lastPassword = '';
  function showChangePassword(user) {
    closeStream();
    if ($('dlg').open) $('dlg').close();
    $('appView').hidden = true; $('loginView').hidden = true; $('pwView').hidden = false;
    $('pwIntro').textContent = `Welcome, ${user.name}. You signed in with a temporary password from the event administrator. Choose your own password to continue.`;
    $('pwCur').value = lastPassword; $('pwNew').value = ''; $('pwAgain').value = ''; $('pwErr').textContent = '';
    ($('pwCur').value ? $('pwNew') : $('pwCur')).focus();
  }
  $('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('pwErr').textContent = '';
    if ($('pwNew').value !== $('pwAgain').value) { $('pwErr').textContent = 'The two new passwords don’t match.'; return; }
    try {
      const r = await fetch('/api/admin/me/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current: $('pwCur').value, next: $('pwNew').value }) });
      const body = await r.json().catch(() => ({}));
      if (r.status === 401) return showLogin('Your session ended. Sign in again with the temporary password.');
      if (!r.ok) { $('pwErr').textContent = body.message || 'The password could not be changed. Try again.'; return; }
      lastPassword = '';
      $('pwView').hidden = true;
      start({ ...me, mustChange: false });
    } catch { $('pwErr').textContent = 'The server could not be reached. Check your connection.'; }
  });
  $('pwSignOut').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  async function start(user) {
    try { sessionStorage.setItem('eg_signed_in_tab', '1'); } catch {}
    me = user;
    if (me.mustChange) return showChangePassword(me);
    $('pwView').hidden = true;
    document.documentElement.dataset.role = me.role;
    document.documentElement.dataset.charts = me.canCharts ? 'yes' : 'no';
    $('loginView').hidden = true; $('appView').hidden = false;
    $('whoName').textContent = me.name;
    $('whoRole').textContent = ROLE_LABEL[me.role] || 'Viewer';
    $('whoRole').title = me.clientName || '';
    $('whoName').textContent = me.clientName ? `${me.name} (${me.clientName})` : me.name;
    $('myPw').hidden = isOwner();
    document.querySelectorAll('[data-owner]').forEach((el) => { el.hidden = !isOwner(); });
    document.querySelectorAll('[data-editor]').forEach((el) => { el.hidden = !canEdit(); });
    $('hostLabel').textContent = `${location.host}/`;
    await route();
  }

  // ------------------------------------------------------------ routing
  let lastHash = location.hash;
  let leaveGuard = null;           // set by the settings editor while there are unsaved changes
  const leaveOk = () => !leaveGuard || leaveGuard();
  window.addEventListener('beforeunload', (e) => { if (leaveGuard && !leaveGuard(true)) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('hashchange', () => {
    if (!me) return;
    if (!leaveOk()) { history.replaceState(null, '', lastHash || '#/'); return; }
    route();
  });

  let events = [];
  async function route() {
    lastHash = location.hash;
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/').filter(Boolean);
    for (const id of ['vEvents', 'vUsers', 'vClients', 'vEvent']) $(id).hidden = true;
    document.querySelectorAll('#mainnav a').forEach((a) => a.removeAttribute('aria-current'));
    if (parts[0] === 'e' && parts[1]) return showEvent(Number(parts[1]), parts[2] || 'dash');
    closeStream();
    window.Settings && window.Settings.close();
    if (parts[0] === 'users' && canEdit()) return showUsers();
    if (parts[0] === 'clients' && isOwner()) return showClients();
    return showEvents();
  }
  const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

  // ------------------------------------------------------------ events list
  let evFilter = 'active';
  async function loadEvents() { events = await api('/api/admin/events'); return events; }
  async function showEvents() {
    $('vEvents').hidden = false;
    document.querySelector('[data-nav="events"]').setAttribute('aria-current', 'page');
    document.title = 'Events · Event admin';
    try { await loadEvents(); } catch { return; }
    if (!canEdit() && events.length === 1 && !sessionStorage.getItem('sawList')) { sessionStorage.setItem('sawList', '1'); return go(`#/e/${events[0].id}`); }
    $('evKicker').textContent = isOwner() ? 'All events' : me.role === 'manager' ? me.clientName : 'Your events';
    if (isOwner()) {
      try { clients = await api('/api/admin/clients'); } catch {}
      $('clientFilter').innerHTML = `<option value="">All clients</option><option value="none">Jupiter (no client)</option>` + clients.map((c) => `<option value="${c.id}"${String(c.id) === evClient ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
      $('clientFilter').value = evClient;
      $('clientFilterBox').hidden = !clients.length;
      try {
        const p = await api('/api/admin/platform');
        $('homeEvent').innerHTML = `<option value="">Nothing (a general page)</option>` + events.map((e) => `<option value="${esc(e.slug)}"${e.slug === p.homeEvent ? ' selected' : ''}>${esc(e.name)}</option>`).join('');
      } catch {}
    }
    renderEvents();
  }
  function renderEvents() {
    const list = events.filter((e) => (evFilter === 'archived' ? e.status === 'archived' : e.status !== 'archived'))
      .filter((e) => !isOwner() || !evClient || (evClient === 'none' ? !e.clientId : String(e.clientId) === evClient));
    $('evGrid').innerHTML = list.length ? list.map((e) => `
      <article class="ev-card" style="--ev:${esc(e.primary)}">
        <div class="body">
          <div class="top">
            <div><h2>${esc(e.name)}</h2><div class="meta">${e.date || e.venue ? [e.date, e.venue].filter(Boolean).map((x) => `<span style="display:block">${esc(x)}</span>`).join('') : 'No date set yet'}</div></div>
            ${e.logo ? `<img class="logo" src="${esc(e.logo)}" alt="">` : ''}
          </div>
          <div class="chips"><span class="chip ${e.status}">${STATUS_LABEL[e.status]}</span>${e.isHome ? '<span class="chip home">Main address</span>' : ''}${isOwner() && e.clientName ? `<span class="chip client">${esc(e.clientName)}</span>` : ''}</div>
          <a class="url" href="/${esc(e.slug)}" target="_blank" rel="noopener">${esc(location.host)}/${esc(e.slug)}</a>
          <div class="counts">
            <div><b class="num">${nf.format(e.registered)}</b><span>registered${e.capacity ? ` of ${nf.format(e.capacity)}` : ''}</span></div>
            ${e.checkin ? `<div><b class="num">${nf.format(e.checkedIn)}</b><span>checked in</span></div>` : ''}
          </div>
        </div>
        <div class="foot">
          <a class="btn btn-primary btn-sm" href="#/e/${e.id}">Dashboard</a>
          ${canEdit() ? `<a class="btn btn-quiet btn-sm" href="#/e/${e.id}/settings">Settings</a>${e.checkin ? `<a class="btn btn-quiet btn-sm" href="/${esc(e.slug)}/checkin" target="_blank" rel="noopener">Check-in page</a>` : ''}` : ''}
        </div>
      </article>`).join('')
      : `<p class="empty" style="grid-column:1/-1">${evFilter === 'archived' ? 'No archived events.' : canEdit() ? 'No events yet. Use “New event” to create your first one.' : 'No events have been shared with you yet.'}</p>`;
  }
  document.querySelectorAll('[data-evf]').forEach((b) => b.addEventListener('click', () => {
    evFilter = b.dataset.evf;
    document.querySelectorAll('[data-evf]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderEvents();
  }));
  let clients = [];
  let evClient = '';
  $('clientFilter').addEventListener('change', (e) => { evClient = e.target.value; renderEvents(); });
  $('homeEvent').addEventListener('change', async (e) => {
    try { await post('/api/admin/platform', { homeEvent: e.target.value }, 'PUT'); await loadEvents(); renderEvents(); }
    catch (err) { alert(err.message); }
  });

  const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  $('newEvent').addEventListener('click', () => {
    let slugTouched = false;
    openDialog({
      title: 'New event',
      body: '<p>The event starts as a <b>Draft</b>, hidden from the public until you open registration in its settings.</p>',
      fields: [
        { id: 'name', label: 'Event name', maxlength: 120 },
        { id: 'slug', label: 'Web address', prefix: `${location.host}/`, maxlength: 50, help: 'Lowercase letters, numbers and dashes. This is the link you share.' },
        ...(isOwner() && clients.length ? [{ id: 'client', label: 'Client', type: 'select', value: evClient && evClient !== 'none' ? evClient : '', options: [['', 'Jupiter (no client)'], ...clients.filter((c) => c.active).map((c) => [String(c.id), c.name])], help: 'The client’s administrators will be able to manage it.' }] : []),
        { id: 'copy', label: 'Start from', type: 'select', value: '', options: [['', 'Standard settings'], ...events.map((e) => [String(e.id), `Copy settings from ${e.name}`])], help: 'Copying brings over branding, form fields, email and name tag settings, but not registrations.' },
      ],
      okLabel: 'Create event',
      afterOpen: () => {
        $('dlg_name').addEventListener('input', () => { if (!slugTouched) $('dlg_slug').value = slugify($('dlg_name').value); });
        $('dlg_slug').addEventListener('input', () => { slugTouched = true; });
      },
      run: async (v) => {
        const ev = await post('/api/admin/events', { name: v.name, slug: v.slug.trim().toLowerCase(), copyFrom: v.copy ? Number(v.copy) : null, clientId: v.client ? Number(v.client) : null });
        go(`#/e/${ev.id}/settings`);
      },
    });
  });

  // ------------------------------------------------------------ users
  let users = [];
  const genPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const a = new Uint32Array(12); crypto.getRandomValues(a);
    return Array.from(a, (n) => chars[n % chars.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
  };
  // Events a viewer can be given: their client's events (or any event, for the platform's own viewers).
  const eventChecks = (name, selected, clientId = null) => events
    .filter((e) => (e.status !== 'archived' || selected.includes(e.id)) && (!clientId || e.clientId === clientId))
    .map((e) => `<label class="check"><input type="checkbox" name="${name}" value="${e.id}"${selected.includes(e.id) ? ' checked' : ''}> <span>${esc(e.name)} <span style="color:var(--muted)">(${STATUS_LABEL[e.status]})</span></span></label>`).join('')
    || `<p class="help">${clientId ? 'This client has no events yet.' : 'Create an event first.'}</p>`;
  const checkedIds = (root, name) => [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => Number(i.value));

  // The client a new account belongs to: chosen by the platform administrator, fixed for a client administrator.
  const formClientId = () => (isOwner() ? (Number($('uClient').value) || null) : null);
  function syncUserForm(keepEvents) {
    const manager = $('uRole').value === 'manager';
    if (isOwner()) {
      const none = $('uClient').querySelector('option[value=""]');
      if (none) none.disabled = manager;
      if (manager && !$('uClient').value && clients.length) $('uClient').value = String(clients.filter((c) => c.active)[0]?.id || '');
      $('uClientHelp').textContent = clients.length ? (manager ? 'The client this administrator manages.' : 'Choose a client, or Jupiter for your own viewers.') : 'Add a client on the Clients page first.';
    }
    $('userForm').querySelectorAll('.viewer-only').forEach((el) => { el.hidden = manager; });
    $('userForm').querySelectorAll('.manager-only').forEach((el) => { el.hidden = !manager; });
    if (!keepEvents) $('uEvents').innerHTML = eventChecks('uEv', [], isOwner() ? formClientId() : null);
  }
  $('uRole').addEventListener('change', () => syncUserForm());
  $('uClient').addEventListener('change', () => syncUserForm());

  async function showUsers() {
    $('vUsers').hidden = false;
    document.querySelector('[data-nav="users"]').setAttribute('aria-current', 'page');
    document.title = 'Accounts · Event admin';
    try {
      await loadEvents();
      users = await api('/api/admin/users');
      clients = await api('/api/admin/clients');
    } catch { return; }
    $('uKicker').textContent = isOwner() ? 'Sign-in accounts' : me.clientName;
    if (isOwner()) {
      const prev = $('uClient').value;
      $('uClient').innerHTML = `<option value="">Jupiter (no client)</option>` + clients.filter((c) => c.active).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      if (prev) $('uClient').value = prev;
    }
    syncUserForm();
    renderUsers();
  }
  $('uGen').addEventListener('click', () => { $('uPw').value = genPassword(); });
  const isSelf = (u) => !isOwner() && u.username === me.username;
  function renderUsers() {
    $('userRows').innerHTML = users.length ? users.map((u) => {
      const manager = u.role === 'manager';
      return `<tr data-id="${u.id}">
      <td><b>${esc(u.name)}</b><span class="small">${esc(u.username)}</span></td>
      <td><span class="type-badge ${manager ? 'manager' : ''}">${manager ? 'Client admin' : 'Viewer'}</span>${isOwner() ? `<span class="small">${esc(u.clientName || 'Jupiter (no client)')}</span>` : ''}</td>
      <td>${manager ? '<span style="color:var(--muted)">All of the client’s events</span>' : u.events.map((e) => esc(e.name)).join('<br>') || '<span style="color:var(--muted)">None</span>'}</td>
      <td>${manager ? 'Full access' : [u.canExport ? 'Download' : '', u.canCharts ? 'Charts' : ''].filter(Boolean).join(' · ') || '<span style="color:var(--muted)">View only</span>'}</td>
      <td>${u.active ? `<span class="badge in">${ICON.check}Active</span>` : '<span class="badge off">Turned off</span>'}${u.temporaryPassword ? '<span class="small">Temporary password, not yet changed</span>' : ''}</td>
      <td class="num">${u.lastLoginAt ? esc(dateTimeOf(u.lastLoginAt)) : '<span style="color:var(--muted)">Never</span>'}</td>
      <td><div class="row-actions">
        ${manager ? '' : `<button class="btn btn-quiet btn-sm" type="button" data-act="events">Events…</button>
        <button class="btn btn-quiet btn-sm" type="button" data-act="export">${u.canExport ? 'Block download' : 'Allow download'}</button>
        <button class="btn btn-quiet btn-sm" type="button" data-act="charts">${u.canCharts ? 'Block charts' : 'Allow charts'}</button>`}
        ${u.clientId && !isSelf(u) ? `<button class="btn btn-quiet btn-sm" type="button" data-act="role">${manager ? 'Make viewer' : 'Make client admin'}</button>` : ''}
        <button class="btn btn-quiet btn-sm" type="button" data-act="pw">Reset password</button>
        ${isSelf(u) ? '<span class="small">This is you</span>' : `<button class="btn btn-quiet btn-sm" type="button" data-act="active">${u.active ? 'Turn off' : 'Turn on'}</button>
        <button class="btn btn-quiet btn-sm btn-danger-text" type="button" data-act="delete">Delete</button>`}
      </div></td></tr>`;
    }).join('')
      : '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:28px">No accounts yet. Add one above.</td></tr>';
  }
  function showCreated(title, name, username, password) {
    const text = `Sign-in details for ${name}\nPage: ${location.origin}/admin\nUsername: ${username}\nTemporary password: ${password}`;
    $('uDone').innerHTML = `<b>${esc(title)}</b> Send these details to ${esc(name)}. This is a temporary password: they'll be asked to choose their own the first time they sign in. It isn't shown again.<pre>${esc(text)}</pre><button class="btn btn-quiet btn-sm" type="button" id="uCopy">Copy details</button>`;
    $('uDone').hidden = false;
    $('uCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); $('uCopy').textContent = 'Copied'; } catch { $('uCopy').textContent = 'Select the text above and copy it'; }
    });
    $('uDone').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  const reloadUsers = async () => { users = await api('/api/admin/users'); renderUsers(); };
  $('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('uErr').textContent = '';
    const role = $('uRole').value;
    const body = { name: $('uName').value.trim(), username: $('uUser').value.trim(), password: $('uPw').value, role, clientId: formClientId(), canExport: $('uExport').checked, canCharts: $('uCharts').checked, events: role === 'viewer' ? checkedIds($('userForm'), 'uEv') : [] };
    try {
      const u = await post('/api/admin/users', body);
      showCreated(role === 'manager' ? 'Client administrator added.' : 'Viewer added.', u.name, u.username, body.password);
      const keepClient = $('uClient').value;
      $('userForm').reset(); $('uExport').checked = true; $('uCharts').checked = false;
      if (isOwner()) $('uClient').value = keepClient;
      syncUserForm();
      reloadUsers();
    } catch (err) { if (err.message !== 'signed out') $('uErr').textContent = err.message; }
  });
  $('userRows').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const u = users.find((x) => x.id === Number(btn.closest('tr').dataset.id));
    if (!u) return;
    const act = btn.dataset.act;
    const patch = (body) => post(`/api/admin/users/${u.id}`, body, 'PATCH');
    const chooseEvents = (title, extra = {}) => openDialog({
      title,
      fields: [{ id: 'evs', type: 'html', html: `<div class="checks" id="dlgEvs">${eventChecks('dEv', u.events.map((x) => x.id), u.clientId)}</div>` }],
      okLabel: 'Save',
      run: async () => { await patch({ ...extra, events: checkedIds($('dlgEvs'), 'dEv') }); await reloadUsers(); },
    });
    if (act === 'events') {
      chooseEvents(`Events ${u.name} can view`);
    } else if (act === 'role') {
      if (u.role === 'manager') return chooseEvents(`Make ${u.name} a viewer: choose the events they can see`, { role: 'viewer' });
      openDialog({
        title: `Make ${u.name} a client administrator?`,
        body: `<p>They’ll be able to create and change all of <b>${esc(u.clientName)}</b>’s events, and add or remove its accounts. They’ll be signed out and sign in again.</p>`,
        okLabel: 'Make client admin',
        run: async () => { await patch({ role: 'manager' }); await reloadUsers(); },
      });
    } else if (act === 'export') {
      patch({ canExport: !u.canExport }).then(reloadUsers).catch((err) => alert(err.message));
    } else if (act === 'charts') {
      patch({ canCharts: !u.canCharts }).then(reloadUsers).catch((err) => alert(err.message));
    } else if (act === 'pw') {
      openDialog({
        title: `Reset password for ${u.name}`,
        body: '<p>They will be signed out. The new password is temporary: they’ll be asked to choose their own when they next sign in.</p>',
        fields: [{ id: 'pw', label: 'New password', value: genPassword(), help: 'At least 8 characters. You can type your own.' }],
        okLabel: 'Reset password',
        run: async (v) => { await patch({ password: v.pw }); showCreated('Password reset.', u.name, u.username, v.pw); reloadUsers(); },
      });
    } else if (act === 'active') {
      if (!u.active) return patch({ active: true }).then(reloadUsers).catch((err) => alert(err.message));
      openDialog({
        title: `Turn off ${u.name}?`,
        body: '<p>They will be signed out now and can’t sign in until the account is turned back on.</p>',
        okLabel: 'Turn off', danger: true,
        run: async () => { await patch({ active: false }); reloadUsers(); },
      });
    } else if (act === 'delete') {
      openDialog({
        title: `Delete ${u.name}?`,
        body: `<p>The account <b>${esc(u.username)}</b> is removed permanently and signed out. Event records aren’t affected.</p>`,
        okLabel: 'Delete account', danger: true,
        run: async () => { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); reloadUsers(); },
      });
    }
  });

  // ------------------------------------------------------------ clients (platform administrator)
  async function showClients() {
    $('vClients').hidden = false;
    document.querySelector('[data-nav="clients"]').setAttribute('aria-current', 'page');
    document.title = 'Clients · Event admin';
    try { clients = await api('/api/admin/clients'); } catch { return; }
    renderClients();
  }
  function renderClients() {
    $('clientRows').innerHTML = clients.length ? clients.map((c) => `<tr data-id="${c.id}">
      <td><b>${esc(c.name)}</b>${c.contact ? `<span class="small">${esc(c.contact)}</span>` : ''}</td>
      <td class="num">${nf.format(c.activeEvents)} active${c.maxEvents ? ` of ${nf.format(c.maxEvents)} allowed` : ''}<span class="small">${nf.format(c.events)} in total</span></td>
      <td class="num">${nf.format(c.users)}<span class="small">${plural(c.managers, 'client admin', 'client admins')}</span></td>
      <td>${c.active ? `<span class="badge in">${ICON.check}Active</span>` : '<span class="badge off">Turned off</span>'}</td>
      <td><div class="row-actions">
        <button class="btn btn-quiet btn-sm" type="button" data-act="events">Events</button>
        <button class="btn btn-quiet btn-sm" type="button" data-act="admin">Add client admin</button>
        <button class="btn btn-quiet btn-sm" type="button" data-act="edit">Edit…</button>
        <button class="btn btn-quiet btn-sm" type="button" data-act="active">${c.active ? 'Turn off' : 'Turn on'}</button>
        ${c.events || c.users ? '' : '<button class="btn btn-quiet btn-sm btn-danger-text" type="button" data-act="delete">Delete</button>'}
      </div></td></tr>`).join('')
      : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:28px">No clients yet. Add your first one above.</td></tr>';
  }
  const reloadClients = async () => { clients = await api('/api/admin/clients'); renderClients(); };
  $('clientForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('cErr').textContent = '';
    try {
      await post('/api/admin/clients', { name: $('cName').value.trim(), contact: $('cContact').value.trim(), maxEvents: $('cMax').value.trim() || null });
      $('clientForm').reset();
      reloadClients();
    } catch (err) { if (err.message !== 'signed out') $('cErr').textContent = err.message; }
  });
  $('clientRows').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const c = clients.find((x) => x.id === Number(btn.closest('tr').dataset.id));
    if (!c) return;
    const patch = (body) => post(`/api/admin/clients/${c.id}`, body, 'PATCH');
    const act = btn.dataset.act;
    if (act === 'events') { evClient = String(c.id); go('#/'); }
    else if (act === 'admin') {
      go('#/users');
      setTimeout(() => { $('uRole').value = 'manager'; $('uClient').value = String(c.id); syncUserForm(); $('uName').focus(); }, 300);
    } else if (act === 'edit') {
      openDialog({
        title: `Edit ${c.name}`,
        fields: [
          { id: 'name', label: 'Client name', value: c.name, maxlength: 100 },
          { id: 'contact', label: 'Contact (optional)', value: c.contact, maxlength: 200 },
          { id: 'max', label: 'Active event limit (optional)', value: c.maxEvents ? String(c.maxEvents) : '', help: 'Events that aren’t archived. Leave blank for no limit. Existing events aren’t affected.' },
        ],
        okLabel: 'Save',
        run: async (v) => { await patch({ name: v.name, contact: v.contact, maxEvents: v.max.trim() || null }); await reloadClients(); },
      });
    } else if (act === 'active') {
      if (!c.active) return patch({ active: true }).then(reloadClients).catch((err) => alert(err.message));
      openDialog({
        title: `Turn off ${c.name}?`,
        body: `<p>All ${plural(c.users, 'account', 'accounts')} of this client are signed out now and can’t sign in until you turn it back on. Its registration and check-in pages keep working.</p>`,
        okLabel: 'Turn off', danger: true,
        run: async () => { await patch({ active: false }); await reloadClients(); },
      });
    } else if (act === 'delete') {
      openDialog({
        title: `Delete ${c.name}?`,
        body: '<p>The client has no events or accounts, so nothing else is affected.</p>',
        okLabel: 'Delete client', danger: true,
        run: async () => { await api(`/api/admin/clients/${c.id}`, { method: 'DELETE' }); await reloadClients(); },
      });
    }
  });

  // ------------------------------------------------------------ one event
  let cur = null;          // { id, slug, status, name, config, staffPin? }
  let tab = 'dash';
  let stats = null;
  let people = [];
  let stream = null;
  let seenActivity = new Set();

  async function loadEventDetail(id) {
    cur = await api(`/api/admin/events/${id}`);
    tz = cur.config.details.timezone || tz;
    return cur;
  }
  // ------------------------------------------------------------ share the registration page
  // The QR code points to the event's registration page, for invitations, posters and chat messages.
  function openShare() {
    const url = `${location.origin}/${cur.slug}`;
    const base = `/api/admin/events/${cur.id}/share-qr`;
    const note = cur.status === 'draft' ? '<p class="notice warn" style="margin:0 0 12px">This event is still a <b>Draft</b>, so the page is hidden. Set it to Open in Settings before sharing.</p>'
      : cur.status !== 'open' ? `<p class="notice warn" style="margin:0 0 12px">Registration is <b>${esc(STATUS_LABEL[cur.status])}</b>. People who scan it will see the closed message.</p>` : '';
    openDialog({
      title: 'QR code for invitations',
      wide: true,
      body: `${note}<div class="share-box">
          <img src="${base}.svg" alt="QR code for ${esc(url)}" width="220" height="220">
          <div class="stack" style="gap:10px;min-width:0">
            <p style="margin:0">Scanning it opens the registration page:</p>
            <div class="pw-row"><input id="shareUrl" type="text" readonly value="${esc(url)}" style="flex:1;min-width:0;font:inherit;color:var(--ink);background:var(--surface-2);border:1.5px solid var(--line);border-radius:10px;padding:.55rem .7rem;min-height:44px"><button class="btn btn-quiet" type="button" id="shareCopy">Copy link</button></div>
            <div class="actions" style="flex-wrap:wrap">
              <a class="btn btn-primary btn-sm" href="${base}.png?dl=1" download>Download PNG</a>
              <a class="btn btn-quiet btn-sm" href="${base}.svg?dl=1" download>Download SVG (for print)</a>
              <button class="btn btn-quiet btn-sm" type="button" id="shareCard">Download with event name</button>
            </div>
            <p class="help" style="margin:0;color:var(--muted);font-size:.82rem">PNG for invitations, emails and chat. SVG stays sharp at any size, for posters and tarpaulins. Print it at least 2.5 cm (1 in) wide, and test it with a phone before printing many.</p>
          </div>
        </div>`,
      afterOpen() {
        $('shareCopy').addEventListener('click', async () => {
          const input = $('shareUrl');
          try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
          $('shareCopy').textContent = 'Copied';
          setTimeout(() => { if ($('shareCopy')) $('shareCopy').textContent = 'Copy link'; }, 1600);
        });
        $('shareCard').addEventListener('click', () => downloadShareCard(url, `${base}.png`).catch(() => { $('dlgErr').textContent = 'The image could not be made. Try Download PNG instead.'; }));
      },
    });
  }
  // A ready-to-use image: "Scan to register", the event name, date, the QR code and the web address.
  async function downloadShareCard(url, pngUrl) {
    const d = cur.config.details;
    const img = new Image();
    img.src = pngUrl;
    await img.decode();
    await document.fonts.ready;
    const W = 1200, pad = 90, qr = 820;
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    const font = (w, s) => `${w} ${s}px Roboto, Arial, sans-serif`;
    // wrap the event name over up to three lines
    const wrap = (text, max, f) => {
      ctx.font = f;
      const words = String(text).split(/\s+/), lines = [];
      let line = '';
      for (const w of words) { const t = line ? `${line} ${w}` : w; if (ctx.measureText(t).width > max && line) { lines.push(line); line = w; } else line = t; }
      if (line) lines.push(line);
      return lines.slice(0, 3);
    };
    const nameLines = wrap(d.name, W - pad * 2, font(700, 58));
    const H = pad + 50 + 30 + nameLines.length * 70 + (d.date ? 58 : 0) + 30 + qr + 40 + 50 + pad;
    cv.width = W; cv.height = H;
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = cur.config.branding.primary || '#E00000'; ctx.fillRect(0, 0, W, 16);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    let y = pad + 40;
    ctx.fillStyle = '#5C5C5C'; ctx.font = font(700, 36); ctx.fillText('SCAN TO REGISTER', W / 2, y);
    y += 30;
    ctx.fillStyle = '#141414'; ctx.font = font(700, 58);
    for (const l of nameLines) { y += 70; ctx.fillText(l, W / 2, y); }
    if (d.date) { y += 58; ctx.fillStyle = '#5C5C5C'; ctx.font = font(400, 34); ctx.fillText(d.date, W / 2, y); }
    y += 30;
    ctx.drawImage(img, (W - qr) / 2, y, qr, qr);
    y += qr + 40;
    ctx.fillStyle = '#141414'; ctx.font = font(700, 40); ctx.fillText(url.replace(/^https?:\/\//, ''), W / 2, y + 10);
    const a = document.createElement('a');
    a.download = `${cur.slug}-registration-qr-card.png`;
    a.href = cv.toDataURL('image/png');
    document.body.appendChild(a); a.click(); a.remove();
  }

  function renderEventHead() {
    $('evTitle').textContent = cur.config.details.name;
    $('evStatus').textContent = STATUS_LABEL[cur.status];
    $('evStatus').className = `chip ${cur.status}`;
    document.title = `${cur.config.details.name} · Event admin`;
    // Quick actions for the event, shown as buttons under its name.
    const I = {
      page: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
      checkin: '<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M8 12l3 3 5-6"/>',
      qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2M14 18h2M18 18h2v2h-2z"/>',
    };
    const icon = (k) => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${I[k]}</svg>`;
    $('evLinks').innerHTML = `<button type="button" class="btn btn-primary btn-sm" id="shareBtn">${icon('qr')}QR code for invitations</button>` +
      `<a class="btn btn-quiet btn-sm" href="/${esc(cur.slug)}" target="_blank" rel="noopener">${icon('page')}Open registration page</a>` +
      (canEdit() && checkinOn() ? `<a class="btn btn-quiet btn-sm" href="/${esc(cur.slug)}/checkin" target="_blank" rel="noopener">${icon('checkin')}Open check-in page</a>` : '');
    $('shareBtn').addEventListener('click', openShare);
    $('backLink').hidden = !canEdit() && events.length <= 1;
    document.querySelectorAll('#evTabs a').forEach((a) => {
      a.href = `#/e/${cur.id}${a.dataset.tab === 'dash' ? '' : `/${a.dataset.tab}`}`;
      if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('csvBtn').hidden = !me.canExport;
    $('csvBtn').href = `/api/admin/events/${cur.id}/report.xlsx`;
    $('archTitle').textContent = cur.status === 'archived' ? 'Restore from archive' : 'Archive event';
    $('archText').textContent = cur.status === 'archived'
      ? 'Moves the event back to the Active list with registration closed. You can reopen registration in Settings.'
      : 'Closes registration and check-in and moves the event to the Archived list. Records, dashboard and backups are kept.';
    $('archiveBtn').textContent = cur.status === 'archived' ? 'Restore…' : 'Archive…';
    $('anIntro').textContent = me.canCharts ? 'Charts you add here are saved for everyone who views this event and update live.' : 'Charts prepared by the event organizer. They update live.';
  }

  async function showEvent(id, which) {
    if (!canEdit() && which !== 'dash') which = 'dash';
    const switching = !cur || cur.id !== id;
    $('vEvent').hidden = false;
    tab = which;
    if (switching) {
      closeStream();
      stats = null; people = []; seenActivity = new Set();
      try { if (!events.length) await loadEvents(); await loadEventDetail(id); }
      catch (err) { if (err.message !== 'signed out') { $('vEvent').hidden = true; $('vEvents').hidden = false; $('evGrid').innerHTML = `<p class="empty" style="grid-column:1/-1">${esc(err.message)}</p>`; } return; }
      if (window.Analysis) window.Analysis.setEvent(cur);
    }
    renderEventHead();
    $('tDash').hidden = tab !== 'dash';
    $('tData').hidden = tab !== 'data';
    $('tSettings').hidden = tab !== 'settings';
    $('live').hidden = tab !== 'dash';
    if (tab === 'settings') window.Settings.open(cur, { onSaved: async (fresh) => { cur = { ...cur, ...fresh }; renderEventHead(); if (window.Analysis) window.Analysis.setEvent(cur); } });
    else window.Settings.close();
    if (tab === 'data') loadBackups();
    if (!stream) connect();
    if (tab === 'dash') { if (switching || !stats) await refresh(); else { render(); if (window.Analysis) window.Analysis.rerender(); } }
  }

  // ---- live updates
  let refreshTimer = null;
  const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 400); };
  function setLive(ok) { $('live').classList.toggle('off', !ok); $('liveText').textContent = ok ? 'Live' : 'Reconnecting…'; }
  function closeStream() { if (stream) { stream.close(); stream = null; } }
  function connect() {
    if (!window.EventSource || !cur) return;
    stream = new EventSource(`/api/admin/events/${cur.id}/stream`);
    stream.addEventListener('open', () => { setLive(true); scheduleRefresh(); });
    stream.addEventListener('change', async (e) => {
      let d = {}; try { d = JSON.parse(e.data); } catch {}
      if (d.type === 'config' && !(window.Settings && window.Settings.isDirty())) {
        try { await loadEventDetail(cur.id); renderEventHead(); if (window.Analysis) window.Analysis.setEvent(cur); } catch {}
      }
      if (d.type !== 'sessions' && tab === 'data' && (d.type === 'reset')) loadBackups();
      scheduleRefresh();
    });
    stream.addEventListener('error', () => setLive(false));
    stream.addEventListener('signedout', () => showLogin('You were signed out because your access was changed by the administrator.'));
  }
  async function refresh() {
    if (!cur) return;
    try {
      const [s, p] = await Promise.all([api(`/api/admin/events/${cur.id}/stats`), api(`/api/admin/events/${cur.id}/attendees`)]);
      if (!cur || s.event.id !== cur.id) return;
      stats = s; people = p; tz = s.timeZone || tz;
      if (tab === 'dash') render();
      if (window.Analysis) window.Analysis.update(people, tz);
    } catch (e) { if (e.message !== 'signed out') setLive(false); }
  }
  setInterval(() => { if (!$('vEvent').hidden && tab === 'dash') refresh(); }, 60000);
  setInterval(() => { if (stats && tab === 'dash') renderFeed(false); }, 30000);

  // ---- dashboard
  const checkinOn = () => !cur.config.checkin || cur.config.checkin.enabled;
  function render() {
    const t = stats.totals;
    const ckOn = checkinOn();
    // Events without check-in show registrations only.
    $('heroLabel').textContent = ckOn ? 'Checked in' : 'Registered';
    $('meter').hidden = !ckOn && !stats.event.capacity;
    document.querySelectorAll('[data-ck-only]').forEach((el) => { el.hidden = !ckOn; });
    if (!ckOn) {
      $('hIn').textContent = nf.format(t.registered);
      const today = (stats.registrationsByDay.find((d) => d.day === stats.today) || {}).count || 0;
      document.querySelector('.hero .of').innerHTML = `<b class="num">${nf.format(today)}</b> registered today`;
      if (stats.event.capacity) {
        const full = Math.min(100, Math.round((t.registered / stats.event.capacity) * 100));
        document.querySelector('.hero .of').innerHTML = `of <b class="num">${nf.format(stats.event.capacity)}</b> places, <b class="num">${full}%</b> full · <b class="num">${nf.format(today)}</b> today`;
        $('meterFill').style.width = `${full}%`;
        $('meter').setAttribute('aria-label', `${full}% of places taken`);
      }
    } else if (!document.getElementById('hReg')) {
      document.querySelector('.hero .of').innerHTML = 'of <b class="num" id="hReg">0</b> registered, <b class="num" id="hPct">0%</b> attendance';
    }
    $('updated').textContent = `· updated ${timeOf(stats.updatedAt)}`;
    const pct = t.registered ? Math.round((t.checkedIn / t.registered) * 100) : 0;
    if (ckOn) {
    $('hIn').textContent = nf.format(t.checkedIn);
    $('hReg').textContent = nf.format(t.registered);
    $('hPct').textContent = `${pct}%`;
    $('meterFill').style.width = `${pct}%`;
    $('meter').setAttribute('aria-label', `${pct}% of registered attendees have checked in`);
    }
    $('tReg').textContent = nf.format(t.registered);
    const todayCount = (stats.registrationsByDay.find((d) => d.day === stats.today) || {}).count || 0;
    $('tRegNote').textContent = stats.event.capacity ? `${nf.format(todayCount)} today · capacity ${nf.format(stats.event.capacity)}` : `${nf.format(todayCount)} today`;
    $('tOut').textContent = nf.format(t.notArrived);
    $('coTile').hidden = t.companies === null;
    $('tCo').textContent = nf.format(t.companies || 0);
    $('emailTile').hidden = Boolean(t.emailsOff);
    $('tMail').textContent = nf.format(t.emailsPending);
    $('emailTile').classList.toggle('warn', t.emailsPending > 0);
    $('tMailNote').innerHTML = t.emailsPending > 0 ? `${ICON.warn}<span>Check the email settings on the server</span>` : '<span>All emails were sent</span>';

    const reg = stats.registrationsByDay;
    $('regSub').textContent = reg.length ? `New sign-ups each day, ${dayLabel(reg[0].day)} to ${dayLabel(reg[reg.length - 1].day)}` : 'New sign-ups each day';
    columnChart($('regChart'), reg.map((d) => ({ label: dayLabel(d.day), long: dayLabel(d.day, true), value: d.count })), { unit: ['registration', 'registrations'], empty: 'No registrations yet.' });
    $('regTable').innerHTML = '<tr><th>Day</th><th>Registrations</th></tr>' + reg.map((d) => `<tr><td>${esc(dayLabel(d.day, true))}</td><td class="num">${d.count}</td></tr>`).join('');

    const arr = stats.arrivals;
    if (arr) {
      $('arrSub').textContent = `Check-ins every 15 minutes on ${dayLabel(arr.day, true)}, ${nf.format(arr.total)} in total`;
      columnChart($('arrChart'), arr.slots.map((s) => ({ label: minutesLabel(s.minutes), long: `${minutesLabel(s.minutes)} – ${minutesLabel(s.minutes + 15)}`, value: s.count })), { unit: ['check-in', 'check-ins'] });
      $('arrTable').innerHTML = '<tr><th>Time</th><th>Check-ins</th></tr>' + arr.slots.map((s) => `<tr><td>${esc(minutesLabel(s.minutes))}</td><td class="num">${s.count}</td></tr>`).join('');
      $('arrData').hidden = false;
    } else {
      $('arrSub').textContent = 'Check-ins every 15 minutes';
      $('arrChart').innerHTML = '<p class="empty">No one has checked in yet. Arrivals appear here as passes are scanned.</p>';
      $('arrData').hidden = true;
    }

    const top = stats.topCompanies;
    $('coCard').hidden = !top;
    $('arrCard').classList.toggle('span-7', Boolean(top));
    $('arrCard').classList.toggle('span-12', !top);
    $('coCard').classList.toggle('span-5', ckOn);
    $('coCard').classList.toggle('span-12', !ckOn);
    if (top) {
      const max = Math.max(1, ...top.map((c) => c.registered));
      $('companies').innerHTML = top.length ? top.map((c) => `
        <li title="${esc(c.name)}: ${c.registered} registered, ${c.arrived} checked in">
          <span class="name">${esc(c.name)}</span>
          <span class="count num">${c.registered} registered · ${c.arrived} in</span>
          <span class="track"><span class="fill" style="display:block;width:${(c.registered / max) * 100}%"></span></span>
        </li>`).join('') : '<li class="empty" style="display:block">No registrations yet.</li>';
    }
    renderFeed(true);
    renderPeople();
  }

  function renderFeed(markNew) {
    const items = stats.activity;
    const firstLoad = seenActivity.size === 0;
    $('feed').innerHTML = items.length ? items.map((a) => {
      const id = `${a.type}|${a.at}|${a.name}`;
      const fresh = markNew && !firstLoad && !seenActivity.has(id);
      return `<li class="${fresh ? 'fresh' : ''}">
        <span class="ico ${a.type === 'checked_in' ? 'in' : 'reg'}">${a.type === 'checked_in' ? ICON.check : ICON.plus}</span>
        <span class="what"><b>${esc(a.name)}</b> ${a.type === 'checked_in' ? 'checked in' : 'registered'}<span>${esc(a.company)}</span></span>
        <time datetime="${esc(a.at)}" title="${esc(dateTimeOf(a.at))}">${esc(ago(a.at))}</time>
      </li>`;
    }).join('') : '<li style="display:block" class="empty">Nothing yet. New registrations and check-ins will appear here.</li>';
    if (markNew) items.forEach((a) => seenActivity.add(`${a.type}|${a.at}|${a.name}`));
  }

  function niceMax(v) {
    if (v <= 4) return 4;
    const step = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v) return m * step;
    return 10 * step;
  }
  function columnChart(el, data, { unit, empty }) {
    if (!data.length || (data.every((d) => d.value === 0) && empty)) { el.innerHTML = `<p class="empty">${esc(empty || 'No data yet.')}</p>`; return; }
    const W = Math.max(280, el.clientWidth || 600), H = 240;
    const m = { l: 36, r: 8, t: 20, b: 28 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const top = niceMax(Math.max(...data.map((d) => d.value)));
    const ticks = [0, top / 4, top / 2, (3 * top) / 4, top].filter((v) => Number.isInteger(v));
    const band = pw / data.length;
    const bw = Math.max(2, Math.min(24, band - 2));
    const y = (v) => m.t + ph - (v / top) * ph;
    const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(pw / 64))));
    const peakI = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);
    let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(`${data.length} bars; highest ${data[peakI].value} at ${data[peakI].long}`)}">`;
    for (const t of ticks) {
      svg += `<line class="${t === 0 ? 'baseline' : 'gridline'}" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`;
      svg += `<text class="axis" x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${nf.format(t)}</text>`;
    }
    data.forEach((d, i) => {
      const cx = m.l + band * i + band / 2;
      const x0 = cx - bw / 2, h = y(0) - y(d.value), r = Math.min(4, h, bw / 2);
      svg += `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ph}"/>`;
      if (d.value > 0) svg += `<path class="bar" data-b="${i}" d="M${x0},${y(0)} V${y(d.value) + r} Q${x0},${y(d.value)} ${x0 + r},${y(d.value)} H${x0 + bw - r} Q${x0 + bw},${y(d.value)} ${x0 + bw},${y(d.value) + r} V${y(0)} Z"/>`;
      else svg += `<path class="bar" data-b="${i}" d=""/>`;
      if (i === peakI && d.value > 0) svg += `<text class="peak" x="${cx}" y="${y(d.value) - 6}" text-anchor="middle">${nf.format(d.value)}</text>`;
      if (i % every === 0) svg += `<text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
    });
    svg += '</svg><div class="tip" hidden></div>';
    el.innerHTML = svg;
    const tip = el.querySelector('.tip');
    const svgEl = el.querySelector('svg');
    el.querySelectorAll('.hit').forEach((hit) => {
      const i = Number(hit.dataset.i), d = data[i];
      const bar = el.querySelector(`[data-b="${i}"]`);
      hit.addEventListener('pointerenter', () => {
        const scale = svgEl.getBoundingClientRect().width / W;
        tip.innerHTML = `<b>${nf.format(d.value)}</b> ${esc(d.value === 1 ? unit[0] : unit[1])}<br>${esc(d.long)}`;
        tip.style.left = `${(m.l + band * i + band / 2) * scale}px`;
        tip.style.top = `${y(d.value) * scale}px`;
        tip.hidden = false; bar.classList.add('on');
      });
      hit.addEventListener('pointerleave', () => { tip.hidden = true; bar.classList.remove('on'); });
    });
  }
  let resizeT = null;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (stats && tab === 'dash') { render(); if (window.Analysis) window.Analysis.rerender(); } }, 150); });

  // ---- attendee table (columns follow the event's name tag lines)
  let filter = 'all';
  let limit = 25;
  const fieldOf = (key) => (cur.config.form.fields || []).find((f) => f.key === key);
  function renderPeople() {
    const b = cur.config.badge;
    const f2 = b.line2 && fieldOf(b.line2), f3 = b.line3 && fieldOf(b.line3);
    const phone = fieldOf('contact_number');
    const ckOn = checkinOn();
    $('peopleHead').innerHTML = `<tr><th scope="col">Name</th><th scope="col">${esc(f3 ? f3.label : 'Pass')}</th><th scope="col">Contact</th><th scope="col">Registered</th>${ckOn ? '<th scope="col">Status</th>' : ''}</tr>`;
    $('peopleSeg').hidden = !ckOn;
    if (!ckOn) filter = 'all';
    const term = $('q').value.trim().toLowerCase();
    const list = people.filter((p) =>
      (filter === 'all' || (filter === 'in' ? p.checkedInAt : !p.checkedInAt)) &&
      (!term || `${p.firstName} ${p.lastName} ${p.email} ${p.passCode} ${Object.values(p.values).join(' ')}`.toLowerCase().includes(term)));
    const shown = list.slice(0, limit);
    $('rows').innerHTML = shown.length ? shown.map((p) => `<tr data-pass="${esc(p.passCode)}" tabindex="0">
      <td><b>${esc(p.firstName)} ${esc(p.lastName)}</b>${f2 ? `<span class="small">${esc(p.values[f2.key] || '')}</span>` : ''}</td>
      <td>${f3 ? esc(p.values[f3.key] || '') : ''}<span class="small num">Pass ${esc(p.passCode)}</span></td>
      <td>${phone && phone.enabled ? `<span class="num">${esc(p.contact)}</span>` : ''}<span class="small">${esc(p.email)}</span></td>
      <td class="num">${esc(dateTimeOf(p.registeredAt))}${p.emailSent ? '' : '<span class="small" style="color:var(--warn)">Pass email not sent</span>'}</td>
      ${ckOn ? `<td>${p.checkedInAt ? `<span class="badge in">${ICON.check}Checked in ${esc(timeOf(p.checkedInAt))}</span>` : '<span class="badge out">Not arrived</span>'}</td>` : ''}
    </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:28px">${people.length ? 'No attendees match this search.' : 'No registrations yet.'}</td></tr>`;
    $('showing').textContent = `Showing ${nf.format(shown.length)} of ${nf.format(list.length)}`;
    $('moreBtn').hidden = list.length <= limit;
  }
  function showPerson(pass) {
    const p = people.find((x) => x.passCode === pass);
    if (!p) return;
    const fields = cur.config.form.fields.filter((f) => f.enabled || p.values[f.key]);
    const rows = [
      ...fields.map((f) => [f.label, p.values[f.key] || '—']),
      ['Pass code', p.passCode],
      ['Registered', dateTimeOf(p.registeredAt)],
      ['Pass emailed', p.emailSent ? 'Yes' : 'Not yet'],
      ...(checkinOn() ? [['Checked in', p.checkedInAt ? dateTimeOf(p.checkedInAt) : 'Not arrived']] : []),
    ];
    openDialog({ title: `${p.firstName} ${p.lastName}`, wide: true, body: `<dl class="answers">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` });
  }
  $('rows').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-pass]'); if (tr) showPerson(tr.dataset.pass); });
  $('rows').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const tr = e.target.closest('tr[data-pass]'); if (tr) showPerson(tr.dataset.pass); } });
  $('q').addEventListener('input', () => { limit = 25; renderPeople(); });
  document.querySelectorAll('#peopleSeg button').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f; limit = 25;
    document.querySelectorAll('#peopleSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderPeople();
  }));
  $('moreBtn').addEventListener('click', () => { limit += 50; renderPeople(); });

  // ---- backups, reset and delete
  let backups = [];
  const base = () => `/api/admin/events/${cur.id}`;
  async function loadBackups() {
    try { backups = await api(`${base()}/backups`); renderBackups(); } catch {}
  }
  function renderBackups() {
    $('backupRows').innerHTML = backups.length ? backups.map((b) => `<tr data-id="${b.id}">
      <td class="num"><b>${esc(dateTimeOf(b.createdAt))}</b><span class="small">${esc(b.name)}</span></td>
      <td>${esc(b.reason)}<span class="small">by ${esc(b.createdBy)}</span></td>
      <td class="num">${plural(b.registrations, 'registration', 'registrations')}<span class="small">${nf.format(b.checkedIn)} checked in</span></td>
      <td><div class="row-actions">${b.available ? `
        <a class="btn btn-quiet btn-sm" href="${base()}/backups/${b.id}/csv" download>Download (Excel)</a>
        <button class="btn btn-quiet btn-sm" type="button" data-act="restore">Restore</button>` : '<span class="small">File missing</span>'}
        <button class="btn btn-quiet btn-sm btn-danger-text" type="button" data-act="delete">Delete</button>
      </div></td></tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:28px">No backups yet. One is made automatically before any reset, delete or restore.</td></tr>';
  }
  function done(html) {
    $('dataDone').innerHTML = html; $('dataDone').hidden = false;
    $('dataDone').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  const backupNote = (b) => (b ? ` A backup was saved first (<b>${esc(b.name)}</b>, ${plural(b.registrations, 'registration', 'registrations')}).` : '');
  $('backupNow').addEventListener('click', async () => {
    try { const b = await post(`${base()}/backups`); done(`<b>Backup created.</b> ${esc(b.name)} holds ${plural(b.registrations, 'registration', 'registrations')}.`); loadBackups(); }
    catch (err) { if (err.message !== 'signed out') alert(err.message); }
  });
  $('resetBtn').addEventListener('click', async () => {
    const s = await api(`${base()}/stats`).catch(() => null);
    const n = s ? s.totals.checkedIn : 0;
    openDialog({
      title: 'Reset all check-ins?',
      body: `<p><b>${plural(n, 'attendee is', 'attendees are')}</b> currently checked in to ${esc(cur.config.details.name)}. They will all show as not arrived, and their passes can be scanned again.</p><p>Registrations are kept. A backup is saved first.</p>`,
      confirmWord: 'RESET', okLabel: 'Reset check-ins', danger: true,
      run: async (v) => {
        const r = await post(`${base()}/data/reset-checkins`, { confirm: v.confirm });
        done(`<b>Check-ins reset.</b> ${plural(r.changed, 'attendee was', 'attendees were')} set back to not arrived.${backupNote(r.backup)}`);
        loadBackups();
      },
    });
  });
  $('deleteBtn').addEventListener('click', async () => {
    const s = await api(`${base()}/stats`).catch(() => null);
    const n = s ? s.totals.registered : 0;
    openDialog({
      title: 'Delete all records?',
      body: `<p>This removes <b>${plural(n, 'registration', 'registrations')}</b> and all check-ins from ${esc(cur.config.details.name)}. Passes already emailed will stop working.</p><p>A backup is saved first, and you can restore it from the Backups list.</p>`,
      confirmWord: 'DELETE', okLabel: 'Delete all records', danger: true,
      run: async (v) => {
        const r = await post(`${base()}/data/delete-all`, { confirm: v.confirm });
        done(`<b>All records deleted.</b> ${plural(r.changed, 'registration was', 'registrations were')} removed.${backupNote(r.backup)}`);
        loadBackups();
      },
    });
  });
  $('backupRows').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const b = backups.find((x) => x.id === Number(btn.closest('tr').dataset.id));
    if (!b) return;
    if (btn.dataset.act === 'restore') {
      openDialog({
        title: 'Restore this backup?',
        body: `<p>The current records of this event will be replaced with the <b>${plural(b.registrations, 'registration', 'registrations')}</b> from ${esc(dateTimeOf(b.createdAt))}. Their passes will work again.</p><p>The current records are backed up first.</p>`,
        confirmWord: 'RESTORE', okLabel: 'Restore backup', danger: true,
        run: async (v) => {
          const r = await post(`${base()}/backups/${b.id}/restore`, { confirm: v.confirm });
          done(`<b>Backup restored.</b> The event now has ${plural(r.restored.total, 'registration', 'registrations')} (${nf.format(r.restored.checkedIn)} checked in).${backupNote(r.backup)}`);
          loadBackups();
        },
      });
    } else {
      openDialog({
        title: 'Delete this backup?',
        body: `<p><b>${esc(b.name)}</b> (${plural(b.registrations, 'registration', 'registrations')}) will be removed permanently. Download it first if you may need it.</p>`,
        okLabel: 'Delete backup', danger: true,
        run: async () => { await api(`${base()}/backups/${b.id}`, { method: 'DELETE' }); loadBackups(); },
      });
    }
  });
  $('archiveBtn').addEventListener('click', () => {
    const archived = cur.status === 'archived';
    openDialog({
      title: archived ? 'Restore this event from the archive?' : 'Archive this event?',
      body: archived ? '<p>The event returns to the Active list with registration <b>closed</b>.</p>' : `<p>Registration and check-in close, and the page shows that <b>${esc(cur.config.details.name)}</b> has ended. Records and backups are kept, and client users can still view the dashboard.</p>`,
      okLabel: archived ? 'Restore event' : 'Archive event', danger: !archived,
      run: async () => { await post(base(), { status: archived ? 'closed' : 'archived' }, 'PUT'); await loadEventDetail(cur.id); renderEventHead(); await loadEvents(); },
    });
  });
  $('deleteEventBtn').addEventListener('click', () => {
    openDialog({
      title: 'Delete this event?',
      body: `<p><b>${esc(cur.config.details.name)}</b> and its settings and charts are removed permanently.</p>`,
      confirmWord: cur.slug, okLabel: 'Delete event', danger: true,
      run: async (v) => { await post(base(), { confirm: v.confirm.toLowerCase() }, 'DELETE'); cur = null; await loadEvents(); go('#/'); },
    });
  });

  // ------------------------------------------------------------ shared with admin-settings.js
  window.App = {
    $, esc, api, post, openDialog, go, nf,
    get me() { return me; },
    setLeaveGuard(fn) { leaveGuard = fn; },
    reloadEvents: loadEvents,
  };

  if (window.Analysis) window.Analysis.init({ api, base: () => (cur ? `/api/admin/events/${cur.id}` : '') });

  // ------------------------------------------------------------ boot
  // Closing the page signs you out. The browser keeps sessionStorage only while this tab is open
  // (a refresh keeps it, closing the tab or browser clears it), so a page opened without the marker
  // means the earlier page was closed: end that session and ask to sign in again.
  const TAB_KEY = 'eg_signed_in_tab';
  const tabMarked = () => { try { return sessionStorage.getItem(TAB_KEY) === '1'; } catch { return true; } };
  fetch('/api/admin/session', { credentials: 'same-origin' }).then((r) => r.json()).then(async (s) => {
    if (s.signedIn && !tabMarked()) {
      await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
      return showLogin();
    }
    if (s.signedIn) start(s.user); else showLogin();
  }).catch(() => showLogin());
})();
