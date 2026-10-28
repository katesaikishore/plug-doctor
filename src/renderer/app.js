'use strict';

/* global plugDoctor, renderMarkdown */

// ---------------------------------------------------------------- helpers

/** Build DOM without innerHTML: device names come from USB descriptors and are untrusted. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only ever used with the static ICONS below
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const $ = (sel) => document.querySelector(sel);

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  printer: svg('<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>'),
  storage: svg('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 6h4M10 9h4"/>'),
  serial: svg('<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11h.01M10 11h.01M13 11h.01M16 11h.01M8.5 14h.01M11.5 14h.01M14.5 14h.01"/>'),
  input: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  camera: svg('<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/>'),
  audio: svg('<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="5" height="6" rx="1.5"/><rect x="16" y="14" width="5" height="6" rx="1.5"/>'),
  wireless: svg('<path d="M7 7l10 10-5 5V2l5 5L7 17"/>'),
  network: svg('<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4M5 16v-2h14v2"/>'),
  unknown: svg('<path d="M10 2v5H7v6a5 5 0 0 0 10 0V7h-3V2"/><path d="M12 18v4"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  plug: svg('<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>'),
};

const STATUS_TEXT = { ok: 'Working', 'needs-fix': 'Needs a fix', broken: 'Not working', unknown: 'Connected', checking: 'Checking…' };
const CHECK_MARK = { pass: '✓', warn: '!', fail: '✕', info: 'i' };

// ---------------------------------------------------------------- state

const state = {
  devices: [],
  diagnoses: {},
  selected: null,
  tab: 'fix',
  progress: {}, // deviceId -> { planId, steps: string[], manual, ok, done }
  chat: [], // { role: 'you'|'assistant'|'activity'|'error'|'recipe', text|recipe }
  assistantBusy: false,
  settings: {},
  reports: {}, // deviceId -> report
};

function deviceName(d) {
  return d.displayName || `USB device ${d.vendorId}:${d.productId}`;
}

function primaryCategory(d) {
  return state.diagnoses[d.id]?.category ?? d.categories[0] ?? 'unknown';
}

function statusOf(d) {
  return state.diagnoses[d.id]?.status ?? 'checking';
}

// ---------------------------------------------------------------- sidebar

function renderList() {
  const list = $('#device-list');
  list.replaceChildren();
  if (state.devices.length === 0) {
    list.append(h('li', { class: 'muted small pad' }, 'Nothing plugged in yet.'));
    return;
  }
  for (const d of state.devices) {
    const status = statusOf(d);
    list.append(
      h(
        'li',
        {},
        h(
          'button',
          { class: `device-item ${state.selected === d.id ? 'selected' : ''}`, onclick: () => select(d.id) },
          h('span', { class: 'device-icon', html: ICONS[primaryCategory(d)] ?? ICONS.unknown }),
          h('span', { class: 'device-text' }, h('span', { class: 'device-name' }, deviceName(d)), h('span', { class: 'device-sub' }, STATUS_TEXT[status])),
          h('span', { class: `dot ${status}` }),
        ),
      ),
    );
  }
}

function select(id) {
  if (state.selected !== id) $('#detail').scrollTop = 0;
  state.selected = id;
  renderList();
  renderDetail();
}

// ---------------------------------------------------------------- detail

function renderDetail() {
  const root = $('#detail');
  const d = state.devices.find((x) => x.id === state.selected);
  if (!d) {
    root.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('div', { class: 'empty-art', html: ICONS.plug }),
        h('h1', {}, 'Plug in a device.'),
        h('p', {}, 'Printers, USB drives, serial adapters, dev boards, gadgets. Plug Doctor works out what it is, checks whether your computer can use it, and fixes it if it can.'),
        state.devices.length ? h('p', { class: 'muted' }, 'Or pick something on the left.') : null,
      ),
    );
    return;
  }
  const r = state.diagnoses[d.id];
  const status = statusOf(d);
  const head = h(
    'section',
    { class: 'device-head' },
    h('div', { class: 'device-art', html: ICONS[primaryCategory(d)] ?? ICONS.unknown }),
    h(
      'div',
      { class: 'device-title' },
      h('p', { class: 'eyebrow' }, `${(r?.category ?? d.categories[0] ?? 'device').toUpperCase()} · USB ${d.vendorId}:${d.productId}`),
      h('h1', {}, deviceName(d)),
      h('p', { class: 'headline' }, r?.headline ?? 'Checking this device…'),
    ),
    h('div', { class: 'head-side' }, h('span', { class: `pill ${status}` }, STATUS_TEXT[status]), h('button', { class: 'btn ghost small', onclick: () => recheck(d.id) }, 'Check again')),
  );
  const tabs = h(
    'nav',
    { class: 'tabs', role: 'tablist' },
    ...[
      ['fix', 'Fix it'],
      ['assistant', 'Assistant'],
      ['hood', 'Under the hood'],
    ].map(([id, label]) =>
      h('button', { role: 'tab', class: `tab ${state.tab === id ? 'active' : ''}`, 'aria-selected': state.tab === id ? 'true' : 'false', onclick: () => ((state.tab = id), renderDetail()) }, label),
    ),
  );
  let body;
  if (state.tab === 'fix') body = renderFixTab(d, r);
  else if (state.tab === 'assistant') body = renderAssistantTab(d);
  else body = renderHoodTab(d, r);
  root.replaceChildren(head, tabs, h('div', { class: 'tab-body' }, body));
  if (state.tab === 'assistant') {
    const log = $('#chat-log');
    if (log) log.scrollTop = log.scrollHeight;
  }
}

async function recheck(id) {
  delete state.diagnoses[id];
  renderList();
  renderDetail();
  try {
    await plugDoctor.diagnose(id);
  } catch (err) {
    toast(err.message);
  }
}

function renderFixTab(d, r) {
  if (!r) return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Running checks…');
  const parts = [];
  const prog = state.progress[d.id];

  if (r.plans.length) {
    parts.push(h('h2', {}, r.status === 'ok' ? 'Try it' : 'How to fix it'));
    r.plans.forEach((plan, i) => parts.push(renderPlan(d, plan, i === 0, prog?.planId === plan.id ? prog : null)));
  } else if (r.status !== 'ok') {
    parts.push(
      h(
        'div',
        { class: 'card callout' },
        h('h3', {}, 'No automatic fix yet'),
        h('p', {}, 'Plug Doctor\'s built-in checks did not find a safe fix for this device. The assistant can dig deeper: it reads what your computer sees, researches the device, and proposes a fix you approve.'),
        h('button', { class: 'btn primary', onclick: () => ((state.tab = 'assistant'), renderDetail(), askAboutDevice(d)) }, 'Ask the assistant'),
      ),
    );
  }

  for (const rec of r.recipes.filter((x) => x.notes)) {
    parts.push(h('div', { class: 'card note-card' }, h('p', { class: 'eyebrow' }, `From the knowledge base · ${rec.name}`), h('p', {}, rec.notes)));
  }

  parts.push(
    h('h2', {}, 'What we checked'),
    h(
      'ul',
      { class: 'checks' },
      r.checks.map((c) => h('li', { class: `check ${c.status}` }, h('span', { class: 'mark' }, CHECK_MARK[c.status]), h('span', {}, h('strong', {}, c.label), c.detail ? h('span', { class: 'check-detail' }, c.detail) : null))),
    ),
  );
  return parts;
}

function renderPlan(d, plan, recommended, prog) {
  const running = prog && !prog.done;
  const stepEls = plan.steps.map((s, i) => {
    const st = prog?.steps[i] ?? 'pending';
    return h(
      'li',
      { class: `step ${st}` },
      h('span', { class: 'step-state' }, { running: '…', done: '✓', failed: '✕', waiting: '!' }[st] ?? String(i + 1)),
      h(
        'div',
        {},
        h('strong', {}, s.title),
        s.explain ? h('p', { class: 'muted small' }, s.explain) : null,
        s.kind === 'command' ? h('code', { class: 'cmd' }, `${s.admin ? '# administrator\n' : ''}${[s.cmd, ...s.args].join(' ')}`) : null,
        s.kind === 'open-url' ? h('a', { href: '#', onclick: (e) => (e.preventDefault(), plugDoctor.openExternal(s.url)) }, s.url) : null,
        prog?.errors?.[i] ? h('pre', { class: 'error-out' }, prog.errors[i]) : null,
      ),
    );
  });
  const manual = prog?.manual
    ? h(
        'div',
        { class: 'your-turn' },
        h('p', { class: 'eyebrow' }, 'Your turn'),
        h('strong', {}, prog.manual.title),
        h('p', {}, prog.manual.explain ?? ''),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn ghost small', onclick: () => answerManual(d.id, false) }, 'Stop'),
          h('button', { class: 'btn primary small', onclick: () => answerManual(d.id, true) }, "I've done this"),
        ),
      )
    : null;
  let footer;
  if (prog?.done) footer = h('p', { class: prog.ok ? 'ok-text' : 'error' }, prog.ok ? 'Done. Plug Doctor checked the device again: see the status above.' : prog.cancelled ? 'Stopped.' : 'That did not work. The details are under the failed step. You can try the next option or ask the assistant.');
  return h(
    'article',
    { class: `card plan ${recommended ? 'recommended' : ''}` },
    h(
      'header',
      {},
      h('div', {}, recommended ? h('p', { class: 'eyebrow accent' }, 'Recommended') : null, h('h3', {}, plan.title)),
      plan.confidence != null ? h('span', { class: 'confidence', title: 'How sure Plug Doctor is that this will work' }, `${Math.round(plan.confidence * 100)}% sure`) : null,
    ),
    h('p', {}, plan.why),
    h('details', { open: running || recommended ? true : null }, h('summary', {}, `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`), h('ol', { class: 'steps' }, stepEls)),
    manual,
    footer,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: `btn ${recommended ? 'primary' : 'ghost'}`, disabled: running ? true : null, onclick: () => runFix(d.id, plan) }, running ? 'Working…' : prog?.done && !prog.ok ? 'Try again' : state.diagnoses[d.id]?.status === 'ok' ? 'Do it' : 'Make it work'),
    ),
  );
}

async function runFix(deviceId, plan) {
  try {
    await plugDoctor.runFix(deviceId, plan.id);
  } catch (err) {
    toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
}

function answerManual(deviceId, done) {
  const prog = state.progress[deviceId];
  if (!prog?.manual) return;
  plugDoctor.manualDone(prog.manual.token, done);
  prog.steps[prog.manual.index] = done ? 'done' : 'failed';
  prog.manual = null;
  renderDetail();
}

// ---------------------------------------------------------------- assistant

function renderAssistantTab(d) {
  const s = state.settings;
  if (!s.assistantEnabled) {
    return h('div', { class: 'card callout' }, h('h3', {}, 'The assistant is off'), h('p', {}, 'Turn it on in Settings to get help with devices Plug Doctor cannot fix by itself.'), h('button', { class: 'btn primary', onclick: openSettings }, 'Open Settings'));
  }
  if (!s.hasApiKey) {
    return h(
      'div',
      { class: 'card callout' },
      h('h3', {}, 'Connect the assistant'),
      h('p', {}, "The assistant uses Anthropic's Claude. Add your API key in Settings. Everything else in Plug Doctor works without it."),
      h('button', { class: 'btn primary', onclick: openSettings }, 'Add API key'),
    );
  }
  const log = h('div', { class: 'chat-log', id: 'chat-log' });
  if (state.chat.length === 0) {
    log.append(
      h(
        'div',
        { class: 'chat-empty' },
        h('p', {}, `Tell the assistant what is wrong, or let it investigate ${deviceName(d)} for you.`),
        h('button', { class: 'btn primary', onclick: () => askAboutDevice(d) }, 'Investigate this device'),
      ),
    );
  }
  for (const m of state.chat) log.append(renderChatItem(m));
  if (state.assistantBusy) log.append(h('div', { class: 'activity' }, h('span', { class: 'spinner' }), 'Working…'));

  const input = h('textarea', { id: 'chat-input', rows: '2', placeholder: 'e.g. "My printer shows up but nothing prints"', disabled: state.assistantBusy ? true : null });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat(d, input.value);
    }
  });
  const form = h(
    'div',
    { class: 'chat-input' },
    input,
    state.assistantBusy
      ? h('button', { class: 'btn ghost', onclick: () => plugDoctor.stopAssistant() }, 'Stop')
      : h('button', { class: 'btn primary', onclick: () => sendChat(d, input.value) }, 'Send'),
  );
  const tools = h('div', { class: 'chat-tools' }, h('button', { class: 'link', onclick: newConversation }, 'New conversation'), h('span', { class: 'muted small' }, 'Every change it suggests needs your approval.'));
  return [log, form, tools];
}

function renderChatItem(m) {
  if (m.role === 'you') return h('div', { class: 'bubble you' }, m.text);
  if (m.role === 'assistant') return h('div', { class: 'bubble assistant' }, renderMarkdown(m.text, plugDoctor.openExternal));
  if (m.role === 'activity') return h('div', { class: 'activity' }, '↳ ', m.text);
  if (m.role === 'error') return h('div', { class: 'bubble error' }, m.text);
  if (m.role === 'recipe') {
    const json = JSON.stringify(m.recipe, null, 2);
    return h(
      'div',
      { class: 'card recipe' },
      h('p', { class: 'eyebrow accent' }, 'Help the next person'),
      h('p', {}, 'The assistant wrote down this fix as a recipe. Share it with the Plug Doctor project and everyone with this device gets it in one click.'),
      h('pre', {}, json),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn ghost small', onclick: () => (plugDoctor.copy(json), toast('Copied')) }, 'Copy'),
        h('button', { class: 'btn primary small', onclick: () => shareRecipe(m.recipe, json) }, 'Share on GitHub'),
      ),
    );
  }
  return h('div', {}, m.text);
}

function shareRecipe(recipe, json) {
  const params = new URLSearchParams({
    template: 'recipe.yml',
    title: `Recipe: ${recipe.name ?? 'new device'}`,
    labels: 'recipe',
    recipe: json.slice(0, 6000),
  });
  plugDoctor.openExternal(`https://github.com/katesaikishore/plug-doctor/issues/new?${params}`);
}

function askAboutDevice(d) {
  sendChat(d, `Please investigate my ${deviceName(d)} and make it work if you can.`);
}

async function sendChat(d, text) {
  text = String(text ?? '').trim();
  if (!text || state.assistantBusy) return;
  state.chat.push({ role: 'you', text });
  state.assistantBusy = true;
  renderDetail();
  try {
    await plugDoctor.askAssistant(text, d?.id ?? null);
  } catch (err) {
    state.chat.push({ role: 'error', text: err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
  } finally {
    state.assistantBusy = false;
    renderDetail();
  }
}

async function newConversation() {
  await plugDoctor.resetAssistant();
  state.chat = [];
  renderDetail();
}

// ---------------------------------------------------------------- under the hood

function renderHoodTab(d, r) {
  const rep = state.reports[d.id];
  if (!rep) {
    plugDoctor
      .report(d.id)
      .then((x) => {
        state.reports[d.id] = x;
        if (state.selected === d.id && state.tab === 'hood') renderDetail();
      })
      .catch((err) => toast(err.message));
  }
  const facts = [
    ['USB ID', `${d.vendorId}:${d.productId}`],
    ['Vendor', d.vendorName ?? '—'],
    ['Product', d.productName ?? '—'],
    ['Serial', d.serial ?? '—'],
    ['Connected at', d.location ?? '—'],
    ['Drivers', d.driver.names.join(', ') || (d.driver.bound === false ? 'none' : 'unknown')],
    ...(r?.facts?.deviceId ? [['IEEE 1284 ID', r.facts.deviceId]] : []),
    ...(r?.facts?.commandSet ? [['Printer languages', r.facts.commandSet.join(', ')]] : []),
    ...(r?.facts?.ports?.length ? [['Ports', r.facts.ports.join(', ')]] : []),
  ];
  return [
    h('p', { class: 'muted' }, 'What the operating system reports about this device. This is where reverse engineering starts: the IDs say which chip or model it really is, the interface classes say what it claims to be, and the drivers say who answered.'),
    h('table', { class: 'facts' }, facts.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))),
    h('h2', {}, 'Interfaces'),
    h(
      'table',
      { class: 'facts mono' },
      h('tr', {}, h('th', {}, '#'), h('th', {}, 'Class'), h('th', {}, 'Sub'), h('th', {}, 'Proto'), h('th', {}, 'Driver')),
      d.interfaces.map((i) => h('tr', {}, h('td', {}, i.number ?? '?'), h('td', {}, i.class ?? '??'), h('td', {}, i.subclass ?? '??'), h('td', {}, i.protocol ?? '??'), h('td', {}, i.driver ?? '—'))),
    ),
    h('h2', {}, 'Device report'),
    h('p', { class: 'muted' }, 'Share this when asking for help or contributing a recipe. It contains no personal files, only what is listed here.'),
    h(
      'div',
      { class: 'actions left' },
      h('button', { class: 'btn ghost small', disabled: rep ? null : true, onclick: () => (plugDoctor.copy(rep.markdown), toast('Report copied')) }, 'Copy report'),
      h('button', { class: 'btn primary small', disabled: rep ? null : true, onclick: () => (plugDoctor.copy(rep.markdown), plugDoctor.openExternal(rep.issueUrl), toast('Report copied. Paste it into the issue.')) }, 'Ask the community on GitHub'),
    ),
    rep ? h('pre', { class: 'report' }, rep.markdown) : h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Reading descriptors…'),
  ];
}

// ---------------------------------------------------------------- settings & approval

async function openSettings() {
  const dlg = $('#settings');
  const form = $('#settings-form');
  const s = await plugDoctor.getSettings();
  form.autoFix.checked = s.autoFix;
  form.assistantEnabled.checked = s.assistantEnabled;
  form.webResearch.checked = s.webResearch;
  form.apiKey.value = '';
  $('#key-status').textContent = s.hasApiKey ? '(saved — leave empty to keep it)' : '(not set)';
  $('#settings-error').hidden = true;
  dlg.showModal();
}

$('#settings-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const form = e.target;
  const patch = { autoFix: form.autoFix.checked, assistantEnabled: form.assistantEnabled.checked, webResearch: form.webResearch.checked };
  if (form.apiKey.value.trim()) patch.apiKey = form.apiKey.value.trim();
  try {
    state.settings = await plugDoctor.updateSettings(patch);
    $('#settings').close();
    renderDetail();
  } catch (err) {
    const el = $('#settings-error');
    el.textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    el.hidden = false;
  }
});

plugDoctor.onApprovalRequest(({ plan, token }) => {
  $('#approval-title').textContent = plan.title;
  $('#approval-why').textContent = plan.why;
  $('#approval-steps').replaceChildren(
    ...plan.steps.map((s) => h('li', { class: 'step' }, h('div', {}, h('strong', {}, s.title), h('p', { class: 'muted small' }, s.explain), h('code', { class: 'cmd' }, `${s.admin ? '# administrator\n' : ''}${[s.cmd, ...s.args].join(' ')}`)))),
  );
  const dlg = $('#approval');
  dlg.returnValue = '';
  dlg.onclose = () => {
    const approved = dlg.returnValue === 'yes';
    plugDoctor.answerApproval(token, approved);
    state.chat.push({ role: 'activity', text: approved ? `You approved: ${plan.title}` : `You declined: ${plan.title}` });
    renderDetail();
  };
  dlg.showModal();
});

// ---------------------------------------------------------------- events

function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

plugDoctor.onDevices((devices) => {
  state.devices = devices;
  for (const id of Object.keys(state.diagnoses)) if (!devices.some((d) => d.id === id)) delete state.diagnoses[id];
  if (state.selected && !devices.some((d) => d.id === state.selected)) state.selected = null;
  if (!state.selected && devices.length) state.selected = (devices.find((d) => ['broken', 'needs-fix'].includes(statusOf(d))) ?? devices[0]).id;
  renderList();
  renderDetail();
});

plugDoctor.onDiagnosis((r) => {
  state.diagnoses[r.deviceId] = r;
  delete state.reports[r.deviceId];
  renderList();
  if (state.selected === r.deviceId) renderDetail();
});

plugDoctor.onNavigate(({ deviceId }) => {
  state.tab = 'fix';
  select(deviceId);
});

plugDoctor.onFixProgress((e) => {
  const plan = state.diagnoses[e.deviceId]?.plans.find((p) => p.id === e.planId);
  if (e.type === 'plan-start') {
    state.progress[e.deviceId] = { planId: e.planId, steps: (plan?.steps ?? []).map(() => 'pending'), errors: {}, manual: null, done: false };
  }
  const prog = state.progress[e.deviceId];
  if (!prog) return;
  if (e.type === 'step-start') prog.steps[e.index] = 'running';
  if (e.type === 'step-done') prog.steps[e.index] = 'done';
  if (e.type === 'step-manual') prog.steps[e.index] = 'waiting';
  if (e.type === 'step-failed') {
    prog.steps[e.index] = 'failed';
    prog.errors[e.index] = (e.result?.error ?? e.result?.stderr ?? '').trim() || `Exited with code ${e.result?.code}`;
  }
  if (e.type === 'manual-wait') prog.manual = { token: e.token, index: e.index, title: e.title, explain: e.explain };
  if (e.type === 'plan-end') Object.assign(prog, { done: true, ok: e.ok, cancelled: e.cancelled, manual: null });
  if (!plan) {
    // An assistant-proposed fix: narrate it in the chat.
    if (e.type === 'step-start') state.chat.push({ role: 'activity', text: `Running: ${e.title}` });
    if (e.type === 'step-done') state.chat.push({ role: 'activity', text: `Done: ${e.title}` });
    if (e.type === 'step-failed') state.chat.push({ role: 'activity', text: `Failed: ${e.title}: ${prog.errors[e.index]}` });
    if (e.type === 'manual-wait') plugDoctor.manualDone(e.token, true);
  }
  if (state.selected === e.deviceId) renderDetail();
});

plugDoctor.onAssistant((e) => {
  if (e.type === 'text') state.chat.push({ role: 'assistant', text: e.text });
  else if (e.type === 'activity') state.chat.push({ role: 'activity', text: e.text });
  else if (e.type === 'error') state.chat.push({ role: 'error', text: e.text });
  else if (e.type === 'recipe-draft') state.chat.push({ role: 'recipe', recipe: e.recipe });
  if (state.tab === 'assistant') renderDetail();
});

// ---------------------------------------------------------------- boot

$('#open-settings').innerHTML = ICONS.gear;
$('#open-settings').addEventListener('click', openSettings);
document.body.dataset.platform = plugDoctor.platform;

(async () => {
  state.settings = await plugDoctor.getSettings();
  const { devices, diagnoses } = await plugDoctor.listDevices();
  state.devices = devices;
  state.diagnoses = diagnoses;
  if (devices.length) state.selected = devices[0].id;
  renderList();
  renderDetail();
})();
