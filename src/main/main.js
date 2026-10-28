'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, clipboard, Notification, Tray, Menu, nativeImage } = require('electron');
const { DeviceWatcher } = require('../core/usb/watcher');
const { createInventory } = require('../core/sources');
const { diagnose } = require('../core/diagnose');
const { runPlan } = require('../core/fix/runner');
const report = require('../core/report');
const settings = require('./settings');
const { Assistant } = require('./assistant');
const { createDemo } = require('../core/demo');

const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');

/** @type {BrowserWindow|null} */
let win = null;
let tray = null;
let quitting = false;
// `npm run demo` (or PLUG_DOCTOR_DEMO=1) swaps the real system for simulated devices.
const demo = process.argv.includes('--demo') || process.env.PLUG_DOCTOR_DEMO ? createDemo() : null;
const sys = demo ? demo.ctx : {};
// USB, screens, Bluetooth and the home network, each refreshed at its own pace.
const inventory = createInventory({
  ctx: sys,
  isEnabled: (id) => id !== 'network' || settings.load().scanNetwork,
});
const watcher = new DeviceWatcher({ list: demo ? demo.list : inventory.list });
const sourceList = () => (demo ? demo.sources : inventory.sources).map((s) => ({ id: s.id, label: s.label }));
const diagnoses = new Map(); // deviceId -> latest diagnosis
const inFlight = new Map(); // deviceId -> Promise<diagnosis>
const fixing = new Set(); // deviceIds with a fix running
const autoFixed = new Set(); // deviceIds we already auto-fixed this session
const pending = new Map(); // token -> resolve (approvals, manual steps)
let assistant = null;
let assistantDeviceId = null; // device the person was looking at when they asked

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function token() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Ask the page something and wait for the answer (approval, "I did it"). */
function askPage(channel, payload) {
  const t = token();
  return new Promise((resolve) => {
    pending.set(t, resolve);
    send(channel, { ...payload, token: t });
    if (win) win.show();
  });
}

async function diagnoseById(id) {
  const device = watcher.snapshot().find((d) => d.id === id);
  if (!device) throw new Error('That device is no longer connected.');
  if (inFlight.has(id)) return inFlight.get(id);
  const p = diagnose(device, sys)
    .then((r) => {
      diagnoses.set(id, r);
      send('diagnosis', r);
      return r;
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

function autoEligible(plan) {
  return plan.auto && plan.confidence >= 0.7 && plan.steps.every((s) => s.kind === 'command' && s.safe);
}

async function applyPlan(deviceId, plan) {
  if (fixing.has(deviceId)) throw new Error('A fix is already running for this device.');
  fixing.add(deviceId);
  send('fix-progress', { deviceId, planId: plan.id, type: 'plan-start', title: plan.title });
  try {
    const outcome = await runPlan(plan, {
      ...sys,
      onProgress: (e) => {
        send('fix-progress', { deviceId, planId: plan.id, type: e.type, index: e.index, title: e.step.title, result: e.result });
        if (e.type === 'step-manual' && e.step.kind === 'open-url' && /^https:\/\//.test(e.step.url)) shell.openExternal(e.step.url);
      },
      onManual: (step, index) => askPage('fix-progress', { deviceId, planId: plan.id, type: 'manual-wait', index, title: step.title, explain: step.explain }),
    });
    send('fix-progress', { deviceId, planId: plan.id, type: 'plan-end', ok: outcome.ok, cancelled: outcome.cancelled ?? false });
    return outcome;
  } finally {
    fixing.delete(deviceId);
    // Re-check so the screen shows the real state, not our hopes.
    diagnoseById(deviceId).catch(() => {});
  }
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}

/** The heart of "plug it in and it works". */
async function onAttach(device) {
  const name = device.displayName ?? [device.vendorName, device.productName].filter(Boolean).join(' ');
  let r;
  try {
    r = await diagnoseById(device.id);
  } catch {
    return;
  }
  // Things you physically plug in (USB, a screen) get notifications. A TV
  // switching on or headphones connecting should not pop up anything.
  const plugged = device.source === 'usb' || device.source === 'display';
  if (!plugged) return;
  const best = r.plans[0];
  if (r.status === 'ok') return notify(`${name} is ready`, r.headline);
  // Only fix automatically what was just plugged in by hand: never add every
  // printer found on an office network behind someone's back.
  if (best && device.source === 'usb' && settings.load().autoFix && autoEligible(best) && !autoFixed.has(device.id)) {
    autoFixed.add(device.id);
    notify(`Setting up ${name}`, best.title);
    const outcome = await applyPlan(device.id, best).catch(() => ({ ok: false }));
    const after = diagnoses.get(device.id);
    return notify(outcome.ok ? `${name} is ready` : `${name} needs your help`, outcome.ok ? after?.headline ?? best.title : 'Open Plug Doctor to see what went wrong.');
  }
  notify(`${name} needs attention`, r.headline);
  send('navigate', { deviceId: device.id });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: 'Plug Doctor',
    icon: ICON,
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Keep watching USB ports in the background when the window is closed.
  win.on('close', (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 18, height: 18 }));
  } catch {
    tray = null;
    return;
  }
  tray.setToolTip('Plug Doctor is watching your USB ports');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Plug Doctor', click: () => win?.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => ((quitting = true), app.quit()) },
    ]),
  );
  tray.on('click', () => win?.show());
}

function getAssistant() {
  const key = settings.apiKey();
  if (!key) throw new Error('Add an Anthropic API key in Settings to use the assistant.');
  const s = settings.load();
  if (!assistant || assistant.deps.apiKey !== key || assistant.deps.webResearch !== s.webResearch) {
    assistant = new Assistant({
      apiKey: key,
      webResearch: s.webResearch,
      getDevices: () => watcher.snapshot(),
      diagnoseDevice: (id) => diagnoseById(id),
      onEvent: (e) => send('assistant', e),
      proposeFix: async (plan) => {
        const approved = await askPage('approval-request', { plan });
        if (!approved) return { approved: false };
        return { approved: true, outcome: await applyPlan(assistantDeviceId ?? 'assistant', plan) };
      },
    });
  }
  return assistant;
}

function registerIpc() {
  ipcMain.handle('devices:list', () => ({
    devices: watcher.snapshot(),
    diagnoses: Object.fromEntries(diagnoses),
    sources: sourceList(),
  }));
  ipcMain.handle('devices:diagnose', (_e, id) => diagnoseById(String(id)));
  ipcMain.handle('fix:run', async (_e, deviceId, planId) => {
    // Never trust a plan from the page: look it up from our own diagnosis.
    const plan = diagnoses.get(String(deviceId))?.plans.find((p) => p.id === planId);
    if (!plan) throw new Error('That fix is out of date. Check the device again.');
    const outcome = await applyPlan(String(deviceId), plan);
    return { ok: outcome.ok, cancelled: outcome.cancelled ?? false };
  });
  ipcMain.handle('fix:manual-done', (_e, t, done) => settle(t, Boolean(done)));
  ipcMain.handle('approval:respond', (_e, t, approved) => settle(t, Boolean(approved)));
  ipcMain.handle('report:get', async (_e, deviceId) => {
    const device = watcher.snapshot().find((d) => d.id === deviceId);
    if (!device) throw new Error('That device is no longer connected.');
    const r = diagnoses.get(deviceId) ?? (await diagnoseById(deviceId));
    const descriptors = await report.rawDescriptors(device, sys);
    return { markdown: report.buildMarkdown(device, r, descriptors), issueUrl: report.issueUrl(device), descriptors };
  });
  ipcMain.handle('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) return shell.openExternal(url);
    return null;
  });
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('settings:get', () => settings.publicView());
  ipcMain.handle('settings:update', (_e, patch) => {
    const next = settings.update(patch ?? {});
    assistant = null; // pick up a new key or tool set
    return next;
  });
  ipcMain.handle('assistant:send', async (_e, text, deviceId) => {
    if (!settings.load().assistantEnabled) throw new Error('The assistant is turned off in Settings.');
    assistantDeviceId = deviceId ? String(deviceId) : null;
    await getAssistant().send(String(text).slice(0, 8000), assistantDeviceId);
  });
  ipcMain.handle('assistant:stop', () => assistant?.abort?.abort());
  ipcMain.handle('assistant:reset', () => assistant?.reset());
}

function settle(t, value) {
  const resolve = pending.get(t);
  if (!resolve) return false;
  pending.delete(t);
  resolve(value);
  return true;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win?.show());
  app.whenReady().then(async () => {
    registerIpc();
    createWindow();
    createTray();
    watcher.on('change', (devices) => send('devices', devices));
    watcher.on('attach', (d) => onAttach(d));
    watcher.on('update', (d) => {
      if (!fixing.has(d.id)) diagnoseById(d.id).catch(() => {});
    });
    watcher.on('detach', (d) => {
      diagnoses.delete(d.id);
      autoFixed.delete(d.id);
    });
    await watcher.start({ silentInitial: true });
    send('devices', watcher.snapshot());
    // Check what was already plugged in, without auto-fixing behind the person's back.
    for (const d of watcher.snapshot()) diagnoseById(d.id).catch(() => {});
  });
  app.on('activate', () => (win ? win.show() : createWindow()));
  app.on('before-quit', () => {
    quitting = true;
    watcher.stop();
  });
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });
}
