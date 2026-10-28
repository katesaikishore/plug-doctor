'use strict';

/**
 * Bluetooth source: one device for this computer's Bluetooth controller
 * (radio), plus one per paired or connected Bluetooth device.
 *
 *   macOS    system_profiler SPBluetoothDataType -json
 *   Linux    systemctl, rfkill and bluetoothctl (BlueZ)
 *   Windows  Get-PnpDevice -Class Bluetooth
 *
 * Every parser here survives missing keys and junk: an unknown shape means
 * "not known", never a crash.
 */

const { PROBLEM_CODES } = require('../usb/windows');

const CONTROLLER_ID = 'bluetooth:controller';
/** At most this many `bluetoothctl info` calls per refresh. */
const MAX_INFO = 20;

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const str = (x) => (typeof x === 'string' && x.trim() ? x.trim() : typeof x === 'number' ? String(x) : null);
// bluetoothctl colors its output when it thinks it talks to a terminal.
const clean = (text) => String(text ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');

/** "AC-90-85-12-34-56", "ac9085123456" ... -> "AC:90:85:12:34:56", or null. */
/** Sidebar picture for each kind of Bluetooth device. */
const KIND_ICONS = { headphones: 'headphones', headset: 'headphones', speaker: 'speaker', keyboard: 'keyboard', mouse: 'mouse', trackpad: 'mouse', controller: 'gamepad', pen: 'tablet', phone: 'phone' };

function normalizeAddress(value) {
  const hex = String(value ?? '').replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12 || !/^[0-9a-f:\-\s]+$/i.test(String(value).trim())) return null;
  return hex.toUpperCase().match(/../g).join(':');
}

/** "attrib_on", "attrib_Yes", "yes", true -> true; the opposites -> false; anything else -> null. */
function yesNo(value) {
  if (typeof value === 'boolean') return value;
  const s = String(value ?? '').trim().toLowerCase().replace(/^attrib_/, '');
  if (['yes', 'on', 'true', '1'].includes(s)) return true;
  if (['no', 'off', 'false', '0'].includes(s)) return false;
  return null;
}

/** "85%", 85, "0x55 (85)" -> 85; anything else -> null. */
function percent(value) {
  if (typeof value === 'number') return value >= 0 && value <= 100 ? Math.round(value) : null;
  const s = String(value ?? '');
  const m = s.match(/\((\d{1,3})\)/) ?? s.match(/^\s*(\d{1,3})\s*%?\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

/** "0x004C", "0x004C (Apple)", "004c" -> "004c". */
function hexId(value) {
  const m = String(value ?? '').match(/^\s*(?:0x)?([0-9a-f]{1,4})\b/i);
  return m ? m[1].toLowerCase().padStart(4, '0') : null;
}

/** Plain kind of device from whatever type hints the OS gives (minor type, icon name, device name). */
function kindOf(...hints) {
  const s = hints.filter(Boolean).join(' ').toLowerCase();
  if (!s) return 'other';
  if (/headset/.test(s)) return 'headset';
  if (/headphone|earbud|earphone|airpods/.test(s)) return 'headphones';
  if (/speaker|audio-card|hifi|portable audio|car audio|soundbar/.test(s)) return 'speaker';
  if (/keyboard/.test(s)) return 'keyboard';
  if (/trackpad|touchpad/.test(s)) return 'trackpad';
  if (/mouse/.test(s)) return 'mouse';
  if (/gamepad|joystick|input-gaming|game ?controller|dualsense|dualshock|xbox/.test(s)) return 'controller';
  if (/\bpen\b|tablet|digitizer|stylus/.test(s)) return 'pen';
  if (/watch/.test(s)) return 'watch';
  if (/\b(i?phone|smartphone)\b|cellular/.test(s)) return 'phone';
  if (/computer|laptop|desktop/.test(s)) return 'computer';
  return 'other';
}

/** Best kind: the OS's own type first, the device name only as a fallback. */
function bestKind(typeHints, name) {
  const k = kindOf(...asArray(typeHints));
  return k !== 'other' ? k : kindOf(name);
}

/** Only keep battery levels that were actually reported. */
function battery(levels) {
  const out = {};
  for (const [k, v] of Object.entries(levels)) if (v != null) out[k] = v;
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------- device shape

function baseDevice({ id, displayName, productName, vendorName = null, categories, problem = null, details, raw }) {
  return {
    id,
    source: 'bluetooth',
    vendorName,
    productName,
    displayName,
    serial: null,
    categories,
    interfaces: [],
    nodes: [],
    driver: { bound: null, names: [], unboundInterfaces: [] },
    problem,
    details,
    raw,
  };
}

/**
 * @param {object} c  controller facts: present, powered, chipset, address, ...
 * @param {any[]} remotes  remote device facts, for the counts
 */
function controllerDevice(c, remotes, raw) {
  return baseDevice({
    id: CONTROLLER_ID,
    displayName: 'Bluetooth (this computer)',
    productName: 'Bluetooth',
    vendorName: c.vendor ?? null,
    categories: ['bluetooth', 'controller'],
    icon: 'bluetooth',
    problem: c.problem ?? null,
    details: {
      role: 'controller',
      present: c.present ?? null,
      powered: c.powered ?? null,
      chipset: c.chipset ?? null,
      address: c.address ?? null,
      name: c.name ?? null,
      firmware: c.firmware ?? null,
      transport: c.transport ?? null,
      softBlocked: c.softBlocked ?? null,
      hardBlocked: c.hardBlocked ?? null,
      serviceActive: c.serviceActive ?? null,
      toolsMissing: c.toolsMissing ?? [],
      instanceId: c.instanceId ?? null,
      connectedCount: remotes.filter((r) => r.connected === true).length,
      pairedCount: remotes.filter((r) => r.paired !== false).length,
    },
    raw,
  });
}

/** The controller state each remote device carries, so its diagnosis can say "Bluetooth is off". */
const controllerSnapshot = (c) => ({
  present: c.present ?? null,
  powered: c.powered ?? null,
  softBlocked: c.softBlocked ?? null,
  hardBlocked: c.hardBlocked ?? null,
  serviceActive: c.serviceActive ?? null,
});

function remoteDevice(r, controller) {
  const key = r.address ?? r.name ?? 'unknown';
  return baseDevice({
    id: `bluetooth:${key}`,
    displayName: r.name ?? r.address ?? 'Bluetooth device',
    productName: r.name ?? null,
    categories: ['bluetooth', r.kind ?? 'other'],
    icon: KIND_ICONS[r.kind] ?? 'bluetooth',
    problem: r.problem ?? null,
    details: {
      role: 'device',
      name: r.name ?? null,
      address: r.address ?? null,
      kind: r.kind ?? 'other',
      minorType: r.minorType ?? null,
      connected: r.connected ?? null,
      paired: r.paired ?? null,
      trusted: r.trusted ?? null,
      blocked: r.blocked ?? null,
      battery: r.battery ?? null,
      vendorId: r.vendorId ?? null,
      productId: r.productId ?? null,
      firmware: r.firmware ?? null,
      instanceId: r.instanceId ?? null,
      controller: controllerSnapshot(controller),
    },
    raw: r.raw ?? {},
  });
}

function assemble(controller, remotes, raw) {
  // Connected devices first; then by name. Two entries with the same id
  // (the same device in two lists) collapse into the connected one.
  const seen = new Set();
  const sorted = [...remotes].sort((a, b) => Number(b.connected === true) - Number(a.connected === true) || String(a.name).localeCompare(String(b.name)));
  const unique = sorted.filter((r) => {
    const key = r.address ?? r.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [controllerDevice(controller, unique, raw), ...unique.map((r) => remoteDevice(r, controller))];
}

// ---------------------------------------------------------------- macOS

/** Device lists system_profiler has used over the years, and what being in one means. */
const MAC_LISTS = [
  ['device_connected', true],
  ['device_not_connected', false],
  ['devices_list', null],
  ['device_title', null],
];

/**
 * Parse `system_profiler SPBluetoothDataType -json`.
 * @param {string} jsonText
 * @returns {{ controller: object, devices: object[] }}
 */
function parseSystemProfiler(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText || 'null');
  } catch {
    return { controller: { present: null }, devices: [] };
  }
  const roots = asArray(data?.SPBluetoothDataType).filter(isObject);
  if (roots.length === 0) return { controller: { present: null }, devices: [] };
  const root = roots[0];

  const cp = [root.controller_properties, root.local_device_title].find(isObject) ?? null;
  const controller = cp
    ? {
        present: true,
        powered: yesNo(cp.controller_state ?? cp.general_power ?? cp.controller_power),
        chipset: str(cp.controller_chipset ?? cp.general_chipset),
        address: normalizeAddress(cp.controller_address ?? cp.general_address) ?? str(cp.controller_address ?? cp.general_address),
        name: str(cp.general_name),
        firmware: str(cp.controller_firmwareVersion ?? cp.general_fw_version),
        transport: str(cp.controller_transport ?? cp.general_transport),
        vendor: /\(([^)]+)\)/.exec(String(cp.controller_vendorID ?? cp.general_vendorID ?? ''))?.[1] ?? null,
      }
    : { present: false };

  const devices = [];
  for (const [key, listConnected] of MAC_LISTS) {
    for (const entry of asArray(root[key])) {
      if (!isObject(entry)) continue;
      for (const [name, p] of Object.entries(entry)) {
        if (!isObject(p)) continue;
        const address = normalizeAddress(p.device_address ?? p.device_addr);
        const minorType = str(p.device_minorType);
        devices.push({
          name: str(name),
          address,
          minorType,
          kind: bestKind([minorType, str(p.device_majorType)], name),
          connected: listConnected ?? yesNo(p.device_connected ?? p.device_isconnected),
          // system_profiler lists the devices this Mac remembers, which are paired.
          paired: yesNo(p.device_paired ?? p.device_ispaired) ?? true,
          battery: battery({
            main: percent(p.device_batteryLevelMain ?? p.device_batteryLevel ?? p.device_batteryPercent),
            left: percent(p.device_batteryLevelLeft),
            right: percent(p.device_batteryLevelRight),
            case: percent(p.device_batteryLevelCase),
          }),
          vendorId: hexId(p.device_vendorID),
          productId: hexId(p.device_productID),
          firmware: str(p.device_firmwareVersion),
          raw: { [key]: { [name]: p } },
        });
      }
    }
  }
  return { controller, devices };
}

async function listMac({ run }) {
  const res = await run('system_profiler', ['SPBluetoothDataType', '-json'], { timeout: 20000 });
  const { controller, devices } = res.ok ? parseSystemProfiler(res.stdout) : { controller: { present: null }, devices: [] };
  return assemble(controller, devices, { systemProfiler: res.ok ? 'SPBluetoothDataType' : res.stderr.trim() || 'failed' });
}

// ---------------------------------------------------------------- Linux

/** Parse `bluetoothctl show`. present is false on "No default controller available". */
function parseBluetoothctlShow(text) {
  const t = clean(text);
  const head = t.match(/^Controller\s+([0-9A-F:]{17})/im);
  if (!head) return { present: /no default controller/i.test(t) ? false : null };
  const field = (k) => t.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'im'))?.[1].trim() ?? null;
  return {
    present: true,
    address: normalizeAddress(head[1]),
    name: field('Alias') ?? field('Name'),
    powered: yesNo(field('Powered')),
    powerState: field('PowerState'), // newer BlueZ: on | off | off-blocked | ...
  };
}

/** Parse `bluetoothctl devices`: "Device AA:BB:CC:DD:EE:FF Some Name" lines. */
function parseBluetoothctlDevices(text) {
  const out = [];
  for (const line of clean(text).split('\n')) {
    const m = line.trim().match(/^Device\s+([0-9A-F]{2}(?::[0-9A-F]{2}){5})(?:\s+(.*))?$/i);
    if (m) out.push({ address: normalizeAddress(m[1]), name: m[2]?.trim() || null });
  }
  return out;
}

/** Parse `bluetoothctl info <address>`. */
function parseBluetoothctlInfo(text) {
  const t = clean(text);
  const head = t.match(/^Device\s+([0-9A-F:]{17})/im);
  if (!head) return null;
  const fields = {};
  const uuids = [];
  for (const line of t.split('\n')) {
    const m = line.match(/^\s+([A-Za-z][A-Za-z ]*?):\s*(.*)$/);
    if (!m) continue;
    if (m[1] === 'UUID') uuids.push(m[2].trim());
    else if (!(m[1] in fields)) fields[m[1]] = m[2].trim();
  }
  // "Device AA:BB:... not available" and friends carry no fields.
  if (Object.keys(fields).length === 0) return null;
  const modalias = fields.Modalias?.match(/v([0-9A-F]{4})p([0-9A-F]{4})/i);
  return {
    address: normalizeAddress(head[1]),
    name: fields.Alias || fields.Name || null,
    icon: fields.Icon ?? null,
    paired: yesNo(fields.Paired),
    bonded: yesNo(fields.Bonded),
    trusted: yesNo(fields.Trusted),
    blocked: yesNo(fields.Blocked),
    connected: yesNo(fields.Connected),
    battery: percent(fields['Battery Percentage']),
    vendorId: modalias ? modalias[1].toLowerCase() : null,
    productId: modalias ? modalias[2].toLowerCase() : null,
    modalias: fields.Modalias ?? null,
    uuids,
  };
}

/** Parse `rfkill list bluetooth`. A radio is blocked when any Bluetooth switch blocks it. */
function parseRfkill(text) {
  const entries = [];
  let cur = null;
  for (const line of clean(text).split('\n')) {
    const head = line.match(/^(\d+):\s*([^:]+):\s*(.+)$/);
    if (head) {
      cur = { index: Number(head[1]), name: head[2].trim(), type: head[3].trim(), soft: null, hard: null };
      entries.push(cur);
      continue;
    }
    const m = line.match(/^\s+(Soft|Hard) blocked:\s*(yes|no)/i);
    if (m && cur) cur[m[1].toLowerCase()] = m[2].toLowerCase() === 'yes';
  }
  const bt = entries.filter((e) => /bluetooth/i.test(e.type));
  return {
    entries: bt,
    softBlocked: bt.length ? bt.some((e) => e.soft === true) : null,
    hardBlocked: bt.length ? bt.some((e) => e.hard === true) : null,
  };
}

async function listLinux({ run }) {
  const raw = {};
  const toolsMissing = [];

  const svc = await run('systemctl', ['is-active', 'bluetooth'], { timeout: 5000 });
  // is-active exits non-zero when the service is not running; its stdout still says why.
  const svcState = svc.stdout.trim().split('\n')[0] || null;
  const serviceActive = svc.missing || !svcState ? null : svcState === 'active';
  raw.service = svc.missing ? 'systemctl not available' : svcState;

  const rf = await run('rfkill', ['list', 'bluetooth'], { timeout: 5000 });
  const rfkill = rf.missing ? { entries: [], softBlocked: null, hardBlocked: null } : parseRfkill(rf.stdout);
  if (rf.missing) toolsMissing.push('rfkill');
  raw.rfkill = rf.stdout.trim() || null;

  const ver = await run('bluetoothctl', ['--version'], { timeout: 5000 });
  const haveCtl = !ver.missing;
  if (!haveCtl) toolsMissing.push('bluetoothctl');

  // bluetoothctl waits forever for the daemon when it is not running.
  let show = { present: null };
  const remotes = [];
  if (haveCtl && serviceActive !== false) {
    const res = await run('bluetoothctl', ['show'], { timeout: 5000 });
    show = parseBluetoothctlShow(`${res.stdout}\n${res.stderr}`);
    raw.show = clean(res.stdout).trim() || null;

    if (show.present) {
      let listed = await run('bluetoothctl', ['devices', 'Paired'], { timeout: 5000 });
      // Older BlueZ has no filter argument: list everything and let `info` sort it out.
      if (!listed.ok || /invalid|too many|unknown|usage/i.test(`${listed.stdout}\n${listed.stderr}`)) {
        listed = await run('bluetoothctl', ['devices'], { timeout: 5000 });
      }
      const known = parseBluetoothctlDevices(listed.stdout).slice(0, MAX_INFO);
      const infos = await Promise.all(known.map((d) => run('bluetoothctl', ['info', d.address], { timeout: 5000 })));
      known.forEach((d, i) => {
        const info = infos[i].ok ? parseBluetoothctlInfo(infos[i].stdout) : null;
        if (info && info.paired !== true && info.connected !== true) return; // a stranger seen nearby
        const name = info?.name ?? d.name;
        remotes.push({
          name,
          address: d.address,
          minorType: info?.icon ?? null,
          kind: bestKind([info?.icon], name),
          connected: info?.connected ?? null,
          paired: info?.paired ?? null,
          trusted: info?.trusted ?? null,
          blocked: info?.blocked ?? null,
          battery: battery({ main: info?.battery ?? null }),
          vendorId: info?.vendorId ?? null,
          productId: info?.productId ?? null,
          raw: { info: info ? clean(infos[i].stdout).trim() : null },
        });
      });
    }
  }

  const blocked = rfkill.softBlocked === true || rfkill.hardBlocked === true;
  const present = show.present === true || rfkill.entries.length > 0 ? true
    : show.present === false && !rf.missing ? false
    : null;
  const controller = {
    present,
    powered: blocked ? false : show.powered ?? null,
    address: show.address ?? null,
    name: show.name ?? null,
    softBlocked: rfkill.softBlocked,
    hardBlocked: rfkill.hardBlocked,
    serviceActive,
    toolsMissing,
  };
  return assemble(controller, remotes, raw);
}

// ---------------------------------------------------------------- Windows

/** Present Bluetooth-class Plug and Play devices as JSON (same approach as usb/windows.js). */
const PNP_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Get-PnpDevice -Class Bluetooth -PresentOnly |',
  ' Select-Object InstanceId, FriendlyName, Status, Manufacturer,',
  '  @{n="Problem";e={[int]$_.ConfigManagerErrorCode}} |',
  ' ConvertTo-Json -Depth 3 -Compress',
].join('\n');

/** Instance IDs of remote (paired) devices and their services. */
const REMOTE_RE = /^(BTHENUM|BTHLE|BTHLEDEVICE)\\/i;
/** Windows' own Bluetooth plumbing: enumerators, protocol drivers. */
const PLUMBING_RE = /^(BTH|SWD|ROOT)\\/i;
/** The device itself (not one of its services): BTHENUM\DEV_AC9085123456\..., BTHLE\DEV_D0C5D3123456\... */
const REMOTE_DEV_RE = /^(BTHENUM|BTHLE)\\DEV_([0-9A-F]{12})\\/i;
/** VID&0001004c_PID&2014 in service IDs: the first 4 digits say which registry (Bluetooth SIG or USB), the last 4 are the ID. */
const VIDPID_RE = /VID&[0-9A-F]{0,4}([0-9A-F]{4})_PID&([0-9A-F]{4})/i;

/**
 * Parse PNP_SCRIPT output into the radio and the paired devices.
 * @param {string} jsonText
 */
function parsePnpBluetooth(jsonText) {
  let rows;
  try {
    rows = asArray(JSON.parse(jsonText || '[]')).filter(isObject);
  } catch {
    return { controller: { present: null }, devices: [], radios: [] };
  }
  const problemOf = (row) => {
    const code = Number(row.Problem) || 0;
    if (code) return { code, message: PROBLEM_CODES[code] ?? `Device Manager reports problem code ${code}.` };
    if (row.Status === 'Error') return { code: null, message: 'Device Manager reports an error for this device.' };
    return null;
  };

  const radios = rows.filter((r) => {
    const id = String(r.InstanceId ?? '');
    return id && !REMOTE_RE.test(id) && !PLUMBING_RE.test(id);
  });
  // A working radio speaks for the computer; a second, failing one shows up in the USB list anyway.
  const radio = radios.find((r) => !problemOf(r)) ?? radios[0] ?? null;
  const controller = radio
    ? {
        present: true,
        powered: null, // Plug and Play does not say whether the radio is switched on
        chipset: str(radio.FriendlyName),
        vendor: str(radio.Manufacturer),
        instanceId: str(radio.InstanceId),
        problem: problemOf(radio),
      }
    : { present: false };

  const services = rows.filter((r) => REMOTE_RE.test(String(r.InstanceId ?? '')) && !REMOTE_DEV_RE.test(String(r.InstanceId)));
  const devices = [];
  for (const row of rows) {
    const m = String(row.InstanceId ?? '').match(REMOTE_DEV_RE);
    if (!m) continue;
    const hex = m[2].toUpperCase();
    const mine = services.filter((s) => String(s.InstanceId).toUpperCase().includes(hex));
    const vp = mine.map((s) => String(s.InstanceId).match(VIDPID_RE)).find(Boolean);
    const problem = [row, ...mine].map(problemOf).find(Boolean) ?? null;
    const name = str(row.FriendlyName);
    devices.push({
      name,
      address: normalizeAddress(hex),
      minorType: null,
      kind: bestKind([], name),
      connected: null, // not reported by Plug and Play
      paired: true,
      battery: null,
      vendorId: vp ? vp[1].toLowerCase() : null,
      productId: vp ? vp[2].toLowerCase() : null,
      instanceId: str(row.InstanceId),
      lowEnergy: /^BTHLE\\/i.test(String(row.InstanceId)),
      problem,
      raw: { pnp: row, services: mine },
    });
  }
  return { controller, devices, radios };
}

async function listWindows({ run }) {
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PNP_SCRIPT], { timeout: 30000 });
  const { controller, devices, radios } = res.ok ? parsePnpBluetooth(res.stdout) : { controller: { present: null }, devices: [], radios: [] };
  return assemble(controller, devices, { radios: radios ?? [] });
}

// ---------------------------------------------------------------- source

/** @type {import('./index').Source} */
const source = {
  id: 'bluetooth',
  label: 'Bluetooth',
  intervalMs: 10000,
  list: async (ctx = {}) => {
    const platform = ctx.platform ?? process.platform;
    const run = ctx.run ?? require('../exec').run;
    if (platform === 'darwin') return listMac({ run });
    if (platform === 'linux') return listLinux({ run });
    if (platform === 'win32') return listWindows({ run });
    return [];
  },
};

module.exports = {
  source,
  CONTROLLER_ID,
  MAX_INFO,
  PNP_SCRIPT,
  normalizeAddress,
  kindOf,
  percent,
  parseSystemProfiler,
  parseBluetoothctlShow,
  parseBluetoothctlDevices,
  parseBluetoothctlInfo,
  parseRfkill,
  parsePnpBluetooth,
  listMac,
  listLinux,
  listWindows,
};
