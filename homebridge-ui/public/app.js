/**
 * Frontend logic for the homebridge-homematic-hap custom UI.
 * Plain ES modules + the global `homebridge` object — no framework.
 *
 * The app has one piece of state, `model`, which mirrors the plugin
 * config block currently being edited. Every render reads from `model`
 * and every interaction writes to it; the only side effect is pushing
 * the (possibly mutated) `model` back to homebridge.updatePluginConfig.
 */

const $ = (id) => document.getElementById(id);

const state = {
  model: {
    platform: 'HomematicHap',
    name: 'HomematicHap',
    ccuIp: '',
    useTls: false,
    interfaces: { bidcosRf: true, hmIpRf: true, bidcosWired: false, virtualDevices: true, cuxd: false },
    ccuAuth: { enabled: false, username: '', password: '' },
    eventServer: { host: '0.0.0.0', port: 9875, watchdogSeconds: 300 },
    channels: [],
    variables: [],
    programs: [],
  },
  services: { channelServices: [], variableServices: [] },
  discovered: { devices: [], variables: [], programs: [] },
  /** Imported child-bridge groups awaiting save (multi-bridge mode). */
  pendingBridgeBlocks: null,
};

async function init() {
  // The plugin renders its own UI; hide Homebridge UI's built-in
  // schema form + outer Save button so the user doesn't see two
  // competing save controls.
  try {
    homebridge.hideSchemaForm?.();
    homebridge.disableSaveButton?.();
  } catch (_e) { /* older Homebridge UI versions: best-effort */ }

  // Load existing config — pluginConfig is an array of platform blocks.
  try {
    const blocks = await homebridge.getPluginConfig();
    const block = blocks.find((b) => b && (b.platform === 'HomematicHap' || b.platform === undefined)) ?? blocks[0];
    if (block) {
      state.model = { ...state.model, ...block };
    }
  } catch (err) {
    homebridge.toast.error(`Could not load existing config: ${err.message}`);
  }

  try {
    state.services = await homebridge.request('/services');
  } catch (err) {
    homebridge.toast.error(`Could not load service list: ${err.message}`);
  }

  renderConfigForm();
  renderChannels();
  renderVariables();
  renderPrograms();

  $('hgui-test-btn').addEventListener('click', onTestConnection);
  $('hgui-discover-btn').addEventListener('click', onDiscover);
  $('hgui-import-btn').addEventListener('click', onImport);
  $('hgui-save-btn').addEventListener('click', onSave);
}

function renderConfigForm() {
  const host = $('hgui-config-form-host');
  host.innerHTML = `
    <div class="row g-2 mb-3">
      <div class="col-md-6">
        <label class="form-label">CCU IP / hostname</label>
        <input class="form-control" id="cf-ccu-ip" />
      </div>
      <div class="col-md-3">
        <label class="form-label">Event port</label>
        <input class="form-control" id="cf-event-port" type="number" min="1024" max="65535" />
      </div>
      <div class="col-md-3 form-check d-flex align-items-end pt-3">
        <div>
          <input class="form-check-input" type="checkbox" id="cf-tls" />
          <label class="form-check-label ms-1" for="cf-tls">Use TLS</label>
        </div>
      </div>
    </div>
    <details class="mb-3">
      <summary>Advanced — interfaces &amp; auth</summary>
      <div class="row g-2 mt-2">
        ${[
          ['bidcosRf', 'BidCos-RF'],
          ['hmIpRf', 'HmIP-RF'],
          ['bidcosWired', 'BidCos-Wired'],
          ['virtualDevices', 'VirtualDevices'],
          ['cuxd', 'CUxD'],
        ].map(([k, label]) => `
          <div class="col-md-3 form-check">
            <input class="form-check-input" type="checkbox" id="cf-if-${k}" />
            <label class="form-check-label" for="cf-if-${k}">${label}</label>
          </div>
        `).join('')}
      </div>
      <div class="row g-2 mt-2">
        <div class="col-md-3 form-check d-flex align-items-end">
          <div>
            <input class="form-check-input" type="checkbox" id="cf-auth-enabled" />
            <label class="form-check-label ms-1" for="cf-auth-enabled">Use CCU auth</label>
          </div>
        </div>
        <div class="col-md-4">
          <label class="form-label">Username</label>
          <input class="form-control" id="cf-auth-user" />
        </div>
        <div class="col-md-5">
          <label class="form-label">Password</label>
          <input class="form-control" type="password" id="cf-auth-pass" />
        </div>
      </div>
    </details>
  `;
  $('cf-ccu-ip').value = state.model.ccuIp;
  $('cf-event-port').value = state.model.eventServer.port;
  $('cf-tls').checked = !!state.model.useTls;
  for (const k of ['bidcosRf', 'hmIpRf', 'bidcosWired', 'virtualDevices', 'cuxd']) {
    $('cf-if-' + k).checked = !!state.model.interfaces[k];
    $('cf-if-' + k).addEventListener('change', (e) => state.model.interfaces[k] = e.target.checked);
  }
  $('cf-auth-enabled').checked = !!state.model.ccuAuth.enabled;
  $('cf-auth-user').value = state.model.ccuAuth.username || '';
  $('cf-auth-pass').value = state.model.ccuAuth.password || '';
  $('cf-ccu-ip').addEventListener('input', (e) => state.model.ccuIp = e.target.value.trim());
  $('cf-event-port').addEventListener('input', (e) => state.model.eventServer.port = parseInt(e.target.value, 10) || 9875);
  $('cf-tls').addEventListener('change', (e) => state.model.useTls = e.target.checked);
  $('cf-auth-enabled').addEventListener('change', (e) => state.model.ccuAuth.enabled = e.target.checked);
  $('cf-auth-user').addEventListener('input', (e) => state.model.ccuAuth.username = e.target.value);
  $('cf-auth-pass').addEventListener('input', (e) => state.model.ccuAuth.password = e.target.value);
}

async function onTestConnection() {
  $('hgui-test-result').textContent = '';
  homebridge.showSpinner();
  try {
    const res = await homebridge.request('/test-connection', state.model);
    $('hgui-test-result').textContent = res.ok ? '✓ ' + res.message : '✗ ' + res.message;
    (res.ok ? homebridge.toast.success : homebridge.toast.warning)(res.message, 'CCU');
  } catch (err) {
    $('hgui-test-result').textContent = '✗ ' + err.message;
    homebridge.toast.error(err.message, 'CCU');
  } finally {
    homebridge.hideSpinner();
  }
}

async function onDiscover() {
  homebridge.showSpinner();
  try {
    const res = await homebridge.request('/discover', state.model);
    state.discovered = res;
    renderChannels();
    renderVariables();
    renderPrograms();
    homebridge.toast.success(
      `${res.devices.length} devices · ${res.variables.length} variables · ${res.programs.length} programs`,
      'Discovery complete',
    );
  } catch (err) {
    homebridge.toast.error(err.message, 'Discovery');
  } finally {
    homebridge.hideSpinner();
  }
}

function renderChannels() {
  const host = $('hgui-channels-host');
  const picked = new Map(state.model.channels.map((c) => [c.address, c]));
  $('hgui-channels-count').textContent = state.model.channels.length;
  if (!state.discovered.devices.length) {
    host.innerHTML = state.model.channels.length
      ? `<p class="hgui-empty">${state.model.channels.length} channels in saved config. Run discovery to edit.</p>`
      : '<p class="hgui-empty">Run "Discover devices" to populate this list.</p>';
    return;
  }
  host.innerHTML = state.discovered.devices.map((d) => `
    <details class="mb-2">
      <summary><strong>${escape(d.name)}</strong> <span class="text-muted">(${escape(d.type)} · ${escape(d.interface)})</span></summary>
      <div class="ms-3 mt-2">
        ${d.channels.map((c) => renderChannelRow(c, picked.has(c.address), picked.get(c.address))).join('')}
      </div>
    </details>
  `).join('');
  for (const c of state.discovered.devices.flatMap((d) => d.channels)) {
    const cb = document.querySelector(`input[data-channel="${cssEscape(c.address)}"][data-role="enabled"]`);
    if (cb) {
      cb.addEventListener('change', (e) => onChannelToggle(c, e.target.checked));
    }
    const sel = document.querySelector(`select[data-channel="${cssEscape(c.address)}"][data-role="service"]`);
    if (sel) {
      sel.addEventListener('change', (e) => onChannelServiceChange(c, e.target.value));
    }
    const subSel = document.querySelector(`select[data-channel="${cssEscape(c.address)}"][data-role="subtype"]`);
    if (subSel) {
      subSel.addEventListener('change', (e) => onChannelSubtypeChange(c, e.target.value));
    }
  }
}

function renderChannelRow(channel, enabled, current) {
  const candidates = (channel.suggestedServices || []).map((k) => state.services.channelServices.find((s) => s.key === k)).filter(Boolean);
  if (candidates.length === 0) {
    return `<div class="hgui-channel-row text-muted">${escape(channel.address)} · ${escape(channel.type)} <em>(no service supports this channel type)</em></div>`;
  }
  const selectedKey = current?.service ?? candidates[0].key;
  const def = candidates.find((c) => c.key === selectedKey) ?? candidates[0];
  const variants = def.variants || [];
  return `
    <div class="hgui-channel-row d-flex align-items-center gap-2 mb-1">
      <input type="checkbox" data-channel="${escape(channel.address)}" data-role="enabled" ${enabled ? 'checked' : ''} />
      <code>${escape(channel.address)}</code>
      <span class="text-muted">${escape(channel.type)}</span>
      <span class="ms-auto">${escape(channel.name)}</span>
      <select class="form-select form-select-sm" style="max-width: 200px" data-channel="${escape(channel.address)}" data-role="service">
        ${candidates.map((c) => `<option value="${escape(c.key)}" ${c.key === selectedKey ? 'selected' : ''}>${escape(c.description)}</option>`).join('')}
      </select>
      ${variants.length ? `
        <select class="form-select form-select-sm" style="max-width: 130px" data-channel="${escape(channel.address)}" data-role="subtype">
          ${variants.map((v) => `<option value="${escape(v.id)}" ${current?.subtype === v.id ? 'selected' : ''}>${escape(v.label)}</option>`).join('')}
        </select>
      ` : ''}
    </div>
  `;
}

function onChannelToggle(channel, enabled) {
  const idx = state.model.channels.findIndex((c) => c.address === channel.address);
  if (enabled && idx === -1) {
    const def = state.services.channelServices.find((s) => (channel.suggestedServices || []).includes(s.key));
    state.model.channels.push({
      address: channel.address,
      name: channel.name,
      service: def?.key ?? 'SwitchAccessory',
      subtype: def?.variants?.[0]?.id,
    });
  } else if (!enabled && idx !== -1) {
    state.model.channels.splice(idx, 1);
  }
  renderChannels();
}

function onChannelServiceChange(channel, key) {
  const c = state.model.channels.find((c) => c.address === channel.address);
  if (!c) return;
  c.service = key;
  const def = state.services.channelServices.find((s) => s.key === key);
  c.subtype = def?.variants?.[0]?.id;
  renderChannels();
}

function onChannelSubtypeChange(channel, subtype) {
  const c = state.model.channels.find((c) => c.address === channel.address);
  if (c) c.subtype = subtype;
}

function renderVariables() {
  const host = $('hgui-variables-host');
  const picked = new Set(state.model.variables.map((v) => v.name));
  $('hgui-variables-count').textContent = state.model.variables.length;
  if (!state.discovered.variables.length) {
    host.innerHTML = state.model.variables.length
      ? `<p class="hgui-empty">${state.model.variables.length} variables in saved config. Run discovery to edit.</p>`
      : '<p class="hgui-empty">Run "Discover devices" first.</p>';
    return;
  }
  host.innerHTML = state.discovered.variables.map((v) => `
    <div class="form-check">
      <input class="form-check-input" type="checkbox" data-variable="${escape(v.name)}" ${picked.has(v.name) ? 'checked' : ''} />
      <label class="form-check-label">
        <code>${escape(v.name)}</code>
        <span class="text-muted ms-2">type ${v.valuetype}, current: ${escape(String(v.value))}</span>
      </label>
    </div>
  `).join('');
  for (const v of state.discovered.variables) {
    const cb = document.querySelector(`input[data-variable="${cssEscape(v.name)}"]`);
    if (cb) {
      cb.addEventListener('change', (e) => {
        const idx = state.model.variables.findIndex((x) => x.name === v.name);
        if (e.target.checked && idx === -1) {
          state.model.variables.push({ name: v.name });
        } else if (!e.target.checked && idx !== -1) {
          state.model.variables.splice(idx, 1);
        }
        $('hgui-variables-count').textContent = state.model.variables.length;
      });
    }
  }
}

function renderPrograms() {
  const host = $('hgui-programs-host');
  const picked = new Set(state.model.programs.map((p) => p.name));
  $('hgui-programs-count').textContent = state.model.programs.length;
  if (!state.discovered.programs.length) {
    host.innerHTML = state.model.programs.length
      ? `<p class="hgui-empty">${state.model.programs.length} programs in saved config. Run discovery to edit.</p>`
      : '<p class="hgui-empty">Run "Discover devices" first.</p>';
    return;
  }
  host.innerHTML = state.discovered.programs.map((p) => `
    <div class="form-check">
      <input class="form-check-input" type="checkbox" data-program="${escape(p.name)}" ${picked.has(p.name) ? 'checked' : ''} />
      <label class="form-check-label"><code>${escape(p.name)}</code></label>
    </div>
  `).join('');
  for (const p of state.discovered.programs) {
    const cb = document.querySelector(`input[data-program="${cssEscape(p.name)}"]`);
    if (cb) {
      cb.addEventListener('change', (e) => {
        const idx = state.model.programs.findIndex((x) => x.name === p.name);
        if (e.target.checked && idx === -1) {
          state.model.programs.push({ name: p.name });
        } else if (!e.target.checked && idx !== -1) {
          state.model.programs.splice(idx, 1);
        }
        $('hgui-programs-count').textContent = state.model.programs.length;
      });
    }
  }
}

async function onImport() {
  const fileInput = $('hgui-import-file');
  const pasted = $('hgui-import-paste').value.trim();
  const multiBridge = $('hgui-import-multibridge').checked;
  $('hgui-import-status').textContent = '';
  $('hgui-import-warnings').innerHTML = '';
  $('hgui-bridges-summary').innerHTML = '';
  state.pendingBridgeBlocks = null;

  homebridge.showSpinner();
  try {
    let report;
    if (fileInput.files && fileInput.files[0]) {
      const buf = await fileInput.files[0].arrayBuffer();
      const tarballBase64 = bufToBase64(buf);
      report = await homebridge.request('/import-backup', { tarballBase64 });
    } else if (pasted.length > 0) {
      report = await homebridge.request('/import-config-json', { configJson: pasted });
    } else {
      homebridge.toast.warning('Provide a backup file or paste a config.json first', 'Import');
      return;
    }

    if (multiBridge) {
      const blocks = await homebridge.request('/split-into-bridges', { report });
      state.pendingBridgeBlocks = blocks;
      renderBridgesSummary(blocks);

      // Show the FIRST block in the on-screen editor for visibility.
      // The user can pick a different block to inspect via the bridges
      // summary; on Save we emit ALL blocks to the homebridge config.
      if (blocks.length > 0) {
        loadBlockIntoModel(blocks[0]);
      }
      if (report.meta?.ccuIp && !state.model.ccuIp) {
        state.model.ccuIp = report.meta.ccuIp;
      }
    } else {
      // Single-bridge mode: merge as before.
      mergeReportIntoModel(report);
    }

    if (report.warnings.length) {
      $('hgui-import-warnings').innerHTML =
        '<div class="alert alert-warning">' +
        '<strong>Imported with warnings:</strong><ul class="mb-0">' +
        report.warnings.map((w) => `<li>${escape(w)}</li>`).join('') +
        '</ul></div>';
    }

    const status = multiBridge
      ? `Imported into ${state.pendingBridgeBlocks.length} child bridges (${report.channels.length} channels, ${report.variables.length} variables, ${report.programs.length} programs total).`
      : `Imported ${report.channels.length} channels, ${report.variables.length} variables, ${report.programs.length} programs.`;
    $('hgui-import-status').textContent = status;
    homebridge.toast.success('Import complete — review and Save to apply', 'Import');

    renderConfigForm();
    renderChannels();
    renderVariables();
    renderPrograms();
  } catch (err) {
    homebridge.toast.error(err.message, 'Import');
    $('hgui-import-status').textContent = '✗ ' + err.message;
  } finally {
    homebridge.hideSpinner();
  }
}

function mergeReportIntoModel(report) {
  const incomingChannels = new Map(report.channels.map((c) => [c.address, c]));
  for (const c of state.model.channels) {
    if (!incomingChannels.has(c.address)) {
      incomingChannels.set(c.address, c);
    }
  }
  state.model.channels = Array.from(incomingChannels.values());

  const incomingVars = new Map(report.variables.map((v) => [v.name, v]));
  for (const v of state.model.variables) {
    if (!incomingVars.has(v.name)) {
      incomingVars.set(v.name, v);
    }
  }
  state.model.variables = Array.from(incomingVars.values());

  const incomingProgs = new Map(report.programs.map((p) => [p.name, p]));
  for (const p of state.model.programs) {
    if (!incomingProgs.has(p.name)) {
      incomingProgs.set(p.name, p);
    }
  }
  state.model.programs = Array.from(incomingProgs.values());

  if (report.meta?.ccuIp && !state.model.ccuIp) {
    state.model.ccuIp = report.meta.ccuIp;
  }
}

function loadBlockIntoModel(block) {
  state.model.name = block.name;
  state.model.channels = block.channels;
  state.model.variables = block.variables;
  state.model.programs = block.programs;
}

function renderBridgesSummary(blocks) {
  const host = $('hgui-bridges-summary');
  if (!blocks || blocks.length === 0) {
    host.innerHTML = '';
    return;
  }
  const rows = blocks.map((b, idx) => `
    <tr>
      <td><code>${idx + 1}</code></td>
      <td>${escape(b.name)}</td>
      <td><code>${escape(b.bridge.username)}</code></td>
      <td><code>${b.bridge.port}</code></td>
      <td>${b.channels.length}</td>
      <td>${b.variables.length}</td>
      <td>${b.programs.length}</td>
    </tr>
  `).join('');
  host.innerHTML = `
    <div class="alert alert-info">
      <strong>${blocks.length} child bridges will be created on Save.</strong>
      Each runs in its own process with its own HomeKit pairing.
    </div>
    <div class="table-responsive">
      <table class="table table-sm">
        <thead><tr><th>#</th><th>Name</th><th>Username</th><th>Port</th><th>Channels</th><th>Vars</th><th>Progs</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function onSave() {
  $('hgui-save-status').textContent = '';
  homebridge.showSpinner();
  try {
    const existing = await homebridge.getPluginConfig();

    if (state.pendingBridgeBlocks && state.pendingBridgeBlocks.length > 0) {
      // Multi-bridge mode: replace any existing HomematicHap block(s)
      // with one platform-config block per imported child bridge.
      const kept = existing.filter((b) => !b || b.platform !== 'HomematicHap');
      const generated = state.pendingBridgeBlocks.map((bb) => ({
        platform: 'HomematicHap',
        name: bb.name,
        _bridge: bb.bridge,
        ccuIp: state.model.ccuIp,
        useTls: state.model.useTls,
        interfaces: state.model.interfaces,
        ccuAuth: state.model.ccuAuth,
        eventServer: state.model.eventServer,
        channels: bb.channels,
        variables: bb.variables,
        programs: bb.programs,
      }));
      const next = [...kept, ...generated];
      await homebridge.updatePluginConfig(next);
      await homebridge.savePluginConfig();
      state.pendingBridgeBlocks = null;
      $('hgui-bridges-summary').innerHTML = '';
      $('hgui-save-status').textContent = `✓ Saved ${generated.length} child bridges`;
      homebridge.toast.success(`Saved ${generated.length} child-bridge platform blocks`, 'Saved');
      return;
    }

    // Single-bridge mode (default).
    const idx = existing.findIndex((b) => b && b.platform === 'HomematicHap');
    if (idx === -1) {
      existing.push(state.model);
    } else {
      existing[idx] = state.model;
    }
    await homebridge.updatePluginConfig(existing);
    await homebridge.savePluginConfig();
    $('hgui-save-status').textContent = '✓ Saved';
    homebridge.toast.success('Configuration saved', 'Saved');
  } catch (err) {
    homebridge.toast.error(err.message, 'Save failed');
    $('hgui-save-status').textContent = '✗ ' + err.message;
  } finally {
    homebridge.hideSpinner();
  }
}

// --- helpers -------------------------------------------------------

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

init();
