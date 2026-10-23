/* Event settings editor: details, branding, registration form, email and name tag,
   with a live preview of the registration page, the pass email and the printed name tag. */
(() => {
  'use strict';
  const A = window.App;
  const { $, esc } = A;
  const root = $('tSettings');

  let ev = null;            // the saved event
  let draft = null;         // { slug, status, staffPin, config } being edited
  let saved = '';           // JSON of the saved state, to detect changes
  let onSaved = null;
  let section = 'details';
  let pview = 'page';
  let device = 'desktop';
  let openKey = null;       // field whose editor is expanded
  let platform = { senderAddress: '', smtp: true };
  let clientList = [];      // for the platform administrator: clients an event can belong to

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isDirty = () => Boolean(draft) && JSON.stringify(draft) !== saved;
  const getPath = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), draft);
  function setPath(path, value) {
    const keys = path.split('.');
    let o = draft;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys[keys.length - 1]] = value;
  }
  const fieldTypeLabel = (t) => EG.FIELD_TYPES[t] || t;
  const fieldMeta = (f) => [fieldTypeLabel(f.type), f.type === 'checkbox' ? (f.required ? 'Must be ticked' : 'Optional') : f.required ? 'Required' : 'Optional',
    f.width === 'full' ? 'Full width' : 'Half width'].join(' · ');

  // ------------------------------------------------------------ open / close
  async function open(e, opts = {}) {
    onSaved = opts.onSaved;
    root.hidden = false;
    if (ev && ev.id === e.id && draft) return;
    ev = e;
    draft = clone({ slug: e.slug, status: e.status, staffPin: e.staffPin, clientId: e.clientId || null, config: e.config });
    saved = JSON.stringify(draft);
    openKey = null;
    A.setLeaveGuard(guard);
    try { platform = await A.api('/api/admin/platform'); } catch {}
    if (A.me && A.me.role === 'owner') { try { clientList = await A.api('/api/admin/clients'); } catch {} }
    build();
  }
  function close() {
    root.hidden = true;
    if (!ev) return;
    ev = null; draft = null; saved = '';
    root.innerHTML = '';
    A.setLeaveGuard(null);
  }
  function guard(silent) {
    if (!isDirty()) return true;
    if (silent) return false;
    return confirm('You have unsaved changes to this event’s settings. Leave without saving?');
  }

  // ------------------------------------------------------------ layout
  const SECTIONS = [['details', 'Details'], ['branding', 'Branding'], ['form', 'Registration form'], ['email', 'Email'], ['checkin', 'Check-in'], ['tag', 'Name tag']];
  function build() {
    root.innerHTML = `
      <div class="settings">
        <div>
          <div class="sec-nav" role="group" aria-label="Settings sections">
            ${SECTIONS.map(([k, l]) => `<button type="button" data-sec="${k}" aria-pressed="${k === section}">${l}</button>`).join('')}
          </div>
          <div class="sec" id="secBody"></div>
        </div>
        <aside class="preview-pane" aria-label="Preview">
          <div class="ptabs">
            <div class="seg" role="group" aria-label="What to preview">
              <button type="button" data-pv="page">Registration page</button><button type="button" data-pv="email">Email</button><button type="button" data-pv="tag">Name tag</button>
            </div>
            <div class="seg" role="group" aria-label="Screen size" id="devSeg">
              <button type="button" data-dev="desktop">Computer</button><button type="button" data-dev="phone">Phone</button>
            </div>
          </div>
          <div id="pvPage"><div class="frame-box" id="pageBox"><iframe id="pageFrame" title="Registration page preview"></iframe></div></div>
          <div id="pvEmail" hidden><p class="subject-line" id="pvSubject"></p><div class="frame-box"><iframe id="emailFrame" title="Email preview" style="width:100%;height:900px"></iframe></div></div>
          <div id="pvTag" hidden><div class="tag-stage"><div class="tag-prev" id="tagPrev"></div></div><p class="hint" style="text-align:center">Shown at 4 × 3 in. Other label sizes are chosen at the check-in desk.</p></div>
        </aside>
      </div>
      <div class="savebar" id="saveBar" hidden>
        <span><b>Unsaved changes</b> <span class="err" id="saveErr" role="alert"></span></span>
        <span class="actions"><button class="btn btn-quiet btn-sm" type="button" id="discard">Discard</button><button class="btn btn-primary" type="button" id="saveBtn">Save changes</button></span>
      </div>`;
    root.querySelectorAll('[data-sec]').forEach((b) => b.addEventListener('click', () => showSection(b.dataset.sec)));
    root.querySelectorAll('[data-pv]').forEach((b) => b.addEventListener('click', () => showPreview(b.dataset.pv)));
    root.querySelectorAll('[data-dev]').forEach((b) => b.addEventListener('click', () => { device = b.dataset.dev; sizeFrame(); syncPvButtons(); }));
    $('discard').addEventListener('click', () => { draft = JSON.parse(saved); openKey = null; syncOptions(); if (section === 'tag' && !draft.config.checkin.nameTags) section = 'checkin'; renderSection(); changed(); });
    $('saveBtn').addEventListener('click', save);
    $('pageFrame').src = `/${encodeURIComponent(ev.slug)}?preview=1`;
    $('pageFrame').addEventListener('load', () => { sizeFrame(); postPage(); });
    showSection(section);
  }
  // The Name tag section and preview only apply when the event prints name tags.
  function syncOptions() {
    const tags = draft.config.checkin.nameTags;
    root.querySelectorAll('[data-sec="tag"], [data-pv="tag"]').forEach((b) => { b.hidden = !tags; });
  }
  function showSection(k) {
    if (k === 'tag' && !draft.config.checkin.nameTags) k = 'checkin';
    section = k;
    syncOptions();
    root.querySelectorAll('[data-sec]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sec === k)));
    renderSection();
    showPreview(k === 'email' ? 'email' : k === 'tag' ? 'tag' : 'page');
  }
  function syncPvButtons() {
    root.querySelectorAll('[data-pv]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pv === pview)));
    root.querySelectorAll('[data-dev]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dev === device)));
    $('devSeg').hidden = pview !== 'page';
  }
  function showPreview(k) {
    pview = k;
    $('pvPage').hidden = k !== 'page';
    $('pvEmail').hidden = k !== 'email';
    $('pvTag').hidden = k !== 'tag';
    syncPvButtons();
    if (k === 'page') sizeFrame();
    if (k === 'email') updateEmail(true);
    if (k === 'tag') renderTag();
  }

  // ------------------------------------------------------------ previews
  function toPublic() {
    const c = draft.config;
    return {
      slug: draft.slug, status: draft.status === 'draft' ? 'open' : draft.status, full: false,
      details: { name: c.details.name, date: shownDate(), venue: c.details.venue, organizer: c.details.organizer, intro: c.details.intro },
      branding: c.branding,
      form: { fields: c.form.fields.filter((f) => f.enabled), consent: c.form.consent, submitLabel: c.form.submitLabel, allowAnother: c.form.allowAnother, successTitle: c.form.successTitle, closedMessage: c.form.closedMessage },
      badge: c.badge,
      checkin: c.checkin,
    };
  }
  // The date line as attendees will see it.
  const shownDate = () => { const d = draft.config.details; return d.schedule && d.schedule.start ? EG.formatSchedule(d.schedule) : d.date; };
  function postPage() {
    const f = $('pageFrame');
    if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'eg-preview', event: toPublic() }, location.origin);
  }
  window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data && e.data.type === 'eg-preview-ready' && draft) postPage(); });
  function sizeFrame() {
    const box = $('pageBox'), f = $('pageFrame');
    if (!box || !f || $('pvPage').hidden) return;
    box.classList.toggle('phone', device === 'phone');
    if (device === 'phone') {
      Object.assign(f.style, { width: '375px', height: '720px', transform: 'none' });
      box.style.height = '';
    } else {
      const W = box.clientWidth || 600, FW = 1280, FH = 1500, k = W / FW;
      Object.assign(f.style, { width: `${FW}px`, height: `${FH}px`, transform: `scale(${k})` });
      box.style.height = `${Math.round(FH * k)}px`;
    }
  }
  window.addEventListener('resize', () => { if (draft) sizeFrame(); });

  let emailTimer = null, emailSeq = 0;
  function updateEmail(now) {
    clearTimeout(emailTimer);
    emailTimer = setTimeout(async () => {
      if (!draft || pview !== 'email') return;
      const seq = ++emailSeq;
      if (draft.config.email.send === false) {
        $('pvSubject').innerHTML = '<b>No email is sent for this event.</b> Turn on the confirmation email in the Email section to preview it.';
        $('emailFrame').srcdoc = ''; $('emailFrame').style.height = '0px';
        return;
      }
      try {
        const r = await A.post(`/api/admin/events/${ev.id}/email-preview`, { config: draft.config });
        if (seq !== emailSeq) return;
        $('pvSubject').innerHTML = `Subject: <b>${esc(r.subject)}</b><br>From: <b>${esc(draft.config.email.fromName || draft.config.details.name)}</b> &lt;${esc(platform.senderAddress)}&gt;${draft.config.email.replyTo ? ` · Replies go to ${esc(draft.config.email.replyTo)}` : ''}`;
        const f = $('emailFrame');
        f.onload = () => { try { f.style.height = `${f.contentDocument.documentElement.scrollHeight + 4}px`; } catch {} };
        f.srcdoc = r.html;
      } catch {}
    }, now ? 0 : 600);
  }

  function renderTag() {
    const c = draft.config, b = c.badge;
    const label = (k) => (c.form.fields.find((f) => f.key === k) || {}).label || '';
    const sample = { designation: 'Operations Manager', company_name: 'Sample Company Inc.' };
    const val = (k) => (k ? sample[k] || `(${label(k)})` : '');
    const box = $('tagPrev');
    box.style.setProperty('--tag-font', EG.fontStack(c.branding.headingFont));
    box.style.setProperty('--tag-body', EG.fontStack(c.branding.bodyFont));
    // Same layout as the printed tag on the check-in page (shared code), each image in its own spot.
    const parts = EG.tagImageParts(c.branding, b.showEventName, esc);
    const ev = b.showEventName ? `<div class="t-ev">${esc(c.details.name)}</div>` : '';
    box.innerHTML = `<div class="t-head">${parts.above}${parts.beside ? `<div class="t-headrow">${parts.left}${ev}${parts.right}</div>` : ev}</div>
      <div class="t-nm">Juan dela Cruz</div>
      ${b.line2 ? `<div class="t-ds">${esc(val(b.line2))}</div>` : ''}
      ${b.line3 ? `<div class="t-co">${esc(val(b.line3))}</div>` : ''}
      ${parts.bottom}
      <div class="t-pw">Powered by <img src="/jupiter-logo.png" alt=""></div>`;
  }

  let pageTimer = null;
  // Keep the Email field and confirmation email consistent with the check-in options (the server applies the same rules).
  function applyEmailRules() {
    const c = draft.config;
    if (c.checkin.qr) c.email.send = true;
    const ef = c.form.fields.find((f) => f.key === 'email');
    if (!ef) return;
    const r = EG.emailRules(c);
    if (r.enabledLocked) ef.enabled = true;
    if (r.requiredLocked) ef.required = true;
    if (!ef.enabled) ef.required = false;
  }
  function changed() {
    applyEmailRules();
    $('saveBar').hidden = !isDirty();
    $('saveErr').textContent = '';
    clearTimeout(pageTimer);
    pageTimer = setTimeout(postPage, 150);
    if (pview === 'email') updateEmail();
    if (pview === 'tag') renderTag();
  }

  // ------------------------------------------------------------ helpers for section HTML
  const v = (path) => getPath(path) ?? '';
  const text = (path, label, { help = '', placeholder = '', max = 160, type = 'text' } = {}) =>
    `<div class="field"><label for="s_${path}">${esc(label)}</label><input id="s_${path}" type="${type}" data-path="${path}" value="${esc(v(path))}" maxlength="${max}" placeholder="${esc(placeholder)}"${type === 'number' ? ' data-kind="number" min="1"' : ''}>${help ? `<p class="help">${help}</p>` : ''}</div>`;
  const area = (path, label, { help = '', rows = 4, max = 4000 } = {}) =>
    `<div class="field"><label for="s_${path}">${esc(label)}</label><textarea id="s_${path}" data-path="${path}" rows="${rows}" maxlength="${max}">${esc(v(path))}</textarea>${help ? `<p class="help">${help}</p>` : ''}</div>`;
  const check = (path, label) => `<label class="check"><input type="checkbox" data-path="${path}"${getPath(path) ? ' checked' : ''}> <span>${esc(label)}</span></label>`;
  // Image settings for one place ('page', 'email' or 'tag'): for each image, a small map of the spots it can
  // go to (above the event name on the left, centre or right, beside the name, at the bottom), or not shown,
  // and its own size.
  const POS_LABEL = {
    'top-left': 'Above the name, left', 'top-center': 'Above the name, centre', 'top-right': 'Above the name, right',
    'beside-left': 'Left of the name', 'beside-right': 'Right of the name',
    'bottom-left': 'At the bottom, left', 'bottom-center': 'At the bottom, centre', 'bottom-right': 'At the bottom, right', hide: 'Not shown',
  };
  const BOTTOM_NAME = { page: 'Bottom of the page', email: 'Bottom of the email', tag: 'Bottom of the tag' };
  function imageControls(place, note) {
    const b = draft.config.branding;
    const imgs = [[1, b.logo], [2, b.logo2]].filter(([, src]) => src);
    if (!imgs.length) return '<p class="help" style="margin:0;color:var(--muted);font-size:.82rem">No images yet. Upload them in the Branding section.</p>';
    const pos = b.imagePos[place], sizes = b.imageSizes[place];
    const one = ([n, src]) => {
      const here = pos[n - 1], other = imgs.find(([m]) => m !== n);
      const spotBtn = (p) => {
        const otherHere = other && pos[other[0] - 1] === p;
        return `<button type="button" class="pp-spot" data-pos="${place}:${n}" data-pos-val="${p}" aria-pressed="${here === p}" aria-label="${POS_LABEL[p]}" title="${POS_LABEL[p]}">${here === p ? n : otherHere ? `<span class="pp-other">${other[0]}</span>` : ''}</button>`;
      };
      return `<div class="img-ctl">
        <div class="img-ctl-head"><img src="${esc(src)}" alt=""><div><b>Image ${n}${n === 1 ? ' (main logo)' : ''}</b><span class="pos-label">${POS_LABEL[here]}</span></div></div>
        <div class="pos-pick" role="group" aria-label="Where image ${n} goes">
          <div class="pp-row">${['top-left', 'top-center', 'top-right'].map(spotBtn).join('')}</div>
          <div class="pp-row pp-mid">${spotBtn('beside-left')}<span class="pp-name">Event name</span>${spotBtn('beside-right')}</div>
          <div class="pp-body" aria-hidden="true"><i></i><i></i><i></i></div>
          <div class="pp-row">${['bottom-left', 'bottom-center', 'bottom-right'].map(spotBtn).join('')}</div>
          <span class="pp-cap" aria-hidden="true">${BOTTOM_NAME[place]}</span>
        </div>
        <div class="pp-side">
          <button type="button" class="btn btn-quiet btn-sm pp-hide" data-pos="${place}:${n}" data-pos-val="hide" aria-pressed="${here === 'hide'}">Don’t show</button>
          ${here === 'hide' ? '' : `<div class="field" style="margin:0"><span class="lbl">Size</span><div class="seg" role="group" aria-label="Size of image ${n}">
            ${[['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']].map(([k, l]) => `<button type="button" data-isize="${place}:${n}" data-isize-val="${k}" aria-pressed="${sizes[n - 1] === k}">${l}</button>`).join('')}</div></div>`}
        </div>
      </div>`;
    };
    const tagNote = place === 'tag' && !draft.config.badge.showEventName && imgs.some(([n]) => pos[n - 1].startsWith('beside'))
      ? '<p class="help" style="margin:0;color:var(--muted);font-size:.82rem">The event name isn’t printed, so images set beside it go above the attendee’s name instead.</p>' : '';
    return `<p class="help" style="margin:0;color:var(--muted);font-size:.82rem">Click a spot on the map to move an image there. The other image’s spot shows its number.</p>
      ${imgs.map(one).join('')}${tagNote}${note ? `<p class="help" style="margin:0;color:var(--muted);font-size:.82rem">${note}</p>` : ''}`;
  }
  function wireLogoControls(body) {
    body.querySelectorAll('[data-pos]').forEach((btn) => btn.addEventListener('click', () => {
      const [place, n] = btn.dataset.pos.split(':');
      draft.config.branding.imagePos[place][Number(n) - 1] = btn.dataset.posVal;
      changed();
      renderSection();
      const again = $('secBody').querySelector(`[data-pos="${btn.dataset.pos}"][data-pos-val="${btn.dataset.posVal}"]`);
      if (again) again.focus();
    }));
    body.querySelectorAll('[data-isize]').forEach((btn) => btn.addEventListener('click', () => {
      const [place, n] = btn.dataset.isize.split(':');
      draft.config.branding.imageSizes[place][Number(n) - 1] = btn.dataset.isizeVal;
      btn.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
      changed();
    }));
    body.querySelectorAll('[data-logo-key]').forEach((btn) => btn.addEventListener('click', () => {
      draft.config.branding[btn.dataset.logoKey] = btn.dataset.logoVal;
      changed();
      // placement shows or hides the left/centre/right choice
      if (/Place$|^logoPlace$/.test(btn.dataset.logoKey)) { renderSection(); const again = $('secBody').querySelector(`[data-logo-key="${btn.dataset.logoKey}"][data-logo-val="${btn.dataset.logoVal}"]`); if (again) again.focus(); }
      else btn.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
    }));
  }
  const FORMAT_HELP = 'Leave a blank line between paragraphs. Start lines with “- ” for a bulleted list, and wrap words in **double asterisks** for bold.';

  function bind(container) {
    container.querySelectorAll('[data-path]').forEach((el) => {
      const evName = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evName, () => {
        let val = el.type === 'checkbox' ? el.checked : el.value;
        if (el.dataset.kind === 'number') val = val === '' ? null : Math.max(1, Math.floor(Number(val)) || 0) || null;
        setPath(el.dataset.path, val);
        if (el.dataset.after) AFTER[el.dataset.after]();
        changed();
      });
    });
  }
  const AFTER = {
    colors: () => colorWarnings(),
    fonts: () => fontSamples(),
  };

  // ------------------------------------------------------------ sections
  function renderSection() {
    const body = $('secBody');
    if (!body) return;
    body.innerHTML = RENDER[section]();
    bind(body);
    wireLogoControls(body);
    (WIRE[section] || (() => {}))(body);
  }

  const STATUSES = [
    ['draft', 'Draft', 'Hidden from the public. Use the preview while you set it up.'],
    ['open', 'Open', 'The page is live and accepting registrations.'],
    ['closed', 'Closed', 'The page shows your closed message. Passes still work at check-in.'],
    ['archived', 'Archived', 'The event has ended. Check-in is off.'],
  ];

  const RENDER = {
    details: () => `
      <section class="card stack">
        ${text('config.details.name', 'Event name', { max: 120 })}
        <div class="field"><label for="s_slug">Web address</label><div class="prefix"><span>${esc(location.host)}/</span><input id="s_slug" type="text" data-path="slug" value="${esc(draft.slug)}" maxlength="50" autocapitalize="none" spellcheck="false"></div>
          <p class="help">Lowercase letters, numbers and dashes. Changing it breaks links and QR codes you've already shared.</p></div>
        <div class="field"><span class="lbl">Status</span><div class="status-pick">
          ${STATUSES.map(([k, l, d]) => `<label><input type="radio" name="s_status" value="${k}"${draft.status === k ? ' checked' : ''}><span><b>${l}</b>${d}</span></label>`).join('')}
        </div></div>
        ${A.me && A.me.role === 'owner' && clientList.length ? `<div class="field"><label for="s_client">Client</label><select id="s_client">
          <option value="">Jupiter (no client)</option>${clientList.map((c) => `<option value="${c.id}"${c.id === draft.clientId ? ' selected' : ''}>${esc(c.name)}${c.active ? '' : ' (turned off)'}</option>`).join('')}
        </select><p class="help">The client’s administrators can manage this event. Moving it removes access for viewers of another client.</p></div>` : ''}
      </section>
      <section class="card stack">
        <div id="schedBox">${scheduleHtml()}</div>
      </section>
      <section class="card stack">
        <div class="two">
          ${text('config.details.venue', 'Venue', { placeholder: 'e.g. SMX Convention Center, Pasay City' })}
          ${text('config.details.organizer', 'Organizer', { help: 'Shown in emails: “Sent by … because you registered.”', max: 120 })}
        </div>
        ${area('config.details.intro', 'Introduction on the registration page', { help: FORMAT_HELP, rows: 4, max: 2000 })}
        <div class="two">
          <div class="field"><label for="s_tz">Time zone</label><select id="s_tz" data-path="config.details.timezone">${EG.TIMEZONES.map(([z, l]) => `<option value="${z}"${z === draft.config.details.timezone ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select><p class="help">Used for dashboard times and exports.</p></div>
          ${text('config.details.capacity', 'Capacity (optional)', { type: 'number', help: 'Registration closes automatically at this number. Leave blank for no limit.', max: 6 })}
        </div>
      </section>
`,

    checkin: () => {
      const c = draft.config.checkin;
      const opt = (key, title, help, disabled) => `<label class="check" style="align-items:flex-start${disabled ? ';opacity:.55' : ''}"><input type="checkbox" data-ck="${key}"${c[key] ? ' checked' : ''}${disabled ? ' disabled' : ''}>
        <span><b style="display:block;font-weight:600">${title}</b><span style="color:var(--muted);font-size:.86rem">${help}</span></span></label>`;
      const summary = !c.enabled
        ? 'Registration only. Attendees get a confirmation email without a QR code, and the dashboard shows registrations only.'
        : `${c.qr ? 'Attendees get a QR pass by email, and staff scan it at the desk' : 'Attendees get a confirmation email, and staff find them by name at the desk'}${c.nameTags ? ', then a name tag prints.' : '. No name tags are printed.'}`;
      return `
      <section class="card stack">
        <h3>What happens at the venue</h3>
        ${opt('enabled', 'Check attendees in at the venue', 'Staff record arrivals on the check-in page. Turn this off for events that only need a list of registrations.', false)}
        ${opt('qr', 'Send each registrant a QR pass', 'The QR code is scanned at the desk. Without it, staff look attendees up by name, and the email is a simple confirmation.', !c.enabled)}
        ${opt('nameTags', 'Print a name tag at check-in', 'Prints on a label printer as each attendee checks in. Set up the tag in the Name tag section.', !c.enabled)}
        <p class="notice info" style="margin:4px 0 0">${esc(summary)}</p>
      </section>
      ${c.enabled ? `<section class="card stack">
        <div class="field"><label for="s_pin">Staff check-in PIN</label><div class="pw-row"><input id="s_pin" type="text" data-path="staffPin" value="${esc(draft.staffPin)}" maxlength="12" inputmode="numeric"><button class="btn btn-quiet" type="button" id="pinGen">New PIN</button></div>
          <p class="help">4 to 12 digits. Staff enter it on <a href="/${esc(ev.slug)}/checkin" target="_blank" rel="noopener">${esc(location.host)}/${esc(ev.slug)}/checkin</a>. Each event has its own PIN.</p></div>
      </section>` : ''}`;
    },

    branding: () => {
      const b = draft.config.branding;
      const color = (key, label, help) => `<div class="field"><label for="c_${key}">${label}</label><div class="color-row"><input type="color" id="cp_${key}" value="${b[key].toLowerCase()}" aria-label="${label} picker"><input type="text" id="c_${key}" value="${b[key]}" maxlength="7" spellcheck="false"></div><p class="help">${help}</p><p class="warn-text" id="w_${key}" hidden></p></div>`;
      const fontSel = (key, label) => `<div class="field"><label for="f_${key}">${label}</label><select id="f_${key}" data-path="config.branding.${key}" data-after="fonts">${EG.FONTS.map((f) => `<option${f === b[key] ? ' selected' : ''}>${f}</option>`).join('')}</select><div class="font-sample" id="fs_${key}">The quick brown fox jumps over the lazy dog</div></div>`;
      return `
      <section class="card stack">
        <h3>Images</h3>
        <p class="help" style="margin:0;color:var(--muted);font-size:.82rem">Up to 2 images, for example the event logo and the organizer’s or a partner’s logo. PNG or JPG up to 5 MB. Blank margins are trimmed and each image is resized and compressed automatically, keeping its proportions.</p>
        ${[[1, 'logo', 'Image 1 (main logo)'], [2, 'logo2', 'Image 2']].map(([n, key, title]) => `<div class="logo-box">
          <div class="logo-prev">${b[key] ? `<img src="${esc(b[key])}" alt="${title}">` : 'No image'}</div>
          <div class="stack" style="gap:8px">
            <b style="font-weight:600">${title}</b>
            <div class="actions"><button class="btn btn-quiet btn-sm" type="button" data-img-pick="${n}">${b[key] ? 'Replace' : 'Upload'}</button>${b[key] ? `<button class="btn btn-quiet btn-sm btn-danger-text" type="button" data-img-remove="${n}">Remove</button>` : ''}</div>
            <input type="file" id="imgFile${n}" accept="image/png,image/jpeg" hidden>
            <p class="err" id="imgErr${n}" role="alert"></p>
          </div>
        </div>`).join('')}
      </section>
      <section class="card stack">
        <h3>Images on the registration page</h3>
        ${imageControls('page', 'The email and name tag have their own image settings in their sections.')}
      </section>
      <section class="card stack">
        <h3>Colours</h3>
        ${color('primary', 'Main colour', 'Buttons, the badge header and the email’s top bar.')}
        ${color('secondary', 'Accent colour', 'The lanyard on the badge preview and notice borders.')}
        ${color('background', 'Page background', 'Keep it light so text stays readable.')}
        <button class="linkish" type="button" id="resetColors" style="align-self:flex-start">Use the standard Jupiter colours</button>
      </section>
      <section class="card stack">
        <h3>Text</h3>
        <div class="two">${fontSel('headingFont', 'Heading font')}${fontSel('bodyFont', 'Body text font')}</div>
        <div class="field"><span class="lbl">Text size</span><div class="seg" role="group" aria-label="Text size" id="sizeSeg">
          ${Object.keys(EG.TEXT_SIZES).map((k) => `<button type="button" data-size="${k}" aria-pressed="${b.textSize === k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}
        </div><p class="help">Applies to the registration page.</p></div>
      </section>`;
    },

    form: () => `
      <section class="card stack">
        <div class="an-head"><div><h3>Fields</h3><p class="sub" style="margin:0">First name and last name are always included. Email is required while the event sends QR passes. Use the switch to hide a field, the arrows to reorder.</p></div>
          <button class="btn btn-primary btn-sm" type="button" id="addField">+ Add a field</button></div>
        <ul class="fields-list" id="fieldList">${draft.config.form.fields.map(fieldRow).join('')}</ul>
      </section>
      <section class="card stack">
        <h3>Consent</h3>
        ${check('config.form.consent.enabled', 'Ask registrants to agree to a privacy or consent statement')}
        <div class="stack" id="consentFields"${draft.config.form.consent.enabled ? '' : ' hidden'}>
          ${text('config.form.consent.title', 'Statement title', { max: 120 })}
          ${area('config.form.consent.body', 'Statement', { help: FORMAT_HELP, rows: 8, max: 6000 })}
          ${area('config.form.consent.checkbox', 'Tick box text', { rows: 2, max: 400 })}
        </div>
      </section>
      <section class="card stack">
        <h3>Buttons and messages</h3>
        <div class="two">${text('config.form.submitLabel', 'Register button', { max: 60 })}${text('config.form.successTitle', 'Heading after registering', { max: 80 })}</div>
        ${text('config.form.closedMessage', 'Message when registration is closed', { max: 300 })}
        ${check('config.form.allowAnother', 'After registering, offer a “Register another person” button')}
        <p class="help" style="margin:-6px 0 0 30px;color:var(--muted);font-size:.82rem">Useful when one person signs up colleagues, or at a registration kiosk. Turn it off to keep it to one registration per visit.</p>
      </section>`,

    email: () => {
      const c = draft.config;
      const chips = [...EG.PLACEHOLDERS, ...c.form.fields.filter((f) => f.enabled && !EG.PLACEHOLDERS.includes(f.key)).map((f) => f.key)];
      const summaryOpts = c.form.fields.filter((f) => f.enabled && !['first_name', 'last_name'].includes(f.key));
      const qr = EG.emailMode(c) === 'qr';
      const sendBox = qr ? '' : `<section class="card stack">
        ${check('config.email.send', 'Send a confirmation email to each registrant')}
        <p class="help" style="margin:0;color:var(--muted);font-size:.82rem">${c.email.send ? 'Registrants who leave the email blank (if it’s optional) don’t get one.' : 'No emails are sent. You can now make the Email field optional or hide it in the Registration form section.'}</p>
      </section>`;
      if (!qr && !c.email.send) return sendBox;
      return `
      ${!qr ? `<p class="notice info" style="margin:0">${EG.emailMode(c) === 'name' ? 'This event doesn’t use QR passes, so the email is a confirmation and attendees give their name at the desk.' : 'This event doesn’t use check-in, so the email is a simple confirmation without a QR code.'} You can change this in the Check-in section.</p>` : ''}
      ${sendBox}
      <section class="card stack">
        <div class="two">
          ${text('config.email.fromName', 'Sender name', { placeholder: c.details.name, max: 80, help: `Emails come from ${esc(platform.senderAddress || 'your MAIL_FROM address')}.` })}
          ${text('config.email.replyTo', 'Replies go to (optional)', { type: 'email', placeholder: 'e.g. events@client.com', max: 254, help: 'Where answers to the email are delivered.' })}
        </div>
        ${text('config.email.subject', 'Subject', { max: 150 })}
        ${area('config.email.body', 'Message above the QR code', { rows: 6, help: FORMAT_HELP })}
        <div class="field"><span class="lbl">Insert a detail</span><div class="chips" id="phChips">${chips.map((k) => `<button type="button" data-ph="${k}">{${k}}</button>`).join('')}</div><p class="help">Click to add to the message where your cursor is. They're replaced with each registrant's details.</p></div>
        <div class="field"><span class="lbl">Details listed under the QR code</span><div class="checks" id="sumChecks">
          ${summaryOpts.map((f) => `<label class="check"><input type="checkbox" value="${f.key}"${c.email.summaryFields.includes(f.key) ? ' checked' : ''}> <span>${esc(f.label)}</span></label>`).join('')}
        </div><p class="help">The attendee's name is always listed.</p></div>
        ${area('config.email.footer', 'Note at the bottom', { rows: 3, max: 1000 })}
      </section>
      <section class="card stack">
        <h3>Images in the email</h3>
        ${imageControls('email')}
      </section>
      <section class="card stack">
        <h3>Send a test</h3>
        <p class="sub" style="margin:0">Sends this email, with your unsaved changes and a sample pass, to the address below.</p>
        <div class="pw-row"><input id="testTo" type="email" placeholder="you@example.com" style="flex:1;min-width:0;font:inherit;color:var(--ink);background:var(--surface-2);border:1.5px solid var(--line);border-radius:10px;padding:.55rem .7rem;min-height:44px"><button class="btn btn-primary" type="button" id="testSend">Send test</button></div>
        <p class="hint" id="testMsg" role="status"></p>
      </section>`;
    },

    tag: () => {
      const c = draft.config;
      const opts = (sel) => `<option value="">Nothing</option>` + c.form.fields.filter((f) => f.enabled && !['first_name', 'last_name'].includes(f.key)).map((f) => `<option value="${f.key}"${f.key === sel ? ' selected' : ''}>${esc(f.label)}</option>`).join('');
      return `
      <section class="card stack">
        <p class="sub" style="margin:0">Printed at the check-in desk when an attendee arrives. Their full name is always the main line. The same lines appear on the badge preview on the registration page.</p>
        <div class="two">
          <div class="field"><label for="s_l2">Second line</label><select id="s_l2" data-path="config.badge.line2">${opts(c.badge.line2)}</select></div>
          <div class="field"><label for="s_l3">Third line</label><select id="s_l3" data-path="config.badge.line3">${opts(c.badge.line3)}</select></div>
        </div>
        ${check('config.badge.showEventName', 'Show the event name at the top')}
      </section>
      <section class="card stack">
        <h3>Images on the name tag</h3>
        ${imageControls('tag', 'Most label printers print images in black and white.')}
      </section>`;
    },
  };

  // ---- event date and time
  function timeOptions(selected, after, empty) {
    return `<option value="">${esc(empty)}</option>` + EG.TIMES.filter((t) => !after || t > after)
      .map((t) => `<option value="${t}"${t === selected ? ' selected' : ''}>${EG.timeLabel(t)}</option>`).join('');
  }
  function scheduleHtml() {
    const d = draft.config.details, s = d.schedule;
    const multi = s.days === 'multi';
    const legacy = !s.start && d.date ? `<p class="notice info" style="margin:0">Currently shown as “${esc(d.date)}”. Choose a date below to replace it.</p>` : '';
    return `<div class="stack">
      <h3>Date and time</h3>
      <div class="field"><span class="lbl">How long is the event?</span><div class="seg" role="group" aria-label="Event length">
        <button type="button" data-days="one" aria-pressed="${!multi}">One day</button><button type="button" data-days="multi" aria-pressed="${multi}">Several days</button>
      </div></div>
      ${legacy}
      <div class="two">
        <div class="field"><label for="s_start">${multi ? 'First day' : 'Date'}</label><input id="s_start" type="date" class="date-pick" value="${esc(s.start)}"></div>
        ${multi ? `<div class="field"><label for="s_end">Last day</label><input id="s_end" type="date" class="date-pick" value="${esc(s.end)}"${s.start ? ` min="${esc(s.start)}"` : ''}></div>` : ''}
      </div>
      <div class="two">
        <div class="field"><label for="s_from">Start time</label><select id="s_from">${timeOptions(s.from, '', 'Choose a time')}</select></div>
        <div class="field"><label for="s_to">End time <span style="font-weight:400;color:var(--muted)">(optional)</span></label><select id="s_to"${s.from ? '' : ' disabled'}>${timeOptions(s.to, s.from, s.from ? 'No end time' : 'Choose a start time first')}</select></div>
      </div>
      ${multi ? '<p class="help" style="margin:0;color:var(--muted);font-size:.86rem">The same start and end time apply to each day.</p>' : ''}
      <p class="err" id="schedErr" role="alert"></p>
      <p class="help" style="margin:0;color:var(--muted);font-size:.86rem" id="schedOut"></p>
    </div>`;
  }
  function syncSchedule() {
    const s = draft.config.details.schedule;
    const problem = EG.scheduleProblem(s);
    $('schedErr').textContent = problem;
    $('schedOut').innerHTML = s.start ? `Shown on the registration page and email as: <b style="color:var(--ink)">${esc(EG.formatSchedule(s))}</b>` : 'Choose a date. It opens a calendar.';
  }
  function wireSchedule() {
    const s = draft.config.details.schedule;
    const box = $('schedBox');
    const redraw = () => { box.innerHTML = scheduleHtml(); wireSchedule(); };
    box.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => {
      s.days = b.dataset.days;
      if (s.days === 'one') s.end = '';
      redraw(); changed();
      box.querySelector(`[data-days="${s.days}"]`).focus();
    }));
    // Clicking anywhere in a date box opens the calendar.
    box.querySelectorAll('.date-pick').forEach((el) => el.addEventListener('click', () => { try { el.showPicker(); } catch {} }));
    $('s_start').addEventListener('change', (e) => {
      s.start = e.target.value;
      if ($('s_end')) { $('s_end').min = s.start; if (s.end && s.end <= s.start) { s.end = ''; $('s_end').value = ''; } }
      syncSchedule(); changed();
    });
    if ($('s_end')) $('s_end').addEventListener('change', (e) => { s.end = e.target.value; syncSchedule(); changed(); });
    $('s_from').addEventListener('change', (e) => {
      s.from = e.target.value;
      if (!s.from || (s.to && s.to <= s.from)) s.to = '';
      const to = $('s_to');
      to.innerHTML = timeOptions(s.to, s.from, s.from ? 'No end time' : 'Choose a start time first');
      to.disabled = !s.from;
      syncSchedule(); changed();
    });
    $('s_to').addEventListener('change', (e) => { s.to = e.target.value; syncSchedule(); changed(); });
    syncSchedule();
  }

  // ---- fields list
  function fieldRow(f, i, all) {
    const rules = EG.emailRules(draft.config);
    const locked = EG.LOCKED.includes(f.key);
    const lockShown = locked || (f.key === 'email' && rules.enabledLocked);
    const lockRequired = locked || (f.key === 'email' && rules.requiredLocked);
    // These types always take the full width on the page, so the width choice is hidden.
    const fixedWidth = ['checkbox', 'radio', 'textarea', 'address_ph'].includes(f.type);
    const builtin = EG.BUILTIN.includes(f.key);
    const n = (all || draft.config.form.fields).length;
    const typeChoices = builtin ? (f.key === 'contact_number' ? ['phone_ph', 'phone', 'text'] : f.key === 'company_address' ? ['address_ph', 'textarea', 'text'] : [f.type]) : Object.keys(EG.FIELD_TYPES).filter((t) => t !== 'email');
    const isOpen = openKey === f.key;
    return `<li class="frow${f.enabled ? '' : ' off'}" data-key="${f.key}">
      <div class="fhead">
        <div class="order">
          <button type="button" data-mv="-1" aria-label="Move ${esc(f.label)} up"${i === 0 ? ' disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg></button>
          <button type="button" data-mv="1" aria-label="Move ${esc(f.label)} down"${i === n - 1 ? ' disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
        </div>
        <div class="ftitle"><b data-title>${esc(f.label)}</b><span data-meta>${esc(fieldMeta(f))}</span></div>
        <div class="fctl">
          <label class="switch" title="${lockShown ? 'Always shown' : 'Show on the form'}"><input type="checkbox" data-f="enabled"${f.enabled ? ' checked' : ''}${lockShown ? ' disabled' : ''} aria-label="Show ${esc(f.label)} on the form"></label>
          <button class="btn btn-quiet btn-sm" type="button" data-f-act="edit" aria-expanded="${isOpen}">${isOpen ? 'Done' : 'Edit'}</button>
        </div>
      </div>
      ${isOpen ? `<div class="fedit">
        <div class="two">
          <div class="field"><label>${f.type === 'checkbox' ? 'Text beside the tick box' : f.type === 'yesno' ? 'Question' : 'Label'}</label><input type="text" data-f="label" value="${esc(f.label)}" maxlength="80"${f.type === 'checkbox' ? ' placeholder="e.g. I will attend the networking dinner"' : f.type === 'yesno' ? ' placeholder="e.g. Will you attend the networking dinner?"' : ''}></div>
          <div class="field"><label>Type</label><select data-f="type"${typeChoices.length < 2 ? ' disabled' : ''}>${typeChoices.map((t) => `<option value="${t}"${t === f.type ? ' selected' : ''}>${esc(fieldTypeLabel(t))}</option>`).join('')}</select></div>
        </div>
        <div class="two">
          ${fixedWidth ? '' : `<div class="field"><label>Width</label><select data-f="width"><option value="half"${f.width !== 'full' ? ' selected' : ''}>Half width</option><option value="full"${f.width === 'full' ? ' selected' : ''}>Full width</option></select></div>`}
          <div class="field">${fixedWidth ? '' : '<span class="lbl">&nbsp;</span>'}<label class="check"><input type="checkbox" data-f="required"${f.required ? ' checked' : ''}${lockRequired || !f.enabled ? ' disabled' : ''}> <span>${f.type === 'checkbox' ? 'Must be ticked to register' : f.type === 'yesno' ? 'Required (must answer Yes or No)' : 'Required'}</span></label></div>
        </div>
        ${f.type === 'checkbox' ? '<p class="help" style="margin:0;color:var(--muted);font-size:.82rem">One box the registrant ticks to confirm or agree, recorded as Yes (ticked) or No. If it must be ticked, nobody can answer No, so for a real choice use the <b>Yes / No question</b> type instead.</p>' : ''}
        ${f.type === 'yesno' ? '<p class="help" style="margin:0;color:var(--muted);font-size:.82rem">Registrants choose Yes or No. If it isn’t required, they can leave it unanswered.</p>' : ''}
        ${f.key === 'email' ? `<p class="help" style="margin:0;color:var(--muted);font-size:.82rem">${rules.requiredLocked ? 'Required while the event sends QR passes, because the pass is emailed to this address. To make it optional, turn off QR passes in the Check-in section.'
          : rules.enabledLocked ? 'Can be optional because this event has no QR pass. Registrants who leave it blank won’t get a confirmation email. To remove it from the form, turn off the confirmation email in the Email section.'
          : 'The event sends no confirmation email, so you can make this optional or hide it.'}</p>` : ''}
        ${f.type === 'address_ph' ? '<p class="help" style="margin:0">Registrants type the unit, floor, building and street, then choose the region, province, city or municipality and barangay from lists (PSA 2025 data). The postal code fills in automatically when the city has only one.</p>' : ''}
        ${f.type === 'checkbox' ? '' : `<div class="field"><label>${['select'].includes(f.type) ? 'Text shown before a choice is made' : 'Example text inside the box'}</label><input type="text" data-f="placeholder" value="${esc(f.placeholder)}" maxlength="80"></div>`}
        <div class="field"><label>Help text under the field</label><input type="text" data-f="help" value="${esc(f.help)}" maxlength="160"></div>
        ${['select', 'radio'].includes(f.type) ? `<div class="field"><label>Choices</label><textarea data-f="options" rows="4">${esc((f.options || []).join('\n'))}</textarea><p class="help">One choice per line.</p></div>` : ''}
        ${builtin ? '' : '<div><button class="btn btn-quiet btn-sm btn-danger-text" type="button" data-f-act="remove">Remove this field</button></div>'}
      </div>` : ''}
    </li>`;
  }
  function renderFields() {
    const list = $('fieldList');
    if (list) list.innerHTML = draft.config.form.fields.map(fieldRow).join('');
  }

  const WIRE = {
    details(body) {
      body.querySelectorAll('input[name="s_status"]').forEach((r) => r.addEventListener('change', () => { draft.status = r.value; changed(); }));
      $('s_slug').addEventListener('input', (e) => { const s = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'); if (s !== e.target.value) e.target.value = s; draft.slug = s; changed(); });
      wireSchedule();
      if ($('s_client')) $('s_client').addEventListener('change', (e) => { draft.clientId = e.target.value ? Number(e.target.value) : null; changed(); });
    },
    checkin(body) {
      if ($('pinGen')) $('pinGen').addEventListener('click', () => { const pin = String(100000 + Math.floor(Math.random() * 900000)); $('s_pin').value = pin; draft.staffPin = pin; changed(); });
      body.querySelectorAll('[data-ck]').forEach((el) => el.addEventListener('change', () => {
        const c = draft.config.checkin;
        const before = EG.emailMode(draft.config);
        c[el.dataset.ck] = el.checked;
        if (el.dataset.ck === 'enabled') { c.qr = el.checked; c.nameTags = el.checked; }
        // Standard email wording and button text follow the change; wording you wrote yourself is kept.
        const after = EG.emailMode(draft.config);
        if (before !== after) {
          const em = draft.config.email;
          const isStandard = (k) => Object.values(EG.EMAIL_TEXT).some((m) => m[k] && em[k] === m[k]) || (!em[k] && k === 'footer');
          for (const k of ['subject', 'body', 'footer']) if (isStandard(k)) em[k] = EG.EMAIL_TEXT[after][k];
          const f = draft.config.form;
          if (after !== 'qr' && f.submitLabel === 'Register and email my pass') f.submitLabel = 'Register';
          if (after === 'qr' && f.submitLabel === 'Register') f.submitLabel = 'Register and email my pass';
        }
        syncOptions();
        renderSection();
        changed();
      }));
    },
    branding(body) {
      for (const key of ['primary', 'secondary', 'background']) {
        const pick = $(`cp_${key}`), hex = $(`c_${key}`);
        pick.addEventListener('input', () => { hex.value = pick.value.toUpperCase(); draft.config.branding[key] = hex.value; colorWarnings(); changed(); });
        hex.addEventListener('input', () => {
          let s = hex.value.trim(); if (!s.startsWith('#')) s = `#${s}`;
          if (/^#[0-9a-fA-F]{6}$/.test(s)) { draft.config.branding[key] = s.toUpperCase(); pick.value = s.toLowerCase(); colorWarnings(); changed(); }
        });
      }
      $('resetColors').addEventListener('click', () => {
        Object.assign(draft.config.branding, { primary: '#E00000', secondary: '#141414', background: '#F2F2F2' });
        renderSection(); changed();
      });
      body.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => {
        draft.config.branding.textSize = b.dataset.size;
        body.querySelectorAll('[data-size]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        changed();
      }));
      const keyOf = (n) => (n === '1' ? 'logo' : 'logo2');
      body.querySelectorAll('[data-img-pick]').forEach((btn) => btn.addEventListener('click', () => $(`imgFile${btn.dataset.imgPick}`).click()));
      body.querySelectorAll('[data-img-remove]').forEach((btn) => btn.addEventListener('click', () => {
        const k = keyOf(btn.dataset.imgRemove);
        draft.config.branding[k] = null; draft.config.branding[`${k}Dims`] = null;
        renderSection(); changed();
      }));
      for (const n of ['1', '2']) {
        $(`imgFile${n}`).addEventListener('change', async (e) => {
          const file = e.target.files[0], err = $(`imgErr${n}`);
          err.textContent = '';
          if (!file) return;
          if (!['image/png', 'image/jpeg'].includes(file.type)) { err.textContent = 'Choose a PNG or JPG image.'; return; }
          if (file.size > 5 * 1024 * 1024) { err.textContent = 'That image is larger than 5 MB. Use a smaller file.'; return; }
          err.textContent = 'Uploading and optimizing…';
          try {
            const r = await fetch(`/api/admin/events/${ev.id}/logo`, { method: 'POST', headers: { 'content-type': file.type }, body: file });
            const out = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(out.message || 'The image could not be uploaded.');
            const k = keyOf(n);
            draft.config.branding[k] = out.logo;
            draft.config.branding[`${k}Dims`] = out.dims || null;
            renderSection(); changed();
          } catch (ex) { err.textContent = ex.message; }
        });
      }
      colorWarnings();
      fontSamples();
    },
    form(body) {
      $('addField').addEventListener('click', () => {
        const key = `c_${Math.random().toString(36).slice(2, 8)}`;
        draft.config.form.fields.push({ key, type: 'text', label: 'New question', required: false, enabled: true, width: 'half', placeholder: '', help: '' });
        openKey = key;
        renderFields(); changed();
        const input = body.querySelector(`[data-key="${key}"] [data-f="label"]`);
        if (input) { input.focus(); input.select(); input.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      });
      const consentBox = body.querySelector('[data-path="config.form.consent.enabled"]');
      consentBox.addEventListener('change', () => { $('consentFields').hidden = !consentBox.checked; });
      const list = $('fieldList');
      const fieldAt = (el) => { const li = el.closest('[data-key]'); return li && draft.config.form.fields.find((f) => f.key === li.dataset.key); };
      list.addEventListener('click', (e) => {
        const mv = e.target.closest('[data-mv]');
        const act = e.target.closest('[data-f-act]');
        const f = fieldAt(e.target);
        if (!f) return;
        const arr = draft.config.form.fields;
        if (mv) {
          const i = arr.indexOf(f), j = i + Number(mv.dataset.mv);
          if (j < 0 || j >= arr.length) return;
          [arr[i], arr[j]] = [arr[j], arr[i]];
          renderFields(); changed();
          const again = list.querySelector(`[data-key="${f.key}"] [data-mv="${mv.dataset.mv}"]`);
          if (again && !again.disabled) again.focus();
        } else if (act && act.dataset.fAct === 'edit') {
          openKey = openKey === f.key ? null : f.key;
          renderFields();
        } else if (act && act.dataset.fAct === 'remove') {
          if (!confirm(`Remove “${f.label}” from the form? Answers already collected stay in the records but won't show on the dashboard or in exports.`)) return;
          draft.config.form.fields = arr.filter((x) => x !== f);
          for (const k of ['line2', 'line3']) if (draft.config.badge[k] === f.key) draft.config.badge[k] = '';
          draft.config.email.summaryFields = draft.config.email.summaryFields.filter((k) => k !== f.key);
          openKey = null;
          renderFields(); changed();
        }
      });
      const onEdit = (e) => {
        const el = e.target.closest('[data-f]');
        const f = el && fieldAt(el);
        if (!f) return;
        const k = el.dataset.f;
        if (k === 'enabled' || k === 'required') f[k] = el.checked;
        else if (k === 'options') f.options = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
        else f[k] = el.value;
        if (k === 'type' && ['select', 'radio'].includes(f.type) && !(f.options && f.options.length)) f.options = ['Option 1', 'Option 2'];
        if (k === 'type' && ['checkbox', 'radio', 'textarea', 'address_ph'].includes(f.type)) f.width = 'full';
        const li = el.closest('[data-key]');
        if (k === 'type' || k === 'enabled') { renderFields(); }
        else {
          li.querySelector('[data-title]').textContent = f.label;
          li.querySelector('[data-meta]').textContent = fieldMeta(f);
        }
        changed();
      };
      list.addEventListener('input', (e) => { if (e.target.matches('input[type=text], textarea')) onEdit(e); });
      list.addEventListener('change', (e) => { if (e.target.matches('select, input[type=checkbox]')) onEdit(e); });
    },
    email(body) {
      const sendBox = body.querySelector('[data-path="config.email.send"]');
      if (sendBox) sendBox.addEventListener('change', () => { applyEmailRules(); renderSection(); });
      if (!$('phChips')) return;
      let lastArea = $('s_config.email.body');
      body.querySelectorAll('textarea, input[type=text]').forEach((el) => el.addEventListener('focus', () => { if (el.dataset.path && /email\.(body|subject|footer)$/.test(el.dataset.path)) lastArea = el; }));
      $('phChips').addEventListener('click', (e) => {
        const b = e.target.closest('[data-ph]');
        if (!b || !lastArea) return;
        const token = `{${b.dataset.ph}}`;
        const s = lastArea.selectionStart ?? lastArea.value.length, en = lastArea.selectionEnd ?? s;
        lastArea.value = lastArea.value.slice(0, s) + token + lastArea.value.slice(en);
        lastArea.focus();
        lastArea.setSelectionRange(s + token.length, s + token.length);
        lastArea.dispatchEvent(new Event('input', { bubbles: true }));
      });
      $('sumChecks').addEventListener('change', () => {
        draft.config.email.summaryFields = [...$('sumChecks').querySelectorAll('input:checked')].map((i) => i.value);
        changed();
      });
      $('testSend').addEventListener('click', async () => {
        const to = $('testTo').value.trim();
        $('testMsg').textContent = 'Sending…';
        try {
          await A.post(`/api/admin/events/${ev.id}/email-test`, { to, config: draft.config });
          $('testMsg').textContent = platform.smtp ? `Sent to ${to}. Check the inbox (and spam folder) in a minute.` : 'Built, but email isn’t set up on this server, so it was saved to the outbox folder instead of being sent.';
        } catch (err) { $('testMsg').textContent = err.message; }
      });
    },
  };

  function colorWarnings() {
    const b = draft.config.branding;
    const set = (k, msg) => { const el = $(`w_${k}`); if (el) { el.textContent = msg || ''; el.hidden = !msg; } };
    set('background', EG.contrast(b.background, '#5C5C5C') < 4.5 ? 'This background is too dark: grey text on the page will be hard to read. Choose a lighter colour.' : '');
    set('primary', EG.contrast(b.primary, b.background) < 2 ? 'Buttons will blend into the background. Choose a stronger main colour.' : '');
    set('secondary', '');
  }
  function fontSamples() {
    const b = draft.config.branding;
    const url = EG.googleFontsUrl([b.headingFont, b.bodyFont]);
    if (url && !document.querySelector(`link[href="${url}"]`)) {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = url; document.head.appendChild(l);
    }
    for (const k of ['headingFont', 'bodyFont']) { const el = $(`fs_${k}`); if (el) el.style.fontFamily = EG.fontStack(b[k]); }
  }

  // ------------------------------------------------------------ save
  async function save() {
    const btn = $('saveBtn');
    const problem = EG.scheduleProblem(draft.config.details.schedule);
    if (problem) {
      $('saveErr').textContent = `Date and time: ${problem}`;
      if (section !== 'details') showSection('details');
      return;
    }
    btn.disabled = true;
    $('saveErr').textContent = '';
    try {
      const fresh = await A.post(`/api/admin/events/${ev.id}`, { slug: draft.slug, status: draft.status, staffPin: draft.staffPin, config: draft.config, ...(A.me && A.me.role === 'owner' ? { clientId: draft.clientId } : {}) }, 'PUT');
      const slugChanged = fresh.slug !== ev.slug;
      ev = { ...ev, ...fresh };
      draft = clone({ slug: fresh.slug, status: fresh.status, staffPin: fresh.staffPin, clientId: fresh.clientId || null, config: fresh.config });
      saved = JSON.stringify(draft);
      if (slugChanged) $('pageFrame').src = `/${encodeURIComponent(fresh.slug)}?preview=1`;
      renderSection();
      changed();
      if (onSaved) await onSaved(fresh);
      A.reloadEvents().catch(() => {});
    } catch (err) {
      if (err.message !== 'signed out') $('saveErr').textContent = err.message;
    } finally { btn.disabled = false; }
  }

  window.Settings = { open, close, isDirty };
})();
