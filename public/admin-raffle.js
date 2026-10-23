/* Raffle tab of an event: turn the raffle on, choose who can win, set the draw screen PIN,
   list the prizes in draw order, and keep the record of winners (claimed, no-show). */
(() => {
  'use strict';
  const A = window.App;
  const { $, esc } = A;
  const root = $('tRaffle');
  let ev = null;
  let st = null;
  let ent = { adjusted: [], results: [] };   // entries set by staff: changed ones + search results
  let entQuery = '';

  const base = () => `/api/admin/events/${ev.id}/raffle`;
  const STATUS = { won: ['Won', 'in'], claimed: ['Prize claimed', 'in'], noshow: ['No-show (redrawn)', 'off'] };
  const fmtTime = (iso) => (iso ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '');

  async function open(e) {
    ev = e;
    root.hidden = false;
    root.innerHTML = '<p class="sub">Loading the raffle…</p>';
    try { st = await A.api(base()); await loadEntries(); render(); } catch (err) { if (err.message !== 'signed out') root.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  }
  async function loadEntries() {
    if (!st || st.entries !== 'staff') return;
    try { ent = await A.api(`${base()}/entries?q=${encodeURIComponent(entQuery)}`); } catch {}
  }
  function close() { root.hidden = true; ev = null; }
  async function reload() {
    if (!ev || root.hidden) return;
    // don't redraw while someone is typing in the entries search or a number box
    if (root.contains(document.activeElement) && document.activeElement.matches('input')) return;
    try { st = await A.api(base()); await loadEntries(); render(); } catch {}
  }

  async function act(fn) {
    try { st = { ...st, ...(await fn()) }; await loadEntries(); render(); }
    catch (err) { if (err.message !== 'signed out') alert(err.message); }
  }
  const put = (body) => A.post(`${base()}/settings`, body, 'PUT');

  function render() {
    const screenUrl = `${location.origin}/${st.slug}/raffle`;
    const winners = st.prizes.flatMap((p) => [...p.winners, ...p.noShows].map((w) => ({ ...w, prize: p.name }))).sort((a, b) => (a.drawnAt < b.drawnAt ? 1 : -1));
    const drawnAny = st.prizes.some((p) => p.winners.length || p.noShows.length);
    root.innerHTML = `
      <section class="card stack">
        <label class="check" style="align-items:flex-start"><input type="checkbox" id="rOn"${st.enabled ? ' checked' : ''}>
          <span><b style="display:block;font-weight:600">Hold a raffle at this event</b><span style="color:var(--muted);font-size:.86rem">Prizes are drawn on a projector screen. Winners are picked by the server at random and every draw is recorded.</span></span></label>
        ${st.enabled ? `
        <div class="field"><span class="lbl">Who can win</span><div class="seg" role="group" aria-label="Who can win">
          <button type="button" data-pool="checkedIn" aria-pressed="${st.pool === 'checkedIn'}"${st.checkin ? '' : ' disabled'}>Checked-in attendees</button><button type="button" data-pool="registered" aria-pressed="${st.pool === 'registered'}">Everyone registered</button>
        </div><p class="help">${st.checkin ? 'Checked-in attendees is recommended: people who didn’t come can’t win.' : 'This event doesn’t use check-in, so everyone registered can win.'}</p></div>
        <div class="two">
          <div class="field"><span class="lbl">Entries per person</span><div class="seg" role="group" aria-label="Entries per person">
            <button type="button" data-entries="one" aria-pressed="${st.entries === 'one'}">One each</button><button type="button" data-entries="staff" aria-pressed="${st.entries === 'staff'}">Set by staff</button>
          </div><p class="help">${st.entries === 'staff' ? 'Everyone starts with 1. Staff give extra entries, or 0 to leave someone out, in the Entries section below. More entries mean better odds.' : 'Everyone has the same chance.'}</p></div>
          <div class="field"><span class="lbl">If a winner isn’t in the room</span><div class="seg" role="group" aria-label="If a winner isn’t in the room">
            <button type="button" data-present="1" aria-pressed="${st.mustBePresent}">Draw again</button><button type="button" data-present="0" aria-pressed="${!st.mustBePresent}">Keep the winner</button>
          </div><p class="help">${st.mustBePresent ? 'Winners must be present. The draw screen shows “Not here? Redraw”.' : 'Winners who stepped out or left keep the prize and claim it later.'}</p></div>
        </div>
        <label class="check"><input type="checkbox" id="rOnce"${st.oncePerPerson ? ' checked' : ''}> <span>Each person can win only one prize</span></label>
        <p class="notice info" style="margin:0"><b>${A.nf.format(st.eligible)}</b> ${st.eligible === 1 ? 'person can' : 'people can'} win right now${st.entries === 'staff' ? `, with <b>${A.nf.format(st.totalEntries)}</b> ${st.totalEntries === 1 ? 'entry' : 'entries'} in all` : ''}${st.pool === 'checkedIn' ? '. Only people who checked in are counted' : ''}.</p>` : ''}
      </section>
      ${st.enabled ? `
      <section class="card stack">
        <h3>Draw screen</h3>
        <p class="sub" style="margin:0">Open it on the laptop connected to the projector. You can sign in there as an administrator, or enter the raffle PIN, so the emcee doesn’t need an admin account.</p>
        <div class="pw-row" style="flex-wrap:wrap"><a class="btn btn-primary" href="/${esc(st.slug)}/raffle" target="_blank" rel="noopener">Open draw screen</a>
          <input type="text" readonly value="${esc(screenUrl)}" aria-label="Draw screen address" style="flex:1;min-width:200px;font:inherit;color:var(--ink);background:var(--surface-2);border:1.5px solid var(--line);border-radius:10px;padding:.55rem .7rem;min-height:44px"></div>
        <div class="field" style="margin:0"><label for="rPin">Raffle PIN</label><div class="pw-row"><input id="rPin" type="text" inputmode="numeric" maxlength="12" value="${esc(st.pin)}" style="max-width:180px"><button class="btn btn-quiet" type="button" id="rPinSave">Save PIN</button><button class="btn btn-quiet" type="button" id="rPinNew">New PIN</button></div>
          <p class="help">4 to 12 digits, separate from the check-in PIN. Change it after the event.</p><p class="err" id="rPinErr"></p></div>
      </section>
      ${st.entries === 'staff' ? entriesHtml() : ''}
      <section class="card stack">
        <div class="an-head"><div><h3>Prizes</h3><p class="sub" style="margin:0">In the order they’re drawn, usually smaller prizes first and the grand prize last.</p></div></div>
        <div class="table-box"><table class="list">
          <thead><tr><th scope="col">Order</th><th scope="col">Prize</th><th scope="col">How many</th><th scope="col">Drawn</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody>${st.prizes.length ? st.prizes.map((p, i) => `<tr data-pid="${p.id}">
            <td><div class="order" style="display:flex;gap:4px"><button class="btn btn-quiet btn-sm" type="button" data-move="-1" aria-label="Move ${esc(p.name)} up"${i === 0 ? ' disabled' : ''}>↑</button><button class="btn btn-quiet btn-sm" type="button" data-move="1" aria-label="Move ${esc(p.name)} down"${i === st.prizes.length - 1 ? ' disabled' : ''}>↓</button></div></td>
            <td><b>${esc(p.name)}</b></td><td class="num">${A.nf.format(p.quantity)}</td>
            <td class="num">${A.nf.format(p.drawn)} of ${A.nf.format(p.quantity)}${p.noShows.length ? `<span class="small">${p.noShows.length} no-show</span>` : ''}</td>
            <td><div class="row-actions"><button class="btn btn-quiet btn-sm" type="button" data-pact="edit">Edit…</button>${p.drawn || p.noShows.length ? '' : '<button class="btn btn-quiet btn-sm btn-danger-text" type="button" data-pact="delete">Remove</button>'}</div></td></tr>`).join('')
            : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:22px">No prizes yet. Add the first one below.</td></tr>'}</tbody>
        </table></div>
        <form id="rAdd" class="pw-row" style="flex-wrap:wrap" novalidate>
          <input id="rName" type="text" maxlength="120" placeholder="Prize, e.g. Grand prize: Laptop" aria-label="Prize name" style="flex:2;min-width:220px;font:inherit;color:var(--ink);background:var(--surface-2);border:1.5px solid var(--line);border-radius:10px;padding:.55rem .7rem;min-height:44px">
          <input id="rQty" type="number" min="1" max="1000" value="1" aria-label="How many" style="width:100px;font:inherit;color:var(--ink);background:var(--surface-2);border:1.5px solid var(--line);border-radius:10px;padding:.55rem .7rem;min-height:44px">
          <button class="btn btn-primary" type="submit">Add prize</button>
        </form>
        <p class="err" id="rAddErr" role="alert"></p>
      </section>
      <section class="card stack">
        <h3>Winners</h3>
        <p class="sub" style="margin:0">Newest first. Mark a prize as claimed when it’s handed over. The full list is also in the Excel report, on the Raffle winners tab.</p>
        <div class="table-box"><table class="list">
          <thead><tr><th scope="col">Prize</th><th scope="col">Winner</th><th scope="col">Drawn</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody>${winners.length ? winners.map((w) => `<tr data-did="${w.id}">
            <td>${esc(w.prize)}</td><td><b>${esc(w.name)}</b>${w.detail ? `<span class="small">${esc(w.detail)}</span>` : ''}${w.passCode ? `<span class="small">Pass ${esc(w.passCode)}</span>` : ''}</td>
            <td class="num">${esc(fmtTime(w.drawnAt))}<span class="small">${esc(w.drawnBy)}</span></td>
            <td><span class="badge ${STATUS[w.status][1]}">${STATUS[w.status][0]}</span></td>
            <td><div class="row-actions">${w.status === 'won' ? '<button class="btn btn-quiet btn-sm" type="button" data-status="claimed">Mark claimed</button><button class="btn btn-quiet btn-sm" type="button" data-status="noshow">Mark no-show</button>'
              : w.status === 'claimed' ? '<button class="btn btn-quiet btn-sm" type="button" data-status="won">Undo claimed</button>'
              : '<button class="btn btn-quiet btn-sm" type="button" data-status="won">Restore as winner</button>'}</div></td></tr>`).join('')
            : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:22px">No draws yet.</td></tr>'}</tbody>
        </table></div>
      </section>
      ${drawnAny ? `<section class="card danger-card stack" style="border:1.5px solid var(--line)">
        <div class="an-head"><div><h3>Start the raffle over</h3><p class="sub" style="margin:0">Removes every draw and winner. The prizes stay. Use it after a rehearsal, not after the real draw.</p></div>
        <button class="btn btn-quiet btn-danger-text" type="button" id="rReset">Start over…</button></div>
      </section>` : ''}` : ''}`;
    wire();
  }

  // People with their entries: a number box with − and + buttons, and an optional reason.
  function entryRow(p) {
    return `<tr data-rid="${p.id}">
      <td><b>${esc(p.name)}</b>${p.detail ? `<span class="small">${esc(p.detail)}</span>` : ''}<span class="small">Pass ${esc(p.passCode)}${p.checkedIn ? ' · checked in' : ''}</span></td>
      <td><div class="pw-row" style="gap:6px;flex-wrap:nowrap"><button class="btn btn-quiet btn-sm" type="button" data-step="-1" aria-label="One less entry for ${esc(p.name)}">−</button>
        <input type="number" min="0" max="1000" value="${p.entries}" data-entries-for="${p.id}" aria-label="Entries for ${esc(p.name)}" style="width:76px;text-align:center;font:inherit;color:var(--ink);background:var(--surface-2);border:1.5px solid var(--line);border-radius:10px;padding:.4rem .5rem;min-height:38px">
        <button class="btn btn-quiet btn-sm" type="button" data-step="1" aria-label="One more entry for ${esc(p.name)}">+</button></div></td>
      <td><input type="text" maxlength="120" value="${esc(p.note)}" data-note-for="${p.id}" placeholder="Reason (optional)" aria-label="Reason for ${esc(p.name)}’s entries" style="width:100%;min-width:160px;font:inherit;color:var(--ink);background:var(--surface-2);border:1.5px solid var(--line);border-radius:10px;padding:.4rem .6rem;min-height:38px"></td>
      <td class="small" data-saved="${p.id}" style="color:var(--muted)">${p.entries === 0 ? 'Left out' : ''}</td></tr>`;
  }
  function entriesHtml() {
    const table = (rows, empty) => `<div class="table-box"><table class="list"><thead><tr><th scope="col">Person</th><th scope="col">Entries</th><th scope="col">Reason</th><th scope="col"><span class="visually-hidden">Saved</span></th></tr></thead>
      <tbody>${rows.length ? rows.map(entryRow).join('') : `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:18px">${empty}</td></tr>`}</tbody></table></div>`;
    return `<section class="card stack" id="entriesCard">
      <h3>Entries</h3>
      <p class="sub" style="margin:0">Everyone has 1 entry unless changed here. Give extra entries, for example for visiting sponsor booths, or 0 to leave someone out, such as organizers and staff. Changes save as you make them.</p>
      <input type="search" id="eQ" value="${esc(entQuery)}" placeholder="Find someone by name, company, email or pass code" aria-label="Find a registrant" style="font:inherit;color:var(--ink);background:var(--surface-2);border:1.5px solid var(--line);border-radius:10px;padding:.55rem .7rem;min-height:44px">
      ${entQuery.trim().length >= 2 ? table(ent.results, 'No one matches that search.') : ''}
      <h4 style="margin:6px 0 0">Changed entries (${ent.adjusted.length})</h4>
      ${table(ent.adjusted, 'No one has extra or zero entries yet.')}
      ${ent.adjusted.length ? '<div><button class="btn btn-quiet btn-sm btn-danger-text" type="button" id="eReset">Set everyone back to 1 entry…</button></div>' : ''}
    </section>`;
  }
  let searchTimer = null;
  function wireEntries() {
    const card = $('entriesCard');
    if (!card) return;
    $('eQ').addEventListener('input', (e) => {
      entQuery = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        await loadEntries(); render();
        const q = $('eQ'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      }, 300);
    });
    const save = async (rid) => {
      const box = card.querySelector(`[data-entries-for="${rid}"]`), note = card.querySelector(`[data-note-for="${rid}"]`), mark = card.querySelector(`[data-saved="${rid}"]`);
      const n = Math.max(0, Math.min(1000, Math.floor(Number(box.value) || 0)));
      box.value = n;
      try {
        const out = await A.post(`${base()}/entries/${rid}`, { entries: n, note: note.value }, 'PUT');
        st = { ...st, ...out.state };
        card.querySelectorAll(`[data-saved="${rid}"]`).forEach((m) => { m.textContent = n === 0 ? 'Left out · saved' : 'Saved'; });
        card.querySelectorAll(`[data-entries-for="${rid}"]`).forEach((b) => { b.value = n; });
        const info = root.querySelector('.notice.info');
        if (info) info.innerHTML = `<b>${A.nf.format(st.eligible)}</b> ${st.eligible === 1 ? 'person can' : 'people can'} win right now, with <b>${A.nf.format(st.totalEntries)}</b> ${st.totalEntries === 1 ? 'entry' : 'entries'} in all${st.pool === 'checkedIn' ? '. Only people who checked in are counted' : ''}.`;
      } catch (err) { if (mark) mark.textContent = err.message; }
    };
    card.querySelectorAll('tr[data-rid]').forEach((tr) => {
      const rid = tr.dataset.rid;
      tr.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
        const box = tr.querySelector('[data-entries-for]');
        box.value = Math.max(0, (Number(box.value) || 0) + Number(b.dataset.step));
        save(rid);
      }));
      tr.querySelector('[data-entries-for]').addEventListener('change', () => save(rid));
      tr.querySelector('[data-note-for]').addEventListener('change', () => save(rid));
    });
    if ($('eReset')) $('eReset').addEventListener('click', () => A.openDialog({
      title: 'Set everyone back to 1 entry?',
      body: '<p>All extra and zero entries are removed, so everyone has the same chance again.</p>',
      confirmWord: 'RESET', okLabel: 'Set back to 1', danger: true,
      run: async (v) => { const out = await A.post(`${base()}/entries/reset`, { confirm: v.confirm }); st = { ...st, ...out.state }; await loadEntries(); render(); },
    }));
  }

  function wire() {
    $('rOn').addEventListener('change', (e) => act(() => put({ enabled: e.target.checked })));
    if (!st.enabled) return;
    root.querySelectorAll('[data-pool]').forEach((b) => b.addEventListener('click', () => act(() => put({ pool: b.dataset.pool }))));
    $('rOnce').addEventListener('change', (e) => act(() => put({ oncePerPerson: e.target.checked })));
    root.querySelectorAll('[data-entries]').forEach((b) => b.addEventListener('click', () => act(() => put({ entries: b.dataset.entries }))));
    root.querySelectorAll('[data-present]').forEach((b) => b.addEventListener('click', () => act(() => put({ mustBePresent: b.dataset.present === '1' }))));
    wireEntries();
    const savePin = async (pin) => {
      $('rPinErr').textContent = '';
      try { st = { ...st, ...(await put({ pin })) }; render(); } catch (err) { if (err.message !== 'signed out') $('rPinErr').textContent = err.message; }
    };
    $('rPinSave').addEventListener('click', () => savePin($('rPin').value.trim()));
    $('rPinNew').addEventListener('click', () => savePin(String(100000 + Math.floor(Math.random() * 900000))));
    $('rAdd').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('rAddErr').textContent = '';
      try { st = { ...st, ...(await A.post(`${base()}/prizes`, { name: $('rName').value.trim(), quantity: Number($('rQty').value) })) }; render(); $('rName').focus(); }
      catch (err) { if (err.message !== 'signed out') $('rAddErr').textContent = err.message; }
    });
    root.querySelectorAll('tr[data-pid]').forEach((tr) => {
      const p = st.prizes.find((x) => x.id === Number(tr.dataset.pid));
      tr.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => act(() => A.post(`${base()}/prizes/${p.id}`, { move: Number(b.dataset.move) }, 'PATCH'))));
      tr.querySelectorAll('[data-pact]').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.pact === 'delete') return act(() => A.api(`${base()}/prizes/${p.id}`, { method: 'DELETE' }));
        A.openDialog({
          title: `Edit ${p.name}`,
          fields: [{ id: 'name', label: 'Prize', value: p.name, maxlength: 120 }, { id: 'qty', label: 'How many', value: String(p.quantity) }],
          okLabel: 'Save',
          run: async (v) => { st = { ...st, ...(await A.post(`${base()}/prizes/${p.id}`, { name: v.name, quantity: Number(v.qty) }, 'PATCH')) }; render(); },
        });
      }));
    });
    root.querySelectorAll('tr[data-did] [data-status]').forEach((b) => b.addEventListener('click', () => {
      const id = b.closest('tr').dataset.did;
      act(() => A.post(`${base()}/draws/${id}`, { status: b.dataset.status }));
    }));
    if ($('rReset')) $('rReset').addEventListener('click', () => A.openDialog({
      title: 'Start the raffle over?',
      body: '<p>Every draw and winner is removed, and everyone can win again. The prizes stay. This can’t be undone.</p>',
      confirmWord: 'RESET', okLabel: 'Start over', danger: true,
      run: async (v) => { st = { ...st, ...(await A.post(`${base()}/reset`, { confirm: v.confirm })) }; render(); },
    }));
  }

  window.RaffleAdmin = { open, close, reload };
})();
