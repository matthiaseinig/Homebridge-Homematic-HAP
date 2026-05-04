/**
 * homebridge-homematic-hap custom UI.
 *
 * Vanilla ES module + the global `homebridge` object provided by
 * homebridge-config-ui-x. No framework. Bootstrap 5 + a small Modal
 * helper for dialogs.
 *
 * Architecture: a single `state` object owns everything; views read
 * from it and dialogs mutate it. `state.blocks` is an array of
 * platform-config blocks (one per child bridge — index 0 is the main
 * bridge); cross-block fields like the CCU connection live on every
 * block and are kept in sync on save.
 */

// ---------------------------------------------------------------- helpers

const $ = (id) => document.getElementById(id);
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const sortBy = (arr, fn) => [...arr].sort((a, b) => {
  const av = fn(a); const bv = fn(b);
  if (av < bv) return -1; if (av > bv) return 1; return 0;
});

const PAGE_SIZE = 25;

// ---------------------------------------------------------------- state

const DEFAULT_BLOCK = () => ({
  platform: 'HomematicHap',
  name: 'HomematicHap',
  ccuIp: '',
  useTls: false,
  interfaces: { bidcosRf: true, hmIpRf: true, bidcosWired: false, virtualDevices: true, cuxd: false },
  interfacePorts: {},
  ccuAuth: { enabled: false, username: '', password: '' },
  eventServer: { host: '0.0.0.0', port: 9875, watchdogSeconds: 300 },
  channels: [],
  variables: [],
  programs: [],
});

const state = {
  /** Active view. */
  view: 'dashboard',
  /** All HomematicHap platform blocks; index 0 is the "main" bridge. */
  blocks: [DEFAULT_BLOCK()],
  /** Other (non-HomematicHap) blocks loaded from config, kept untouched. */
  otherBlocks: [],
  /** Discovered CCU inventory. */
  discovered: { devices: [], variables: [], programs: [], rooms: [] },
  /** Service catalog returned by /services. */
  services: { channelServices: [], variableServices: [] },
  /** Per-view UI state. */
  ui: {
    search: { channels: '', variables: '', programs: '' },
    page:   { channels: 1, variables: 1, programs: 1 },
    sort:   { channels: 'name', variables: 'name', programs: 'name' },
    /** Toggle: show only configured items (default) vs all discovered. */
    showAll: { channels: false, variables: false, programs: false },
    /** Group channels by room, when discovered rooms are available. */
    groupByRoom: false,
  },
  pluginVersion: 'unknown',
};

// Build a map of channel address -> { device, channel, room? } for fast lookup.
function channelLookup() {
  const out = new Map();
  const roomByChannelId = new Map();
  for (const r of state.discovered.rooms ?? []) {
    for (const id of r.channelIds ?? []) roomByChannelId.set(id, r.name);
  }
  for (const d of state.discovered.devices ?? []) {
    for (const c of d.channels ?? []) {
      out.set(c.address, { device: d, channel: c, room: roomByChannelId.get(c.id) });
    }
  }
  return out;
}

function variableLookup() {
  const out = new Map();
  for (const v of state.discovered.variables ?? []) out.set(v.name, v);
  return out;
}

function programLookup() {
  const out = new Map();
  for (const p of state.discovered.programs ?? []) out.set(p.name, p);
  return out;
}

// All channels across all blocks, with originating bridge index.
function allChannelsAcrossBridges() {
  const out = [];
  for (let bi = 0; bi < state.blocks.length; bi++) {
    for (const c of state.blocks[bi].channels ?? []) {
      out.push({ ...c, bridgeIndex: bi });
    }
  }
  return out;
}

function totalCount(kind) {
  return state.blocks.reduce((acc, b) => acc + (b[kind]?.length ?? 0), 0);
}

// ---------------------------------------------------------------- modal helper

let bsModalInstance = null;

function bsModal() {
  if (!bsModalInstance) {
    if (typeof window.bootstrap?.Modal !== 'function') {
      throw new Error('Bootstrap Modal not available — Homebridge UI did not inject it');
    }
    bsModalInstance = new window.bootstrap.Modal($('hgui-modal'), { backdrop: 'static' });
  }
  return bsModalInstance;
}

/**
 * Show a modal dialog with the given content. `onOk` is invoked when
 * the primary button is clicked; if it returns/resolves to a truthy
 * value the modal closes, otherwise it stays open (so a validation
 * error can keep the dialog up).
 */
function openModal({ title, body, okLabel = 'Save', okClass = 'btn-primary', onOk, footerExtra }) {
  $('hgui-modal-title').textContent = title;
  const bodyEl = $('hgui-modal-body');
  bodyEl.innerHTML = '';
  if (body instanceof Node) {
    bodyEl.appendChild(body);
  } else {
    bodyEl.innerHTML = body || '';
  }
  const okBtn = $('hgui-modal-ok');
  okBtn.textContent = okLabel;
  okBtn.className = 'btn ' + okClass;
  // Replace listener (clone to drop old).
  const fresh = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(fresh, okBtn);
  fresh.addEventListener('click', async () => {
    fresh.disabled = true;
    try {
      const result = await onOk?.();
      if (result !== false) bsModal().hide();
    } finally {
      fresh.disabled = false;
    }
  });

  // Optional extra button (e.g. Delete in edit dialogs).
  const footer = $('hgui-modal-footer');
  // Strip any previously-added extras (kept tagged so we don't nuke OK/Cancel).
  Array.from(footer.querySelectorAll('[data-extra]')).forEach((el) => el.remove());
  if (footerExtra) {
    const extra = document.createElement('button');
    extra.dataset.extra = '1';
    extra.type = 'button';
    extra.className = 'btn ' + (footerExtra.className || 'btn-outline-danger');
    extra.textContent = footerExtra.label;
    extra.addEventListener('click', async () => {
      extra.disabled = true;
      try {
        const r = await footerExtra.onClick?.();
        if (r !== false) bsModal().hide();
      } finally {
        extra.disabled = false;
      }
    });
    footer.insertBefore(extra, footer.firstChild);
  }

  bsModal().show();
}

// ---------------------------------------------------------------- view router

const VIEWS = {
  dashboard: renderDashboard,
  channels:  renderChannels,
  variables: renderVariables,
  programs:  renderPrograms,
  bridges:   renderBridges,
  import:    renderImport,
  settings:  renderSettings,
};

function navigate(view) {
  state.view = view in VIEWS ? view : 'dashboard';
  document.querySelectorAll('.hgui-nav-link').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === state.view);
  });
  rerender();
}

function rerender() {
  const host = $('hgui-view-host');
  host.innerHTML = '';
  VIEWS[state.view](host);
  // Refresh sidebar counts.
  $('hgui-app').querySelector('[data-count="channels"]').textContent  = totalCount('channels');
  $('hgui-app').querySelector('[data-count="variables"]').textContent = totalCount('variables');
  $('hgui-app').querySelector('[data-count="programs"]').textContent  = totalCount('programs');
  $('hgui-app').querySelector('[data-count="bridges"]').textContent   = state.blocks.length;
}

// ---------------------------------------------------------------- views: dashboard

function renderDashboard(host) {
  const card = (title, value, sub) => `
    <div class="col-sm-6 col-md-3">
      <div class="hgui-card">
        <div class="hgui-meta">${h(title)}</div>
        <div class="display-6">${h(value)}</div>
        <div class="hgui-meta">${h(sub || '')}</div>
      </div>
    </div>`;
  const discoveryStatus = state.discovered.devices.length
    ? `${state.discovered.devices.length} devices, ${state.discovered.variables.length} variables, ${state.discovered.programs.length} programs, ${state.discovered.rooms.length} rooms`
    : 'No discovery data yet — click "Discover devices" to load from the CCU';
  host.innerHTML = `
    <h4 class="mb-3">Dashboard</h4>
    <div class="row g-3 mb-3">
      ${card('Configured channels',  totalCount('channels'),  'across all bridges')}
      ${card('Configured variables', totalCount('variables'), '')}
      ${card('Configured programs',  totalCount('programs'),  '')}
      ${card('Bridges',              state.blocks.length,     'main + child bridges')}
    </div>
    <div class="hgui-card">
      <h6>Discovery</h6>
      <p class="hgui-meta mb-2">${h(discoveryStatus)}</p>
      <button class="btn btn-primary btn-sm" data-action="discover">Discover devices</button>
    </div>
    <div class="hgui-card">
      <h6>Quick links</h6>
      <div class="d-flex gap-2 flex-wrap">
        <button class="btn btn-outline-primary btn-sm" data-nav="channels">Manage channels →</button>
        <button class="btn btn-outline-primary btn-sm" data-nav="variables">Manage variables →</button>
        <button class="btn btn-outline-primary btn-sm" data-nav="bridges">Manage bridges →</button>
        <button class="btn btn-outline-secondary btn-sm" data-nav="import">Import from hap-homematic →</button>
        <button class="btn btn-outline-secondary btn-sm" data-nav="settings">Settings →</button>
      </div>
    </div>
  `;
  host.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.nav)));
  host.querySelectorAll('[data-action="discover"]').forEach((b) => b.addEventListener('click', onDiscover));
}

// ---------------------------------------------------------------- views: channels

function renderChannels(host) {
  const cl = channelLookup();
  const configured = allChannelsAcrossBridges().map((c) => ({
    ...c, _info: cl.get(c.address) ?? null,
  }));
  const search = state.ui.search.channels.trim().toLowerCase();
  const showAll = state.ui.showAll.channels;

  // Build the working dataset:
  //   - "configured" mode (default): shows accessories already in the config.
  //   - "showAll" mode: shows every discovered channel; configured ones are
  //     marked so the user can still edit/remove.
  let rows;
  if (showAll && state.discovered.devices.length) {
    const configuredByAddr = new Map(configured.map((c) => [c.address, c]));
    rows = [];
    for (const d of state.discovered.devices) {
      for (const c of d.channels) {
        const info = { device: d, channel: c, room: cl.get(c.address)?.room };
        const existing = configuredByAddr.get(c.address);
        rows.push({
          address: c.address,
          name: existing?.name ?? c.name,
          service: existing?.service,
          subtype: existing?.subtype,
          settings: existing?.settings,
          bridgeIndex: existing?.bridgeIndex,
          isConfigured: !!existing,
          _info: info,
        });
      }
    }
  } else {
    rows = configured;
  }

  if (search) {
    rows = rows.filter((r) => {
      const haystack = [
        r.address, r.name, r._info?.device?.name, r._info?.device?.type,
        r._info?.channel?.type, r._info?.room, r.service, r.subtype,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(search);
    });
  }

  // Sort.
  rows = sortBy(rows, (r) => (r.name ?? r._info?.channel?.name ?? r.address).toLowerCase());

  // Group by room toggle.
  let grouped = null;
  if (state.ui.groupByRoom && state.discovered.rooms.length) {
    grouped = new Map();
    for (const r of rows) {
      const key = r._info?.room ?? '— no room —';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }
  }

  // Pagination (only when not grouped, since groups are short).
  let page = state.ui.page.channels;
  let pageRows = rows;
  let pageCount = 1;
  if (!grouped) {
    pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (page > pageCount) page = state.ui.page.channels = 1;
    pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  }

  host.innerHTML = `
    <h4 class="mb-3">Channels</h4>
    <div class="hgui-toolbar">
      <input type="search" id="hgui-search-channels" class="form-control"
             placeholder="Search by name, address, type, room…" value="${h(state.ui.search.channels)}" />
      <button id="hgui-add-channel" class="btn btn-primary">+ Add channel</button>
      <div class="form-check ms-2">
        <input class="form-check-input" type="checkbox" id="hgui-channels-showall" ${showAll ? 'checked' : ''} />
        <label class="form-check-label" for="hgui-channels-showall">Show all discovered</label>
      </div>
      <div class="form-check">
        <input class="form-check-input" type="checkbox" id="hgui-channels-groupByRoom" ${state.ui.groupByRoom ? 'checked' : ''} />
        <label class="form-check-label" for="hgui-channels-groupByRoom">Group by room</label>
      </div>
      <span class="ms-auto hgui-meta">${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}</span>
    </div>
    ${rows.length === 0
      ? '<div class="hgui-empty">No channels match. Try clearing the search, or run discovery and toggle "Show all discovered".</div>'
      : grouped
        ? renderGroupedChannelsHTML(grouped)
        : renderChannelsTableHTML(pageRows)}
    ${grouped || rows.length === 0 ? '' : renderPagerHTML('channels', page, pageCount)}
  `;

  // Wiring.
  $('hgui-search-channels').addEventListener('input', (e) => {
    state.ui.search.channels = e.target.value;
    state.ui.page.channels = 1;
    rerender();
  });
  $('hgui-channels-showall').addEventListener('change', (e) => {
    state.ui.showAll.channels = e.target.checked;
    rerender();
  });
  $('hgui-channels-groupByRoom').addEventListener('change', (e) => {
    state.ui.groupByRoom = e.target.checked;
    rerender();
  });
  $('hgui-add-channel').addEventListener('click', openAddChannelDialog);
  host.querySelectorAll('[data-edit-channel]').forEach((b) => {
    b.addEventListener('click', () => openEditChannelDialog(b.dataset.editChannel));
  });
  host.querySelectorAll('[data-add-channel-from-discovery]').forEach((b) => {
    b.addEventListener('click', () => openAddChannelDialog(b.dataset.addChannelFromDiscovery));
  });
  host.querySelectorAll('[data-pager]').forEach((b) => {
    b.addEventListener('click', () => {
      const p = parseInt(b.dataset.pager, 10);
      if (Number.isFinite(p)) { state.ui.page.channels = p; rerender(); }
    });
  });
}

function renderChannelsTableHTML(rows) {
  return `
    <table class="hgui-grid">
      <thead><tr>
        <th>HomeKit name</th>
        <th>CCU name</th>
        <th>Address / type</th>
        <th>Service</th>
        <th>Bridge</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${rows.map((r) => renderChannelRow(r)).join('')}
      </tbody>
    </table>`;
}

function renderGroupedChannelsHTML(grouped) {
  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([room, rs]) => `
      <div class="hgui-card">
        <h6>${h(room)} <span class="hgui-pill">${rs.length}</span></h6>
        ${renderChannelsTableHTML(rs)}
      </div>
    `).join('');
}

function renderChannelRow(r) {
  const info = r._info;
  const bridgeName = r.bridgeIndex !== undefined ? state.blocks[r.bridgeIndex]?.name : '';
  const inHK = r.isConfigured ?? r.service !== undefined;
  return `
    <tr>
      <td>${inHK ? `<strong>${h(r.name || info?.channel?.name || r.address)}</strong>` : '<span class="hgui-meta">(not in HomeKit)</span>'}</td>
      <td>${h(info?.channel?.name ?? '')}<br/><span class="hgui-meta">${h(info?.device?.name ?? '')}</span></td>
      <td><code>${h(r.address)}</code><br/><span class="hgui-meta">${h(info?.channel?.type ?? '')}</span></td>
      <td>${h(r.service ?? '—')}${r.subtype ? `<br/><span class="hgui-meta">${h(r.subtype)}</span>` : ''}</td>
      <td>${h(bridgeName ?? '—')}</td>
      <td class="hgui-row-actions">
        ${inHK
          ? `<button class="btn btn-sm btn-outline-primary" data-edit-channel="${h(r.address)}">Edit</button>`
          : `<button class="btn btn-sm btn-primary" data-add-channel-from-discovery="${h(r.address)}">+ Add</button>`}
      </td>
    </tr>`;
}

function renderPagerHTML(kind, page, pageCount) {
  if (pageCount <= 1) return '';
  const window = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pageCount, page + 2); p++) window.push(p);
  return `
    <div class="hgui-pager">
      <button class="btn btn-sm btn-outline-secondary" ${page === 1 ? 'disabled' : ''} data-pager="${page - 1}">‹</button>
      ${window.map((p) => `<button class="btn btn-sm ${p === page ? 'btn-primary' : 'btn-outline-secondary'}" data-pager="${p}">${p}</button>`).join('')}
      <button class="btn btn-sm btn-outline-secondary" ${page === pageCount ? 'disabled' : ''} data-pager="${page + 1}">›</button>
      <span class="ms-2 hgui-meta">page ${page} / ${pageCount}</span>
    </div>`;
}

// ---------------------------------------------------------------- views: variables

function renderVariables(host) {
  const vl = variableLookup();
  const configured = state.blocks.flatMap((b, bi) => (b.variables ?? []).map((v) => ({ ...v, bridgeIndex: bi })));
  const showAll = state.ui.showAll.variables;
  let rows = showAll
    ? state.discovered.variables.map((v) => {
        const existing = configured.find((c) => c.name === v.name);
        return {
          name: v.name, displayName: existing?.displayName, service: existing?.service,
          settings: existing?.settings, bridgeIndex: existing?.bridgeIndex,
          isConfigured: !!existing, _info: v,
        };
      })
    : configured.map((c) => ({ ...c, _info: vl.get(c.name) ?? null }));

  const search = state.ui.search.variables.trim().toLowerCase();
  if (search) rows = rows.filter((r) => (r.name + ' ' + (r.displayName ?? '')).toLowerCase().includes(search));
  rows = sortBy(rows, (r) => (r.displayName ?? r.name).toLowerCase());

  let page = state.ui.page.variables;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > pageCount) page = state.ui.page.variables = 1;
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  host.innerHTML = `
    <h4 class="mb-3">Variables</h4>
    <div class="hgui-toolbar">
      <input type="search" id="hgui-search-variables" class="form-control" placeholder="Search…" value="${h(state.ui.search.variables)}" />
      <button id="hgui-add-variable" class="btn btn-primary">+ Add variable</button>
      <div class="form-check ms-2">
        <input class="form-check-input" type="checkbox" id="hgui-variables-showall" ${showAll ? 'checked' : ''} />
        <label class="form-check-label" for="hgui-variables-showall">Show all discovered</label>
      </div>
      <span class="ms-auto hgui-meta">${rows.length} entries</span>
    </div>
    ${rows.length === 0
      ? '<div class="hgui-empty">No variables match.</div>'
      : `<table class="hgui-grid">
          <thead><tr><th>HomeKit name</th><th>CCU name</th><th>Type</th><th>Bridge</th><th></th></tr></thead>
          <tbody>${pageRows.map((r) => renderVariableRow(r)).join('')}</tbody>
        </table>`}
    ${renderPagerHTML('variables', page, pageCount)}
  `;
  $('hgui-search-variables').addEventListener('input', (e) => {
    state.ui.search.variables = e.target.value; state.ui.page.variables = 1; rerender();
  });
  $('hgui-variables-showall').addEventListener('change', (e) => {
    state.ui.showAll.variables = e.target.checked; rerender();
  });
  $('hgui-add-variable').addEventListener('click', () => openAddVariableDialog());
  host.querySelectorAll('[data-edit-variable]').forEach((b) =>
    b.addEventListener('click', () => openEditVariableDialog(b.dataset.editVariable)));
  host.querySelectorAll('[data-add-variable-from]').forEach((b) =>
    b.addEventListener('click', () => openAddVariableDialog(b.dataset.addVariableFrom)));
  host.querySelectorAll('[data-pager]').forEach((b) =>
    b.addEventListener('click', () => { state.ui.page.variables = parseInt(b.dataset.pager, 10); rerender(); }));
}

function renderVariableRow(r) {
  const info = r._info;
  const inHK = r.isConfigured ?? true;
  const bridgeName = r.bridgeIndex !== undefined ? state.blocks[r.bridgeIndex]?.name : '';
  const typeLabel = info ? `valuetype ${info.valuetype}, value ${String(info.value ?? '?')}` : '';
  return `
    <tr>
      <td>${inHK ? `<strong>${h(r.displayName ?? r.name)}</strong>` : '<span class="hgui-meta">(not in HomeKit)</span>'}</td>
      <td><code>${h(r.name)}</code></td>
      <td>${h(typeLabel)}</td>
      <td>${h(bridgeName ?? '—')}</td>
      <td class="hgui-row-actions">
        ${inHK
          ? `<button class="btn btn-sm btn-outline-primary" data-edit-variable="${h(r.name)}">Edit</button>`
          : `<button class="btn btn-sm btn-primary" data-add-variable-from="${h(r.name)}">+ Add</button>`}
      </td>
    </tr>`;
}

// ---------------------------------------------------------------- views: programs

function renderPrograms(host) {
  const pl = programLookup();
  const configured = state.blocks.flatMap((b, bi) => (b.programs ?? []).map((p) => ({ ...p, bridgeIndex: bi })));
  const showAll = state.ui.showAll.programs;
  let rows = showAll
    ? state.discovered.programs.map((p) => {
        const existing = configured.find((c) => c.name === p.name);
        return { name: p.name, displayName: existing?.displayName, bridgeIndex: existing?.bridgeIndex, isConfigured: !!existing, _info: p };
      })
    : configured.map((c) => ({ ...c, _info: pl.get(c.name) ?? null }));

  const search = state.ui.search.programs.trim().toLowerCase();
  if (search) rows = rows.filter((r) => (r.name + ' ' + (r.displayName ?? '')).toLowerCase().includes(search));
  rows = sortBy(rows, (r) => (r.displayName ?? r.name).toLowerCase());

  let page = state.ui.page.programs;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > pageCount) page = state.ui.page.programs = 1;
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  host.innerHTML = `
    <h4 class="mb-3">Programs</h4>
    <div class="hgui-toolbar">
      <input type="search" id="hgui-search-programs" class="form-control" placeholder="Search…" value="${h(state.ui.search.programs)}" />
      <button id="hgui-add-program" class="btn btn-primary">+ Add program</button>
      <div class="form-check ms-2">
        <input class="form-check-input" type="checkbox" id="hgui-programs-showall" ${showAll ? 'checked' : ''} />
        <label class="form-check-label" for="hgui-programs-showall">Show all discovered</label>
      </div>
      <span class="ms-auto hgui-meta">${rows.length} entries</span>
    </div>
    ${rows.length === 0
      ? '<div class="hgui-empty">No programs match.</div>'
      : `<table class="hgui-grid">
          <thead><tr><th>HomeKit name</th><th>CCU name</th><th>Bridge</th><th></th></tr></thead>
          <tbody>${pageRows.map((r) => renderProgramRow(r)).join('')}</tbody>
        </table>`}
    ${renderPagerHTML('programs', page, pageCount)}
  `;
  $('hgui-search-programs').addEventListener('input', (e) => {
    state.ui.search.programs = e.target.value; state.ui.page.programs = 1; rerender();
  });
  $('hgui-programs-showall').addEventListener('change', (e) => {
    state.ui.showAll.programs = e.target.checked; rerender();
  });
  $('hgui-add-program').addEventListener('click', () => openAddProgramDialog());
  host.querySelectorAll('[data-edit-program]').forEach((b) =>
    b.addEventListener('click', () => openEditProgramDialog(b.dataset.editProgram)));
  host.querySelectorAll('[data-add-program-from]').forEach((b) =>
    b.addEventListener('click', () => openAddProgramDialog(b.dataset.addProgramFrom)));
  host.querySelectorAll('[data-pager]').forEach((b) =>
    b.addEventListener('click', () => { state.ui.page.programs = parseInt(b.dataset.pager, 10); rerender(); }));
}

function renderProgramRow(r) {
  const inHK = r.isConfigured ?? true;
  const bridgeName = r.bridgeIndex !== undefined ? state.blocks[r.bridgeIndex]?.name : '';
  return `
    <tr>
      <td>${inHK ? `<strong>${h(r.displayName ?? r.name)}</strong>` : '<span class="hgui-meta">(not in HomeKit)</span>'}</td>
      <td><code>${h(r.name)}</code></td>
      <td>${h(bridgeName ?? '—')}</td>
      <td class="hgui-row-actions">
        ${inHK
          ? `<button class="btn btn-sm btn-outline-primary" data-edit-program="${h(r.name)}">Edit</button>`
          : `<button class="btn btn-sm btn-primary" data-add-program-from="${h(r.name)}">+ Add</button>`}
      </td>
    </tr>`;
}

// ---------------------------------------------------------------- views: bridges

function renderBridges(host) {
  host.innerHTML = `
    <h4 class="mb-3">Bridges</h4>
    <p class="hgui-meta">Each bridge runs as its own Homebridge child process with its own HomeKit pairing.
       The "main" bridge is the first entry; child bridges are added below.</p>
    <div class="hgui-toolbar">
      <button id="hgui-add-bridge" class="btn btn-primary">+ Add child bridge</button>
    </div>
    ${state.blocks.map((b, bi) => renderBridgeCard(b, bi)).join('')}
  `;
  $('hgui-add-bridge').addEventListener('click', addChildBridge);
  host.querySelectorAll('[data-rename-bridge]').forEach((b) => {
    b.addEventListener('click', () => openRenameBridgeDialog(parseInt(b.dataset.renameBridge, 10)));
  });
  host.querySelectorAll('[data-remove-bridge]').forEach((b) => {
    b.addEventListener('click', () => openRemoveBridgeDialog(parseInt(b.dataset.removeBridge, 10)));
  });
  host.querySelectorAll('[data-regen-bridge]').forEach((b) => {
    b.addEventListener('click', () => regenerateBridgeIdentity(parseInt(b.dataset.regenBridge, 10)));
  });
}

function renderBridgeCard(b, bi) {
  const isMain = bi === 0;
  const counts = `${(b.channels ?? []).length} ch / ${(b.variables ?? []).length} var / ${(b.programs ?? []).length} prog`;
  return `
    <div class="hgui-card">
      <div class="hgui-bridge-card">
        <div>
          <strong>${h(b.name)}</strong> ${isMain ? '<span class="hgui-pill">main</span>' : '<span class="hgui-pill">child</span>'}
          <div class="hgui-meta">${h(counts)}</div>
          ${b._bridge
              ? `<div class="hgui-meta">username <code>${h(b._bridge.username)}</code> · port <code>${h(b._bridge.port)}</code></div>`
              : '<div class="hgui-meta">— no per-bridge identity (uses main bridge) —</div>'}
        </div>
        <div class="hgui-row-actions">
          <button class="btn btn-sm btn-outline-primary" data-rename-bridge="${bi}">Rename</button>
          ${!isMain ? `<button class="btn btn-sm btn-outline-secondary" data-regen-bridge="${bi}">Regenerate identity</button>` : ''}
          ${!isMain ? `<button class="btn btn-sm btn-outline-danger" data-remove-bridge="${bi}">Remove</button>` : ''}
        </div>
      </div>
    </div>`;
}

function addChildBridge() {
  const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const block = {
    ...DEFAULT_BLOCK(),
    name: `HomematicHap (${state.blocks.length})`,
    _bridge: { username: identityUsername(seed), port: identityPort(seed) },
    // Inherit common settings from main bridge.
    ccuIp: state.blocks[0].ccuIp,
    useTls: state.blocks[0].useTls,
    interfaces: { ...state.blocks[0].interfaces },
    interfacePorts: { ...state.blocks[0].interfacePorts },
    ccuAuth: { ...state.blocks[0].ccuAuth },
    eventServer: { ...state.blocks[0].eventServer },
  };
  state.blocks.push(block);
  rerender();
  homebridge.toast.success('Added child bridge', 'Bridges');
}

/** Deterministic-looking but random username + port pair. */
function identityUsername(seed) {
  const h = Array.from(seed).reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0xC0FFEE);
  const bytes = new Array(6).fill(0).map((_, i) => ((h >> (i * 4)) & 0xFF));
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}
function identityPort(seed) {
  const h = Array.from(seed).reduce((a, c) => (a * 131 + c.charCodeAt(0)) | 0, 0xCAFE);
  return 30000 + (Math.abs(h) % 5000);
}

function openRenameBridgeDialog(bi) {
  const b = state.blocks[bi];
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="hgui-form-row">
      <label>Bridge name</label>
      <div><input class="form-control" id="hgui-bridge-name" value="${h(b.name)}" />
        <div class="hgui-hint">Shown in the Home app and in Homebridge logs.</div></div>
    </div>`;
  openModal({
    title: `Rename bridge: ${b.name}`,
    body: root,
    onOk: () => {
      const v = root.querySelector('#hgui-bridge-name').value.trim();
      if (!v) { homebridge.toast.warning('Name cannot be empty'); return false; }
      b.name = v;
      rerender();
      homebridge.toast.success('Renamed bridge', 'Bridges');
    },
  });
}

function openRemoveBridgeDialog(bi) {
  const b = state.blocks[bi];
  const accs = (b.channels?.length ?? 0) + (b.variables?.length ?? 0) + (b.programs?.length ?? 0);
  openModal({
    title: `Remove bridge "${b.name}"?`,
    body: `<p>This bridge has <strong>${accs}</strong> accessories.
           Removing it deletes all of them from this configuration. The HomeKit
           pairing on the bridge becomes orphaned in the Home app — you will
           need to remove the bridge there too.</p>`,
    okLabel: 'Remove bridge',
    okClass: 'btn-danger',
    onOk: () => {
      state.blocks.splice(bi, 1);
      if (state.blocks.length === 0) state.blocks.push(DEFAULT_BLOCK());
      rerender();
      homebridge.toast.success('Bridge removed', 'Bridges');
    },
  });
}

function regenerateBridgeIdentity(bi) {
  const b = state.blocks[bi];
  const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  b._bridge = { username: identityUsername(seed), port: identityPort(seed) };
  rerender();
  homebridge.toast.warning('Identity regenerated — accessories on this bridge will need to be re-paired in HomeKit', 'Bridges');
}

// ---------------------------------------------------------------- views: import

function renderImport(host) {
  host.innerHTML = `
    <h4 class="mb-3">Import from hap-homematic</h4>
    <p class="hgui-meta">Upload a hap-homematic <strong>backup tarball</strong> (the .tar.gz produced
       by the hap-homematic backup screen) or paste a raw <code>config.json</code>.
       Existing accessories are kept; imported entries are merged on top.</p>
    <div class="hgui-card">
      <div class="row g-2">
        <div class="col-md-6">
          <label class="form-label">Backup tarball</label>
          <input type="file" id="hgui-import-file" class="form-control" accept=".tar.gz,.tgz,application/gzip" />
        </div>
        <div class="col-md-6">
          <label class="form-label">…or paste config.json</label>
          <textarea id="hgui-import-paste" class="form-control font-monospace" rows="3"
                    placeholder='{ "ccuIP": "192.168.1.10", ... }'></textarea>
        </div>
      </div>
      <div class="form-check mt-3">
        <input class="form-check-input" type="checkbox" id="hgui-import-multibridge" />
        <label class="form-check-label" for="hgui-import-multibridge">
          <strong>Create one Homebridge child bridge per hap-homematic instance</strong>
          <small class="d-block hgui-meta">
            Replicates the per-room bridge model from hap-homematic. On Save, the plugin
            emits one platform block per instance, each with its own <code>_bridge</code> identity.
            Leave unchecked to merge everything onto a single bridge.
          </small>
        </label>
      </div>
      <div class="mt-3">
        <button id="hgui-import-btn" class="btn btn-warning">Import</button>
        <span id="hgui-import-status" class="ms-2"></span>
      </div>
      <div id="hgui-import-warnings" class="mt-3"></div>
      <div id="hgui-bridges-summary" class="mt-3"></div>
    </div>
  `;
  $('hgui-import-btn').addEventListener('click', onImport);
}

// ---------------------------------------------------------------- views: settings

function renderSettings(host) {
  const m = state.blocks[0]; // common settings live on the main block
  host.innerHTML = `
    <h4 class="mb-3">Settings</h4>
    <div class="hgui-card">
      <h6>CCU connection</h6>
      <div class="row g-2 mb-2">
        <div class="col-md-6">
          <label class="form-label">CCU IP / hostname</label>
          <input class="form-control" id="cf-ccu-ip" value="${h(m.ccuIp)}" />
        </div>
        <div class="col-md-3">
          <label class="form-label">Event server port</label>
          <input class="form-control" type="number" min="1024" max="65535" id="cf-event-port" value="${h(m.eventServer.port)}" />
        </div>
        <div class="col-md-3 d-flex align-items-end">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="cf-tls" ${m.useTls ? 'checked' : ''} />
            <label class="form-check-label" for="cf-tls">Use TLS</label>
          </div>
        </div>
      </div>
    </div>
    <div class="hgui-card">
      <h6>CCU authentication</h6>
      <div class="row g-2">
        <div class="col-md-3 d-flex align-items-end">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="cf-auth-enabled" ${m.ccuAuth.enabled ? 'checked' : ''} />
            <label class="form-check-label" for="cf-auth-enabled">Use CCU auth</label>
          </div>
        </div>
        <div class="col-md-4">
          <label class="form-label">Username</label>
          <input class="form-control" id="cf-auth-user" value="${h(m.ccuAuth.username || '')}" />
        </div>
        <div class="col-md-5">
          <label class="form-label">Password</label>
          <input class="form-control" type="password" id="cf-auth-pass" value="${h(m.ccuAuth.password || '')}" />
        </div>
      </div>
    </div>
    <div class="hgui-card">
      <h6>Interfaces</h6>
      <div class="row g-2">
        ${[['bidcosRf','BidCos-RF'],['hmIpRf','HmIP-RF'],['bidcosWired','BidCos-Wired'],['virtualDevices','VirtualDevices'],['cuxd','CUxD']]
          .map(([k,label]) => `
            <div class="col-md-3 form-check">
              <input class="form-check-input" type="checkbox" id="cf-if-${k}" ${m.interfaces[k] ? 'checked' : ''} />
              <label class="form-check-label" for="cf-if-${k}">${h(label)}</label>
            </div>`).join('')}
      </div>
    </div>
    <div class="hgui-card">
      <h6>XML-RPC port overrides</h6>
      <p class="hgui-meta">Leave blank to auto-discover ports via <code>Interface.listInterfaces</code>.
         Set explicitly only when the auto-discovered port is not reachable from this host (e.g. blocked by the CCU's firewall).
         RaspberryMatic's external defaults are <code>32001 / 32010 / 39292</code>; legacy localhost-only defaults are <code>2001 / 2010 / 9292</code>.</p>
      <div class="row g-2">
        ${[['BidCos-RF','32001'],['HmIP-RF','32010'],['BidCos-Wired','32000'],['VirtualDevices','39292'],['CUxD','8701']]
          .map(([k,ph]) => `
            <div class="col-md-3">
              <label class="form-label">${h(k)}</label>
              <input class="form-control" type="number" id="cf-port-${h(k)}" placeholder="${ph}" value="${h(m.interfacePorts?.[k] ?? '')}" />
            </div>`).join('')}
      </div>
    </div>
  `;
  // Wire up — propagate to ALL blocks since these are common settings.
  const propagate = (mut) => { for (const b of state.blocks) mut(b); };
  $('cf-ccu-ip').addEventListener('input', (e) => propagate((b) => b.ccuIp = e.target.value.trim()));
  $('cf-event-port').addEventListener('input', (e) => propagate((b) => b.eventServer.port = parseInt(e.target.value, 10) || 9875));
  $('cf-tls').addEventListener('change', (e) => propagate((b) => b.useTls = e.target.checked));
  $('cf-auth-enabled').addEventListener('change', (e) => propagate((b) => b.ccuAuth.enabled = e.target.checked));
  $('cf-auth-user').addEventListener('input', (e) => propagate((b) => b.ccuAuth.username = e.target.value));
  $('cf-auth-pass').addEventListener('input', (e) => propagate((b) => b.ccuAuth.password = e.target.value));
  for (const k of ['bidcosRf','hmIpRf','bidcosWired','virtualDevices','cuxd']) {
    $(`cf-if-${k}`).addEventListener('change', (e) => propagate((b) => b.interfaces[k] = e.target.checked));
  }
  for (const k of ['BidCos-RF','HmIP-RF','BidCos-Wired','VirtualDevices','CUxD']) {
    $(`cf-port-${k}`).addEventListener('input', (e) => {
      const v = e.target.value.trim();
      propagate((b) => {
        b.interfacePorts = { ...b.interfacePorts };
        if (v === '') delete b.interfacePorts[k];
        else b.interfacePorts[k] = parseInt(v, 10);
      });
    });
  }
}

// ---------------------------------------------------------------- dialogs: channel

function openAddChannelDialog(preselectAddress) {
  if (!state.discovered.devices.length) {
    homebridge.toast.warning('Run "Discover devices" first', 'Add channel');
    return;
  }
  if (preselectAddress) {
    const cl = channelLookup();
    const info = cl.get(preselectAddress);
    if (info) return openChannelEditor({ mode: 'add', address: preselectAddress, info });
  }
  // Step 1: pick a channel from a searchable grid.
  openChannelPicker();
}

function openChannelPicker() {
  const cl = channelLookup();
  const root = document.createElement('div');
  const all = [];
  for (const d of state.discovered.devices) {
    for (const c of d.channels) {
      all.push({ device: d, channel: c, room: cl.get(c.address)?.room });
    }
  }
  const configuredByAddr = new Map(allChannelsAcrossBridges().map((c) => [c.address, c]));

  root.innerHTML = `
    <p class="hgui-meta">Select a channel to add to HomeKit.</p>
    <input type="search" class="form-control mb-2" id="hgui-picker-search" placeholder="Search by name, address, type, room…" autofocus />
    <div id="hgui-picker-host" style="max-height: 50vh; overflow-y: auto;"></div>
    <div id="hgui-picker-pager" class="mt-2"></div>
  `;
  let q = '';
  let p = 1;

  const draw = () => {
    let rows = q
      ? all.filter((x) => `${x.device.name} ${x.device.type} ${x.channel.name} ${x.channel.address} ${x.channel.type} ${x.room ?? ''}`.toLowerCase().includes(q))
      : all;
    rows = sortBy(rows, (x) => (x.device.name + ' ' + x.channel.address).toLowerCase());
    const pageCount = Math.max(1, Math.ceil(rows.length / 50));
    if (p > pageCount) p = 1;
    const slice = rows.slice((p - 1) * 50, p * 50);
    const host = root.querySelector('#hgui-picker-host');
    host.innerHTML = `
      <table class="hgui-grid">
        <thead><tr><th>Device</th><th>Channel</th><th>Address</th><th>Type</th><th></th></tr></thead>
        <tbody>
          ${slice.map((x) => `
            <tr>
              <td>${h(x.device.name)}<br/><span class="hgui-meta">${h(x.device.type)}</span></td>
              <td>${h(x.channel.name)}</td>
              <td><code>${h(x.channel.address)}</code></td>
              <td>${h(x.channel.type)}</td>
              <td class="hgui-row-actions">
                ${configuredByAddr.has(x.channel.address)
                  ? '<span class="hgui-pill">already added</span>'
                  : `<button class="btn btn-sm btn-primary" data-pick="${h(x.channel.address)}">Select</button>`}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    `;
    const pager = root.querySelector('#hgui-picker-pager');
    pager.innerHTML = pageCount > 1 ? `
      <div class="hgui-pager">
        <button class="btn btn-sm btn-outline-secondary" ${p === 1 ? 'disabled' : ''} data-pp="${p - 1}">‹</button>
        <span class="mx-2 hgui-meta">${p} / ${pageCount}</span>
        <button class="btn btn-sm btn-outline-secondary" ${p === pageCount ? 'disabled' : ''} data-pp="${p + 1}">›</button>
      </div>` : '';
    host.querySelectorAll('[data-pick]').forEach((b) => {
      b.addEventListener('click', () => {
        const info = cl.get(b.dataset.pick);
        bsModal().hide();
        // Defer to let modal fully close before opening editor (Bootstrap
        // doesn't like stacked modals on the same root).
        setTimeout(() => openChannelEditor({ mode: 'add', address: b.dataset.pick, info }), 250);
      });
    });
    pager.querySelectorAll('[data-pp]').forEach((b) =>
      b.addEventListener('click', () => { p = parseInt(b.dataset.pp, 10); draw(); }));
  };
  draw();
  root.querySelector('#hgui-picker-search').addEventListener('input', (e) => {
    q = e.target.value.trim().toLowerCase(); p = 1; draw();
  });
  openModal({ title: 'Add channel — pick from CCU', body: root, okLabel: 'Done', onOk: () => true });
}

function openEditChannelDialog(address) {
  const cl = channelLookup();
  const info = cl.get(address);
  // Find which block holds the entry.
  let bridgeIndex = -1;
  let entry = null;
  for (let bi = 0; bi < state.blocks.length; bi++) {
    const found = state.blocks[bi].channels.find((c) => c.address === address);
    if (found) { bridgeIndex = bi; entry = found; break; }
  }
  if (!entry) return;
  openChannelEditor({ mode: 'edit', address, info, entry, bridgeIndex });
}

function openChannelEditor({ mode, address, info, entry, bridgeIndex }) {
  const candidates = info?.channel
    ? state.services.channelServices.filter((s) => s.channelTypes.includes(info.channel.type))
    : state.services.channelServices;
  const draft = entry
    ? { ...entry }
    : {
        address,
        name: info?.channel?.name ?? address,
        service: candidates[0]?.key ?? state.services.channelServices[0]?.key ?? 'SwitchAccessory',
        subtype: candidates[0]?.variants?.[0]?.id,
      };
  let targetBridge = bridgeIndex ?? 0;

  const root = document.createElement('div');
  const renderBody = () => {
    const def = state.services.channelServices.find((s) => s.key === draft.service);
    const variants = def?.variants ?? [];
    root.innerHTML = `
      <div class="hgui-meta mb-2">
        <code>${h(address)}</code> · ${h(info?.channel?.type ?? '')} · ${h(info?.device?.name ?? '')}${info?.room ? ` · room ${h(info.room)}` : ''}
      </div>
      <div class="hgui-form-row">
        <label>HomeKit name</label>
        <div><input class="form-control" id="hgui-c-name" value="${h(draft.name ?? '')}" />
          <div class="hgui-hint">The name shown in the Home app. Already-paired bridges may keep their original pairing name — this is a HomeKit limitation we can't override.</div></div>
      </div>
      <div class="hgui-form-row">
        <label>Service</label>
        <div>
          <select class="form-select" id="hgui-c-service">
            ${(candidates.length ? candidates : state.services.channelServices).map((s) => `
              <option value="${h(s.key)}" ${s.key === draft.service ? 'selected' : ''}>${h(s.description)} (${h(s.key)})</option>
            `).join('')}
          </select>
          <div class="hgui-hint">Pick how this channel should appear in HomeKit.</div>
        </div>
      </div>
      ${variants.length ? `
        <div class="hgui-form-row">
          <label>Variant</label>
          <div>
            <select class="form-select" id="hgui-c-subtype">
              ${variants.map((v) => `<option value="${h(v.id)}" ${v.id === draft.subtype ? 'selected' : ''}>${h(v.label)}</option>`).join('')}
            </select>
            <div class="hgui-hint">Some services support multiple HomeKit shapes — pick the one that fits.</div>
          </div>
        </div>` : ''}
      <div class="hgui-form-row">
        <label>Bridge</label>
        <div>
          <select class="form-select" id="hgui-c-bridge">
            ${state.blocks.map((b, bi) => `<option value="${bi}" ${bi === targetBridge ? 'selected' : ''}>${h(b.name)}${bi === 0 ? ' (main)' : ''}</option>`).join('')}
          </select>
          <div class="hgui-hint">Which bridge the accessory lives on. Moving an accessory between bridges re-pairs it in HomeKit.</div>
        </div>
      </div>
    `;
    root.querySelector('#hgui-c-name').addEventListener('input', (e) => { draft.name = e.target.value; });
    root.querySelector('#hgui-c-service').addEventListener('change', (e) => {
      draft.service = e.target.value;
      const newDef = state.services.channelServices.find((s) => s.key === draft.service);
      draft.subtype = newDef?.variants?.[0]?.id;
      renderBody();
    });
    if (variants.length) {
      root.querySelector('#hgui-c-subtype').addEventListener('change', (e) => { draft.subtype = e.target.value; });
    }
    root.querySelector('#hgui-c-bridge').addEventListener('change', (e) => { targetBridge = parseInt(e.target.value, 10); });
  };
  renderBody();

  openModal({
    title: mode === 'add' ? 'Add channel' : `Edit ${entry?.name ?? address}`,
    body: root,
    okLabel: mode === 'add' ? 'Add' : 'Save',
    onOk: () => {
      const name = (draft.name ?? '').trim();
      if (!name) { homebridge.toast.warning('HomeKit name cannot be empty'); return false; }
      // Remove any existing entry from any block, then add to target.
      for (const b of state.blocks) {
        const i = b.channels.findIndex((c) => c.address === address);
        if (i !== -1) b.channels.splice(i, 1);
      }
      state.blocks[targetBridge].channels.push({
        address,
        name,
        service: draft.service,
        ...(draft.subtype ? { subtype: draft.subtype } : {}),
        ...(draft.settings ? { settings: draft.settings } : {}),
      });
      rerender();
      homebridge.toast.success(mode === 'add' ? 'Channel added' : 'Channel updated', 'Channels');
    },
    footerExtra: mode === 'edit'
      ? {
          label: 'Remove from HomeKit',
          onClick: () => {
            for (const b of state.blocks) {
              const i = b.channels.findIndex((c) => c.address === address);
              if (i !== -1) b.channels.splice(i, 1);
            }
            rerender();
            homebridge.toast.success('Channel removed', 'Channels');
          },
        }
      : null,
  });
}

// ---------------------------------------------------------------- dialogs: variable

function openAddVariableDialog(preselectName) {
  if (!state.discovered.variables.length) {
    homebridge.toast.warning('Run "Discover devices" first', 'Add variable');
    return;
  }
  if (preselectName) {
    const v = variableLookup().get(preselectName);
    if (v) return openVariableEditor({ mode: 'add', name: preselectName, info: v });
  }
  // Picker.
  const root = document.createElement('div');
  let q = '';
  const draw = () => {
    const rows = sortBy(
      state.discovered.variables.filter((v) => !q || (v.name + ' ' + (v.unit ?? '')).toLowerCase().includes(q)),
      (v) => v.name.toLowerCase(),
    );
    const configured = new Set(state.blocks.flatMap((b) => b.variables.map((v) => v.name)));
    root.innerHTML = `
      <input type="search" class="form-control mb-2" id="hgui-vp-q" placeholder="Search variables…" value="${h(q)}" autofocus />
      <div style="max-height: 50vh; overflow-y: auto;">
        <table class="hgui-grid">
          <thead><tr><th>Name</th><th>Type</th><th>Current</th><th></th></tr></thead>
          <tbody>
            ${rows.map((v) => `
              <tr>
                <td><code>${h(v.name)}</code></td>
                <td>valuetype ${h(v.valuetype)}${v.unit ? ` (${h(v.unit)})` : ''}</td>
                <td>${h(String(v.value ?? ''))}</td>
                <td class="hgui-row-actions">
                  ${configured.has(v.name)
                    ? '<span class="hgui-pill">added</span>'
                    : `<button class="btn btn-sm btn-primary" data-pick-var="${h(v.name)}">Select</button>`}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    root.querySelector('#hgui-vp-q').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); draw(); });
    root.querySelectorAll('[data-pick-var]').forEach((b) => {
      b.addEventListener('click', () => {
        const v = variableLookup().get(b.dataset.pickVar);
        bsModal().hide();
        setTimeout(() => openVariableEditor({ mode: 'add', name: v.name, info: v }), 250);
      });
    });
  };
  draw();
  openModal({ title: 'Add variable — pick from CCU', body: root, okLabel: 'Done', onOk: () => true });
}

function openEditVariableDialog(name) {
  const info = variableLookup().get(name);
  let bridgeIndex = -1;
  let entry = null;
  for (let bi = 0; bi < state.blocks.length; bi++) {
    const found = state.blocks[bi].variables.find((v) => v.name === name);
    if (found) { bridgeIndex = bi; entry = found; break; }
  }
  if (!entry) return;
  openVariableEditor({ mode: 'edit', name, info, entry, bridgeIndex });
}

function openVariableEditor({ mode, name, info, entry, bridgeIndex }) {
  const draft = entry ? { ...entry } : { name, displayName: info?.name ?? name };
  let target = bridgeIndex ?? 0;
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="hgui-meta mb-2"><code>${h(name)}</code>${info ? ` · valuetype ${h(info.valuetype)}` : ''}</div>
    <div class="hgui-form-row">
      <label>HomeKit name</label>
      <div><input class="form-control" id="hgui-v-display" value="${h(draft.displayName ?? '')}" /></div>
    </div>
    <div class="hgui-form-row">
      <label>Bridge</label>
      <div><select class="form-select" id="hgui-v-bridge">
        ${state.blocks.map((b, bi) => `<option value="${bi}" ${bi === target ? 'selected' : ''}>${h(b.name)}${bi === 0 ? ' (main)' : ''}</option>`).join('')}
      </select></div>
    </div>`;
  root.querySelector('#hgui-v-display').addEventListener('input', (e) => { draft.displayName = e.target.value; });
  root.querySelector('#hgui-v-bridge').addEventListener('change', (e) => { target = parseInt(e.target.value, 10); });
  openModal({
    title: mode === 'add' ? 'Add variable' : `Edit ${name}`,
    body: root,
    okLabel: mode === 'add' ? 'Add' : 'Save',
    onOk: () => {
      for (const b of state.blocks) {
        const i = b.variables.findIndex((v) => v.name === name);
        if (i !== -1) b.variables.splice(i, 1);
      }
      state.blocks[target].variables.push({
        name,
        ...((draft.displayName ?? '').trim() ? { displayName: draft.displayName.trim() } : {}),
      });
      rerender();
      homebridge.toast.success(mode === 'add' ? 'Variable added' : 'Variable updated', 'Variables');
    },
    footerExtra: mode === 'edit'
      ? { label: 'Remove from HomeKit', onClick: () => {
          for (const b of state.blocks) {
            const i = b.variables.findIndex((v) => v.name === name);
            if (i !== -1) b.variables.splice(i, 1);
          }
          rerender(); homebridge.toast.success('Variable removed', 'Variables');
        } }
      : null,
  });
}

// ---------------------------------------------------------------- dialogs: program

function openAddProgramDialog(preselectName) {
  if (!state.discovered.programs.length) {
    homebridge.toast.warning('Run "Discover devices" first', 'Add program');
    return;
  }
  if (preselectName) return openProgramEditor({ mode: 'add', name: preselectName });
  const root = document.createElement('div');
  let q = '';
  const draw = () => {
    const rows = sortBy(
      state.discovered.programs.filter((p) => !q || p.name.toLowerCase().includes(q)),
      (p) => p.name.toLowerCase(),
    );
    const configured = new Set(state.blocks.flatMap((b) => b.programs.map((p) => p.name)));
    root.innerHTML = `
      <input type="search" class="form-control mb-2" id="hgui-pp-q" placeholder="Search programs…" autofocus />
      <div style="max-height: 50vh; overflow-y: auto;">
        <table class="hgui-grid">
          <thead><tr><th>Name</th><th></th></tr></thead>
          <tbody>${rows.map((p) => `
            <tr><td><code>${h(p.name)}</code></td>
              <td class="hgui-row-actions">${configured.has(p.name)
                ? '<span class="hgui-pill">added</span>'
                : `<button class="btn btn-sm btn-primary" data-pick-prog="${h(p.name)}">Select</button>`}
              </td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;
    root.querySelector('#hgui-pp-q').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); draw(); });
    root.querySelectorAll('[data-pick-prog]').forEach((b) => {
      b.addEventListener('click', () => {
        bsModal().hide();
        setTimeout(() => openProgramEditor({ mode: 'add', name: b.dataset.pickProg }), 250);
      });
    });
  };
  draw();
  openModal({ title: 'Add program — pick from CCU', body: root, okLabel: 'Done', onOk: () => true });
}

function openEditProgramDialog(name) {
  let bridgeIndex = -1;
  let entry = null;
  for (let bi = 0; bi < state.blocks.length; bi++) {
    const found = state.blocks[bi].programs.find((p) => p.name === name);
    if (found) { bridgeIndex = bi; entry = found; break; }
  }
  if (!entry) return;
  openProgramEditor({ mode: 'edit', name, entry, bridgeIndex });
}

function openProgramEditor({ mode, name, entry, bridgeIndex }) {
  const draft = entry ? { ...entry } : { name, displayName: name };
  let target = bridgeIndex ?? 0;
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="hgui-meta mb-2"><code>${h(name)}</code></div>
    <div class="hgui-form-row">
      <label>HomeKit name</label>
      <div><input class="form-control" id="hgui-p-display" value="${h(draft.displayName ?? '')}" /></div>
    </div>
    <div class="hgui-form-row">
      <label>Bridge</label>
      <div><select class="form-select" id="hgui-p-bridge">
        ${state.blocks.map((b, bi) => `<option value="${bi}" ${bi === target ? 'selected' : ''}>${h(b.name)}${bi === 0 ? ' (main)' : ''}</option>`).join('')}
      </select></div>
    </div>`;
  root.querySelector('#hgui-p-display').addEventListener('input', (e) => { draft.displayName = e.target.value; });
  root.querySelector('#hgui-p-bridge').addEventListener('change', (e) => { target = parseInt(e.target.value, 10); });
  openModal({
    title: mode === 'add' ? 'Add program' : `Edit ${name}`,
    body: root,
    okLabel: mode === 'add' ? 'Add' : 'Save',
    onOk: () => {
      for (const b of state.blocks) {
        const i = b.programs.findIndex((p) => p.name === name);
        if (i !== -1) b.programs.splice(i, 1);
      }
      state.blocks[target].programs.push({
        name,
        ...((draft.displayName ?? '').trim() ? { displayName: draft.displayName.trim() } : {}),
      });
      rerender();
      homebridge.toast.success(mode === 'add' ? 'Program added' : 'Program updated', 'Programs');
    },
    footerExtra: mode === 'edit'
      ? { label: 'Remove from HomeKit', onClick: () => {
          for (const b of state.blocks) {
            const i = b.programs.findIndex((p) => p.name === name);
            if (i !== -1) b.programs.splice(i, 1);
          }
          rerender(); homebridge.toast.success('Program removed', 'Programs');
        } }
      : null,
  });
}

// ---------------------------------------------------------------- API actions

async function onTestConnection() {
  $('hgui-test-result').textContent = 'Testing…';
  homebridge.showSpinner();
  try {
    const res = await homebridge.request('/test-connection', state.blocks[0]);
    $('hgui-test-result').innerHTML = res.ok
      ? `<span class="text-success">✓ ${h(res.message)}</span>`
      : `<span class="text-danger">✗ ${h(res.message)}</span>`;
    (res.ok ? homebridge.toast.success : homebridge.toast.warning)(res.message, 'CCU');
  } catch (err) {
    $('hgui-test-result').innerHTML = `<span class="text-danger">✗ ${h(err.message)}</span>`;
    homebridge.toast.error(err.message, 'CCU');
  } finally { homebridge.hideSpinner(); }
}

async function onDiscover() {
  homebridge.showSpinner();
  try {
    const res = await homebridge.request('/discover', state.blocks[0]);
    state.discovered = res;
    rerender();
    homebridge.toast.success(
      `${res.devices.length} devices · ${res.variables.length} variables · ${res.programs.length} programs · ${res.rooms.length} rooms`,
      'Discovery complete',
    );
  } catch (err) {
    homebridge.toast.error(err.message, 'Discovery');
  } finally { homebridge.hideSpinner(); }
}

async function onImport() {
  const file = $('hgui-import-file').files?.[0];
  const pasted = $('hgui-import-paste').value.trim();
  const multi = $('hgui-import-multibridge').checked;
  const status = $('hgui-import-status');
  $('hgui-import-warnings').innerHTML = '';
  $('hgui-bridges-summary').innerHTML = '';

  homebridge.showSpinner();
  try {
    let report;
    if (file) {
      const buf = await file.arrayBuffer();
      const tarballBase64 = bufToBase64(buf);
      report = await homebridge.request('/import-backup', { tarballBase64 });
    } else if (pasted.length) {
      report = await homebridge.request('/import-config-json', { configJson: pasted });
    } else {
      homebridge.toast.warning('Provide a backup file or paste a config.json first', 'Import');
      return;
    }

    if (multi) {
      const blocks = await homebridge.request('/split-into-bridges', { report });
      // Rebuild state.blocks: keep existing main, replace child bridges from import.
      const main = state.blocks[0];
      // Apply common settings from report.meta if missing.
      if (report.meta?.ccuIp && !main.ccuIp) main.ccuIp = report.meta.ccuIp;
      // First bridge from import becomes main contents (preserving main bridge identity).
      state.blocks = [
        { ...main, channels: blocks[0]?.channels ?? [], variables: blocks[0]?.variables ?? [], programs: blocks[0]?.programs ?? [], name: blocks[0]?.name ?? main.name },
        ...blocks.slice(1).map((bb) => ({
          ...DEFAULT_BLOCK(),
          ccuIp: main.ccuIp, useTls: main.useTls, interfaces: { ...main.interfaces },
          interfacePorts: { ...main.interfacePorts }, ccuAuth: { ...main.ccuAuth }, eventServer: { ...main.eventServer },
          name: bb.name, _bridge: bb.bridge, channels: bb.channels, variables: bb.variables, programs: bb.programs,
        })),
      ];
      $('hgui-bridges-summary').innerHTML = `
        <div class="alert alert-info">${blocks.length} bridges configured. Review them in the <strong>Bridges</strong> tab and click Save when ready.</div>`;
    } else {
      mergeReportIntoMain(report);
    }

    if (report.warnings?.length) {
      $('hgui-import-warnings').innerHTML =
        '<div class="alert alert-warning"><strong>Imported with warnings:</strong><ul class="mb-0">' +
        report.warnings.map((w) => `<li>${h(w)}</li>`).join('') + '</ul></div>';
    }
    status.textContent = `Imported ${report.channels.length} channels, ${report.variables.length} variables, ${report.programs.length} programs.`;
    homebridge.toast.success('Import complete — review and Save', 'Import');
    rerender();
  } catch (err) {
    homebridge.toast.error(err.message, 'Import');
    status.textContent = '✗ ' + err.message;
  } finally { homebridge.hideSpinner(); }
}

function mergeReportIntoMain(report) {
  const main = state.blocks[0];
  const cMap = new Map(main.channels.map((c) => [c.address, c]));
  for (const c of report.channels) cMap.set(c.address, c);
  main.channels = Array.from(cMap.values());
  const vMap = new Map(main.variables.map((v) => [v.name, v]));
  for (const v of report.variables) vMap.set(v.name, v);
  main.variables = Array.from(vMap.values());
  const pMap = new Map(main.programs.map((p) => [p.name, p]));
  for (const p of report.programs) pMap.set(p.name, p);
  main.programs = Array.from(pMap.values());
  if (report.meta?.ccuIp && !main.ccuIp) main.ccuIp = report.meta.ccuIp;
}

async function onSave() {
  $('hgui-save-status').textContent = '';
  homebridge.showSpinner();
  try {
    const next = [...state.otherBlocks, ...state.blocks];
    await homebridge.updatePluginConfig(next);
    await homebridge.savePluginConfig();
    $('hgui-save-status').textContent = '✓ Saved';
    homebridge.toast.success(`Saved ${state.blocks.length} bridge(s)`, 'Saved');
  } catch (err) {
    $('hgui-save-status').textContent = '✗ ' + err.message;
    homebridge.toast.error(err.message, 'Save failed');
  } finally { homebridge.hideSpinner(); }
}

// ---------------------------------------------------------------- helpers

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------- init

async function init() {
  try {
    homebridge.hideSchemaForm?.();
    homebridge.disableSaveButton?.();
  } catch (_e) { /* older Homebridge UI versions */ }

  // Load config blocks: take everything with platform=HomematicHap (or
  // the first block missing a platform) into state.blocks; keep
  // unrelated blocks in state.otherBlocks for round-tripping.
  try {
    const blocks = await homebridge.getPluginConfig();
    const ours = [];
    const other = [];
    for (const b of blocks ?? []) {
      if (!b) continue;
      if (b.platform === 'HomematicHap' || b.platform === undefined) ours.push(b);
      else other.push(b);
    }
    if (ours.length === 0) ours.push(DEFAULT_BLOCK());
    // Merge defaults into each block so we don't crash on partials.
    state.blocks = ours.map((b) => ({ ...DEFAULT_BLOCK(), ...b,
      interfaces: { ...DEFAULT_BLOCK().interfaces, ...(b.interfaces ?? {}) },
      ccuAuth: { ...DEFAULT_BLOCK().ccuAuth, ...(b.ccuAuth ?? {}) },
      eventServer: { ...DEFAULT_BLOCK().eventServer, ...(b.eventServer ?? {}) },
      interfacePorts: { ...(b.interfacePorts ?? {}) },
      channels: b.channels ?? [], variables: b.variables ?? [], programs: b.programs ?? [],
    }));
    state.otherBlocks = other;
  } catch (err) {
    homebridge.toast.error(`Could not load config: ${err.message}`);
  }

  try {
    state.services = await homebridge.request('/services');
  } catch (err) {
    homebridge.toast.error(`Could not load service list: ${err.message}`);
  }

  // Probe the plugin version for a dashboard banner.
  try {
    const r = await fetch('package.json'); // server.src.js doesn't expose this; harmless if it 404s
    if (r.ok) state.pluginVersion = (await r.json())?.version ?? state.pluginVersion;
  } catch { /* ignore */ }
  $('hgui-version-banner').textContent = state.pluginVersion !== 'unknown' ? `v${state.pluginVersion}` : '';

  // Wire sidebar.
  document.querySelectorAll('.hgui-nav-link').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.view));
  });
  $('hgui-discover-btn').addEventListener('click', onDiscover);
  $('hgui-test-btn').addEventListener('click', onTestConnection);
  $('hgui-save-btn').addEventListener('click', onSave);

  rerender();
}

init();
