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

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  printer: svg('<path d="M7 8V3.5h10V8"/><rect x="3" y="8" width="18" height="9" rx="2.5"/><rect x="7" y="14" width="10" height="6.5" rx="1"/><path d="M17.5 11h.01"/>'),
  storage: svg('<path d="M5.6 5h12.8l2.6 7.5V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4.5z"/><path d="M3 12.5h18"/><path d="M7 15.75h.01M10.5 15.75h.01"/>'),
  serial: svg('<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/>'),
  input: svg('<rect x="2.5" y="6" width="19" height="12" rx="3"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8"/>'),
  camera: svg('<circle cx="12" cy="10" r="6.5"/><circle cx="12" cy="10" r="2.5"/><path d="M12 16.5v4M8 20.5h8"/>'),
  audio: svg('<path d="M3.5 14.5V12a8.5 8.5 0 0 1 17 0v2.5"/><rect x="3" y="14" width="4.5" height="6.5" rx="2"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="2"/>'),
  bluetooth: svg('<path d="m7 7 10 10-5 5V2l5 5L7 17"/>'),
  network: svg('<rect x="3" y="13.5" width="18" height="7" rx="2.5"/><path d="M7 17h.01M10.5 17h.01"/><path d="M8.5 9.5a5 5 0 0 1 7 0M6 7a8.5 8.5 0 0 1 12 0"/>'),
  adapter: svg('<path d="M2.5 8.5a13.5 13.5 0 0 1 19 0M5.5 12a9 9 0 0 1 13 0M8.5 15.5a4.5 4.5 0 0 1 7 0"/><path d="M12 19h.01"/>'),
  unknown: svg('<path d="M12 3v13.5"/><path d="m9.5 5.5 2.5-2.5 2.5 2.5"/><path d="M12 13 8 11V8.5M12 15l4-2v-2.5"/><circle cx="12" cy="19" r="2"/>'),
  gear: svg('<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>'),
  plug: svg('<path d="M9 2.5V7M15 2.5V7"/><path d="M6 7h12v3.5a6 6 0 0 1-12 0z"/><path d="M12 16.5v5"/>'),
  display: svg('<rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8.5 21h7M12 17v4"/>'),
  tv: svg('<rect x="2.5" y="7" width="19" height="13" rx="2.5"/><path d="m8 3 4 4 4-4"/>'),
  speaker: svg('<rect x="5" y="2.5" width="14" height="19" rx="3"/><circle cx="12" cy="14.5" r="3.5"/><path d="M12 7h.01"/>'),
  phone: svg('<rect x="6.5" y="2.5" width="11" height="19" rx="3"/><path d="M11 18.5h2"/>'),
  scanner: svg('<rect x="3" y="12" width="18" height="8" rx="2.5"/><path d="M5 12l3-7h11.5"/><path d="M7 16h.01M11 16h6"/>'),
  gamepad: svg('<rect x="2.5" y="7" width="19" height="11" rx="5.5"/><path d="M7.5 10.5v3M6 12h3M15.5 11.5h.01M17.5 13.5h.01"/>'),
  cast: svg('<path d="M2.5 16a5.5 5.5 0 0 1 5.5 5.5M2.5 12a9.5 9.5 0 0 1 9.5 9.5M2.5 20.5h.01"/><path d="M2.5 8V6.5A2.5 2.5 0 0 1 5 4h14a2.5 2.5 0 0 1 2.5 2.5v11A2.5 2.5 0 0 1 19 20h-4.5"/>'),
  mouse: svg('<rect x="6" y="2.5" width="12" height="19" rx="6"/><path d="M12 6.5v3.5"/>'),
  tablet: svg('<path d="M3 21l3.5-1L18 8.5 15.5 6 4 17.5z"/><path d="m14 7.5 2.5 2.5M15.5 6l2-2 2.5 2.5-2 2"/>'),
  'smart-home': svg('<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10"/><path d="M9.5 20.5v-6h5v6"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
  moon: svg('<path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z"/>'),
};
// Same pictures under the other names families use.
ICONS.headphones = ICONS.audio;
ICONS.keyboard = ICONS.input;
ICONS.wireless = ICONS.bluetooth;

/** Small marks for checks and steps: drawn, so they stay crisp at any size. */
const mark = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const MARKS = {
  pass: mark('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  warn: mark('<path d="M12 6v7.5M12 18h.01"/>'),
  fail: mark('<path d="M7 7l10 10M17 7 7 17"/>'),
  info: mark('<path d="M12 11v6.5M12 6.5h.01"/>'),
};
/** Other names families may use for the same pictures. */
const ICON_ALIASES = { airplay: 'cast', 'network-device': 'network', 'network-adapter': 'adapter', wifi: 'adapter', ethernet: 'adapter', monitor: 'display', controller: 'gamepad', 'game-controller': 'gamepad', webcam: 'camera', midi: 'audio', usb: 'plug', generic: 'unknown', drive: 'storage' };
function iconFor(...keys) {
  for (const k of keys) {
    if (!k) continue;
    if (ICONS[k]) return ICONS[k];
    if (ICONS[ICON_ALIASES[k]]) return ICONS[ICON_ALIASES[k]];
  }
  return ICONS.unknown;
}

const STATUS_TEXT = { ok: 'Working', 'needs-fix': 'Needs a fix', broken: 'Not working', unknown: 'Connected', idle: 'Not connected', checking: 'Checking…' };

/** A command as a person would type it. Arguments with spaces or symbols are quoted. */
function commandLine(s) {
  if (s.kind !== 'command') return s.title;
  const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'");
  return `${s.admin ? '# administrator\n' : ''}${[s.cmd, ...s.args.map(quote)].join(' ')}`;
}

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
  drafts: {}, // deviceId -> chat text not sent yet
  stepsOpen: {}, // "deviceId:planId" -> whether the person opened or closed the step list
  sources: [{ id: 'usb', label: 'USB' }], // device sources, in sidebar order
  providers: [], // AI providers the assistant can use
};

function deviceName(d) {
  return d.displayName || (d.vendorId ? `USB device ${d.vendorId}:${d.productId}` : 'Unnamed device');
}

function primaryCategory(d) {
  return state.diagnoses[d.id]?.category ?? d.categories?.[0] ?? 'unknown';
}

function deviceIcon(d) {
  const r = state.diagnoses[d.id];
  return iconFor(d.icon, r?.facts?.icon, r?.icon, primaryCategory(d), d.categories?.[0]);
}

function sourceLabel(id) {
  return state.sources.find((s) => s.id === id)?.label ?? id;
}

/** The line above a device's name: "PRINTER · USB 03f0:2b17", "TV", "PRINTER · ON YOUR NETWORK". */
function eyebrow(d, r) {
  const kind = r?.categoryLabel ?? 'Device';
  if (d.vendorId) return `${kind} · USB ${d.vendorId}:${d.productId}`;
  const src = sourceLabel(d.source ?? 'usb');
  // "Screen · Screens" and "Bluetooth device · Bluetooth" say the same thing twice.
  const stem = src.toLowerCase().split(' ')[0].replace(/s$/, '');
  return kind.toLowerCase().includes(stem) ? kind : `${kind} · ${src}`;
}

function statusOf(d) {
  return state.diagnoses[d.id]?.status ?? 'checking';
}

// ---------------------------------------------------------------- sidebar

function renderList() {
  const list = $('#device-list');
  list.replaceChildren();
  if (state.devices.length === 0) {
    list.append(h('li', { class: 'group-title' }, 'Devices'), h('li', { class: 'muted small pad' }, 'Nothing plugged in yet.'));
    return;
  }
  const order = state.sources.map((s) => s.id);
  const groups = new Map(order.map((id) => [id, []]));
  for (const d of state.devices) {
    const src = d.source ?? 'usb';
    if (!groups.has(src)) groups.set(src, []);
    groups.get(src).push(d);
  }
  for (const [src, devices] of groups) {
    if (devices.length === 0) continue;
    list.append(h('li', { class: 'group-title' }, sourceLabel(src)));
    for (const d of devices) {
      const status = statusOf(d);
      list.append(
        h(
          'li',
          {},
          h(
            'button',
            { class: `device-item ${state.selected === d.id ? 'selected' : ''}`, onclick: () => select(d.id) },
            h('span', { class: 'device-icon', html: deviceIcon(d) }),
            h('span', { class: 'device-text' }, h('span', { class: 'device-name' }, deviceName(d)), h('span', { class: 'device-sub' }, STATUS_TEXT[status])),
            h('span', { class: `dot ${status}` }),
          ),
        ),
      );
    }
  }
}

function select(id) {
  const changed = state.selected !== id;
  if (changed) $('#detail').scrollTop = 0;
  state.selected = id;
  renderList();
  renderDetail();
  if (changed) animateDetail();
}

/** One short entrance when the person picks a device. */
function animateDetail() {
  const root = $('#detail');
  root.classList.remove('enter');
  void root.offsetWidth; // restart the animation
  root.classList.add('enter');
  clearTimeout(animateDetail.timer);
  animateDetail.timer = setTimeout(() => root.classList.remove('enter'), 400);
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
        h('p', {}, 'Printers, phones, screens and TVs, headphones, drives, cameras, controllers, dev boards. Plug Doctor works out what it is, checks whether your computer can use it, and fixes it if it can.'),
        state.devices.length ? h('p', { class: 'muted' }, 'Or pick something on the left.') : null,
        state.devices.length === 0 ? phoneTips() : null,
      ),
    );
    return;
  }
  const r = state.diagnoses[d.id];
  const status = statusOf(d);
  const head = h(
    'section',
    { class: 'device-head' },
    h('div', { class: 'device-art', html: deviceIcon(d) }),
    h(
      'div',
      { class: 'device-title' },
      h('p', { class: 'eyebrow' }, eyebrow(d, r).toUpperCase()),
      h('h1', {}, deviceName(d)),
      h('p', { class: 'headline' }, r?.headline ?? 'Checking this device…'),
      r?.support ? h('p', { class: `support ${r.support.level}`, title: r.support.note ?? '' }, h('span', { class: 'support-dot' }), r.support.label) : null,
      r?.support?.note && r.support.level !== 'unsupported' ? h('p', { class: 'muted small support-text' }, r.support.note) : null,
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
  // Redrawing replaces the chat box, so keep where the person was: scroll position and focus.
  const oldLog = $('#chat-log');
  const wasAtBottom = !oldLog || oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40;
  const hadFocus = document.activeElement?.id === 'chat-input';
  root.replaceChildren(head, tabs, h('div', { class: 'tab-body' }, body));
  if (state.tab === 'assistant') {
    const log = $('#chat-log');
    if (log && wasAtBottom) log.scrollTop = log.scrollHeight;
    if (hadFocus) $('#chat-input')?.focus();
  }
}

/** Shown when nothing is connected: a phone that charges but never appears is the most common case. */
function phoneTips() {
  return h(
    'div',
    { class: 'card note-card' },
    h('p', { class: 'eyebrow' }, 'Phone charges but does not show up?'),
    h(
      'ol',
      { class: 'steps' },
      h('li', { class: 'step' }, 'Unlock the phone.'),
      h('li', { class: 'step' }, 'Use the cable that came with it, plugged straight into a port on the computer, not a hub.'),
      h('li', { class: 'step' }, 'On an Android phone, tap the USB notification and choose File transfer. On an iPhone or iPad, tap Trust and enter the passcode.'),
      h('li', { class: 'step' }, 'Still nothing? Try another cable, then restart the phone and the computer.'),
    ),
  );
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
  if (r.status === 'idle') {
    return h(
      'div',
      { class: 'card callout' },
      h('h3', {}, 'Not connected right now'),
      h('p', {}, 'This device is paired with your computer but is switched off or out of range. Turn it on, then press "Check again".'),
    );
  }
  const parts = [];
  const prog = state.progress[d.id];

  if (r.plans.length) {
    parts.push(h('h2', {}, r.status === 'ok' ? 'Try it' : 'How to fix it'));
    r.plans.forEach((plan, i) => parts.push(renderPlan(d, plan, i === 0, prog?.planId === plan.id ? prog : null)));
  } else if (r.support?.level === 'unsupported') {
    parts.push(
      h(
        'div',
        { class: 'card callout' },
        h('h3', {}, r.support.label),
        h('p', {}, r.support.note ?? 'There is no driver for this device on this computer.'),
        h('p', { class: 'muted' }, 'Plug Doctor will not lower your computer\'s security to force it. The assistant can help you find something that works instead.'),
        h('button', { class: 'btn ghost', onclick: () => ((state.tab = 'assistant'), renderDetail(), sendChat(d, `My ${deviceName(d)} can't work on this computer. What can I use instead?`)) }, 'Ask for alternatives'),
      ),
    );
  } else if (r.status !== 'ok' && r.status !== 'idle') {
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
      r.checks.map((c) => h('li', { class: `check ${c.status}` }, h('span', { class: 'mark', html: MARKS[c.status] ?? MARKS.info }), h('span', {}, h('strong', {}, c.label), c.detail ? h('span', { class: 'check-detail' }, c.detail) : null))),
    ),
  );
  return parts;
}

/** The circle beside a step: its number, a spinner while it runs, or a mark when it has finished. */
function stepState(st, i) {
  if (st === 'running') return h('span', { class: 'step-state' }, h('span', { class: 'spinner' }));
  const icon = { done: MARKS.pass, failed: MARKS.fail, waiting: MARKS.warn }[st];
  return icon ? h('span', { class: 'step-state', html: icon }) : h('span', { class: 'step-state' }, String(i + 1));
}

function renderPlan(d, plan, recommended, prog) {
  const running = prog && !prog.done;
  const stepEls = plan.steps.map((s, i) => {
    const st = prog?.steps[i] ?? 'pending';
    return h(
      'li',
      { class: `step ${st}` },
      stepState(st, i),
      h(
        'div',
        {},
        h('strong', {}, s.title),
        s.explain ? h('p', { class: 'muted small' }, s.explain) : null,
        s.kind === 'command' ? h('code', { class: 'cmd' }, commandLine(s)) : null,
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
    h(
      'details',
      {
        // Remember whether the person opened or closed the list, so a redraw does not undo it.
        open: state.stepsOpen[`${d.id}:${plan.id}`] ?? (running || recommended),
        ontoggle: (e) => (state.stepsOpen[`${d.id}:${plan.id}`] = e.target.open),
      },
      h('summary', {}, `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`),
      h('ol', { class: 'steps' }, stepEls),
    ),
    manual,
    footer,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: `btn ${recommended ? 'primary' : 'ghost'}`, disabled: running ? true : null, onclick: () => runFix(d.id, plan) }, running ? 'Working…' : prog?.done && !prog.ok ? 'Try again' : state.diagnoses[d.id]?.status === 'ok' ? 'Do it' : 'Make it work'),
      running ? h('button', { class: 'btn ghost', onclick: () => stopFix(d.id) }, 'Stop') : null,
    ),
  );
}

/** Stops before the next step. A command that is already running finishes first. */
function stopFix(deviceId) {
  plugDoctor.stopFix(deviceId).catch((err) => toast(err.message));
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
      h('p', {}, `The assistant uses ${providerFor(s.assistantProvider)?.label ?? 'an AI model'}. Add your API key in Settings, or pick a model that runs on this computer. Everything else in Plug Doctor works without it.`),
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
  input.value = state.drafts[d.id] ?? '';
  input.addEventListener('input', () => (state.drafts[d.id] = input.value));
  input.addEventListener('keydown', (e) => {
    // Enter sends, but not while an input method is still composing text (Japanese, Chinese and others).
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
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
  const tools = h(
    'div',
    { class: 'chat-tools' },
    h('button', { class: 'link', onclick: newConversation }, 'New conversation'),
    h('span', { class: 'muted small' }, `${assistantLabel()} · Every change it suggests needs your approval.`),
  );
  return [log, form, tools];
}

function renderChatItem(m) {
  if (m.role === 'you') return h('div', { class: 'bubble you' }, m.text);
  if (m.role === 'assistant') return h('div', { class: 'bubble assistant' }, renderMarkdown(m.text, plugDoctor.openExternal));
  if (m.role === 'activity') return h('div', { class: 'activity' }, '↳ ', m.text);
  if (m.role === 'error') return h('div', { class: 'bubble error' }, m.text);
  if (m.role === 'manual') return renderManualChat(m);
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

/** A manual step that an assistant-proposed fix is waiting on, answered right in the chat. */
function renderManualChat(m) {
  const answer = (done) => {
    m.answered = true;
    plugDoctor.manualDone(m.token, done);
    renderDetail();
  };
  return h(
    'div',
    { class: 'card your-turn' },
    h('p', { class: 'eyebrow' }, 'Your turn'),
    h('strong', {}, m.title),
    h('p', {}, m.explain ?? ''),
    m.answered
      ? h('p', { class: 'muted small' }, 'Answered.')
      : h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn ghost small', onclick: () => answer(false) }, 'Stop'),
          h('button', { class: 'btn primary small', onclick: () => answer(true) }, "I've done this"),
        ),
  );
}

function shareRecipe(recipe, json) {
  // A recipe is too long for an address, so it goes to the clipboard and the issue asks for a paste.
  plugDoctor.copy(json);
  const params = new URLSearchParams({ template: 'recipe.yml', title: `Recipe: ${recipe.name ?? 'new device'}`, labels: 'recipe' });
  plugDoctor.openExternal(`https://github.com/katesaikishore/plug-doctor/issues/new?${params}`);
  toast('Recipe copied. Paste it into the issue.');
}

function askAboutDevice(d) {
  sendChat(d, `Please investigate my ${deviceName(d)} and make it work if you can.`);
}

async function sendChat(d, text) {
  text = String(text ?? '').trim();
  if (!text || state.assistantBusy) return;
  if (!state.settings.assistantEnabled || !state.settings.hasApiKey) {
    toast('Turn the assistant on, and add an API key, in Settings first.');
    return openSettings();
  }
  if (d) state.drafts[d.id] = '';
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

/** "Claude (Anthropic)", or the provider and model the person picked. */
function assistantLabel() {
  const s = state.settings;
  const p = providerFor(s.assistantProvider);
  if (!p) return 'AI assistant';
  return `${p.label}${s.assistantModel ? ` · ${s.assistantModel}` : ''}`;
}

async function newConversation() {
  await plugDoctor.resetAssistant();
  state.chat = [];
  renderDetail();
}

// ---------------------------------------------------------------- under the hood

/** "refreshHz" -> "Refresh hz", "builtIn" -> "Built in". */
function humanize(key) {
  const words = String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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
  const usb = (d.source ?? 'usb') === 'usb';
  const facts = [
    ...(usb ? [['USB ID', `${d.vendorId}:${d.productId}`]] : [['Found via', sourceLabel(d.source)]]),
    ['Vendor', d.vendorName ?? '—'],
    ['Product', d.productName ?? '—'],
    ['Serial', d.serial ?? '—'],
    ...(usb ? [['Connected at', d.location ?? '—']] : []),
    ...(usb && d.driver ? [['Drivers', d.driver.names.join(', ') || (d.driver.bound === false ? 'none' : 'unknown')]] : []),
    ...(r?.support ? [['Support', r.support.label]] : []),
    ...(r?.facts?.deviceId ? [['IEEE 1284 ID', r.facts.deviceId]] : []),
    ...(r?.facts?.commandSet ? [['Printer languages', r.facts.commandSet.join(', ')]] : []),
    ...(r?.facts?.ports?.length ? [['Ports', r.facts.ports.join(', ')]] : []),
    ...Object.entries(d.details ?? {})
      .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => [humanize(k), typeof v === 'object' ? JSON.stringify(v) : String(v)]),
  ];
  return [
    h('p', { class: 'muted' }, usb
      ? 'What the operating system reports about this device. This is where reverse engineering starts: the IDs say which chip or model it really is, the interface classes say what it claims to be, and the drivers say who answered.'
      : 'What your computer can see about this device.'),
    h('table', { class: 'facts' }, facts.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))),
    usb ? h('h2', {}, 'Interfaces') : null,
    usb
      ? h(
          'table',
          { class: 'facts mono' },
          h('tr', {}, h('th', {}, '#'), h('th', {}, 'Class'), h('th', {}, 'Sub'), h('th', {}, 'Proto'), h('th', {}, 'Name'), h('th', {}, 'Driver')),
          d.interfaces.map((i) => h('tr', {}, h('td', {}, i.number ?? '?'), h('td', {}, i.class ?? '??'), h('td', {}, i.subclass ?? '??'), h('td', {}, i.protocol ?? '??'), h('td', {}, i.name ?? '—'), h('td', {}, i.driver ?? '—'))),
        )
      : null,
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
  form.scanNetwork.checked = s.scanNetwork;
  form.theme.value = s.theme ?? 'system';
  form.apiKey.value = '';
  fillProviderSelect();
  form.assistantProvider.value = s.assistantProvider ?? 'anthropic';
  settingsSnapshot = s;
  showProviderFields();
  $('#settings-error').hidden = true;
  dlg.showModal();
}

/** The settings the dialog opened with, so switching provider back restores what was saved. */
let settingsSnapshot = {};

const providerFor = (id) => state.providers.find((p) => p.id === id) ?? state.providers[0];

/** Providers grouped as Recommended, Open models, On this computer, Other closed models, Other. */
function fillProviderSelect() {
  const select = $('#provider-select');
  if (select.options.length) return;
  const groups = new Map();
  for (const p of state.providers) {
    if (!groups.has(p.groupLabel)) groups.set(p.groupLabel, []);
    groups.get(p.groupLabel).push(p);
  }
  for (const [label, providers] of groups) {
    select.append(h('optgroup', { label }, providers.map((p) => h('option', { value: p.id }, p.label))));
  }
}

/** Show the fields the picked provider needs, with its own key status and help. */
function showProviderFields() {
  const form = $('#settings-form');
  const s = settingsSnapshot;
  const p = providerFor(form.assistantProvider.value);
  if (!p) return;
  const saved = s.assistantProvider === p.id;
  form.assistantModel.placeholder = p.model || 'Model name';
  form.assistantModel.value = saved ? s.assistantModel ?? '' : '';
  const ownAddress = p.local || p.custom;
  $('#baseurl-field').hidden = !ownAddress;
  form.assistantBaseUrl.placeholder = p.baseURL || 'https://...';
  form.assistantBaseUrl.value = saved && ownAddress ? s.assistantBaseUrl ?? '' : '';
  $('#key-field').hidden = !p.needsKey && !p.custom;
  $('#key-label').textContent = p.custom ? 'API key (if the server needs one)' : `${p.label} API key`;
  $('#key-status').textContent = s.savedKeys?.[p.id] ? '(saved — leave empty to keep it)' : '(not set)';
  const host = p.keyPage ? new URL(p.keyPage).host : '';
  $('#key-help').textContent = `Stored encrypted in your system keychain.${host ? ` Get one at ${host}.` : ''}`;
  $('#provider-note').textContent = p.kind === 'anthropic'
    ? 'Recommended. Claude can also search the web for drivers and fixes.'
    : p.local
      ? `Runs on this computer, so nothing is sent anywhere. Install it from ${host}, then download a model that can use tools. Web research works with Claude only.`
      : p.custom
        ? 'Any server that speaks the OpenAI Chat Completions format with tools. Web research works with Claude only.'
        : `${p.open ? 'Open-weight models, run by this provider.' : 'A closed model.'} Web research works with Claude only.`;
}

$('#provider-select').addEventListener('change', showProviderFields);

// Cancel closes without saving. It is not a submit button, so pressing Enter in
// the key field saves (Save is the form's first submit button).
$('#settings-cancel').addEventListener('click', () => $('#settings').close());

$('#settings-form').addEventListener('submit', async (e) => {
  if (e.submitter?.id !== 'settings-save') return;
  e.preventDefault();
  const form = e.target;
  const patch = {
    autoFix: form.autoFix.checked,
    assistantEnabled: form.assistantEnabled.checked,
    webResearch: form.webResearch.checked,
    scanNetwork: form.scanNetwork.checked,
    theme: form.theme.value,
    assistantProvider: form.assistantProvider.value,
    assistantModel: form.assistantModel.value,
    assistantBaseUrl: $('#baseurl-field').hidden ? '' : form.assistantBaseUrl.value,
  };
  if (form.apiKey.value.trim()) patch.apiKey = form.apiKey.value.trim();
  try {
    state.settings = await plugDoctor.updateSettings(patch);
    paintThemeButton();
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
    ...plan.steps.map((s) => h('li', { class: 'step' }, h('div', {}, h('strong', {}, s.title), h('p', { class: 'muted small' }, s.explain), h('code', { class: 'cmd' }, commandLine(s))))),
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
  // One message at a time: a new one replaces the old one instead of stacking on it.
  document.querySelectorAll('.toast').forEach((el) => el.remove());
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
    // The chat shows the step and waits for the person, rather than answering "done" for them.
    if (e.type === 'manual-wait') state.chat.push({ role: 'manual', token: e.token, title: e.title, explain: e.explain });
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

const THEMES = ['system', 'light', 'dark'];
const THEME_LABEL = { system: 'Appearance: same as your computer', light: 'Appearance: light', dark: 'Appearance: dark' };

function paintThemeButton() {
  const theme = state.settings.theme ?? 'system';
  const btn = $('#theme-toggle');
  btn.innerHTML = { system: ICONS.display, light: ICONS.sun, dark: ICONS.moon }[theme] ?? ICONS.display;
  btn.title = THEME_LABEL[theme];
  btn.setAttribute('aria-label', THEME_LABEL[theme]);
}

$('#theme-toggle').addEventListener('click', async () => {
  const next = THEMES[(THEMES.indexOf(state.settings.theme ?? 'system') + 1) % THEMES.length];
  state.settings = await plugDoctor.updateSettings({ theme: next });
  paintThemeButton();
  toast(THEME_LABEL[next]);
});
$('#open-settings').addEventListener('click', openSettings);
$('#quit-app').addEventListener('click', () => plugDoctor.quit());
// The app hides its menu bar, so Ctrl+Q (Cmd+Q on a Mac) is how a person quits it.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'q') plugDoctor.quit();
});
document.body.dataset.platform = plugDoctor.platform;

(async () => {
  state.settings = await plugDoctor.getSettings();
  state.providers = await plugDoctor.listProviders();
  paintThemeButton();
  const { devices, diagnoses, sources } = await plugDoctor.listDevices();
  if (sources?.length) state.sources = sources;
  state.devices = devices;
  state.diagnoses = diagnoses;
  if (devices.length) state.selected = devices[0].id;
  renderList();
  renderDetail();
})();
