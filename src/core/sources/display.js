'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { run: defaultRun } = require('../exec');
const { parseEdid, pnpFromCode } = require('../edid');

/**
 * Screens and TVs on HDMI, DisplayPort, USB-C and the built-in panel.
 * Built-in panels are listed too (marked builtIn) because the display
 * family needs to know how many external screens there are.
 */

const DEFAULT_DRM = '/sys/class/drm';

/** PNP manufacturer IDs seen in EDIDs, for screens that only report the code. */
const PNP_VENDORS = {
  ACR: 'Acer', AOC: 'AOC', APP: 'Apple', AUO: 'AU Optronics', AUS: 'ASUS', BNQ: 'BenQ', BOE: 'BOE', CMN: 'Innolux',
  DEL: 'Dell', ENC: 'EIZO', GBT: 'Gigabyte', GSM: 'LG', HEC: 'Hisense', HPN: 'HP', HWP: 'HP', IVM: 'iiyama',
  LEN: 'Lenovo', LGD: 'LG Display', MEI: 'Panasonic', MSI: 'MSI', NEC: 'NEC', PHL: 'Philips', SAM: 'Samsung',
  SDC: 'Samsung Display', SHP: 'Sharp', SNY: 'Sony', TCL: 'TCL', TSB: 'Toshiba', VIZ: 'Vizio', VSC: 'ViewSonic',
  XMI: 'Xiaomi',
};

/** Brands that (almost) only make TVs, and brands that make both TVs and monitors. */
const TV_BRANDS = ['Sony', 'TCL', 'Hisense', 'Vizio', 'Panasonic', 'Sharp', 'Toshiba'];
const MIXED_BRANDS = ['Samsung', 'LG', 'Philips', 'Xiaomi'];

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

/** "3840 x 2160", "3840x2160", "1440 x 900 @ 60.00Hz" -> { width, height } */
function parseSize(text) {
  const m = String(text ?? '').match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/i);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function parseRefresh(text) {
  const m = String(text ?? '').match(/@\s*([\d.]+)\s*Hz/i) ?? String(text ?? '').match(/\b([\d.]+)\s*Hz\b/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Native resolution from macOS's spdisplays_pixelresolution, which varies by version. */
function parseNativeMac(text) {
  if (!text) return null;
  const size = parseSize(String(text).replace(/_/g, ' '));
  if (size) return size;
  const t = String(text).toLowerCase();
  if (/2160p|\buhd\b/.test(t)) return { width: 3840, height: 2160 };
  if (/1440p|\bqhd\b|wqhd/.test(t)) return { width: 2560, height: 1440 };
  if (/1080p|\bfhd\b/.test(t)) return { width: 1920, height: 1080 };
  if (/720p/.test(t)) return { width: 1280, height: 720 };
  return null;
}

const yes = (v) => /(^|_)(yes|on|true)$/i.test(String(v ?? ''));

/** Plain name for a connection type string from any OS. */
function connectionName(raw) {
  const t = String(raw ?? '').toLowerCase().replace(/^spdisplays_/, '');
  if (!t) return null;
  if (/internal|built-?in|edp|lvds|dsi|embedded/.test(t)) return 'Built-in';
  if (/hdmi/.test(t)) return 'HDMI';
  if (/thunderbolt/.test(t)) return 'Thunderbolt';
  if (/displayport|^dp\b|^dp$/.test(t)) return 'DisplayPort';
  if (/dvi/.test(t)) return 'DVI';
  if (/vga|hd15/.test(t)) return 'VGA';
  if (/airplay/.test(t)) return 'AirPlay';
  if (/miracast/.test(t)) return 'Miracast (wireless)';
  return null;
}

/**
 * Is this screen a TV? A guess from the name, the maker and the EDID.
 * @returns {{ isTV: boolean, reason: string|null }}
 */
function guessTv({ name, vendorName, edid, builtIn, televisionFlag }) {
  if (builtIn) return { isTV: false, reason: null };
  if (televisionFlag) return { isTV: true, reason: 'The computer reports it as a television.' };
  const n = String(name ?? '').trim();
  if (/\b(TV|FTV|HDTV|UHDTV)\b/i.test(n)) return { isTV: true, reason: `Its name ("${n}") says TV.` };
  const brand = [...TV_BRANDS, ...MIXED_BRANDS].find(
    (b) => (vendorName ?? '').toLowerCase() === b.toLowerCase() || n.toLowerCase().startsWith(b.toLowerCase()),
  );
  if (brand && /monitor|display/i.test(n)) return { isTV: false, reason: null };
  if (brand && TV_BRANDS.includes(brand)) return { isTV: true, reason: `${brand} mostly makes TVs.` };
  // Samsung and LG TVs often call themselves just "SAMSUNG" or "LG".
  if (brand && n.toLowerCase() === brand.toLowerCase()) return { isTV: true, reason: `It calls itself just "${n}", like ${brand} TVs do.` };
  if (edid?.tvLike) return { isTV: true, reason: 'It lists TV broadcast and cinema picture modes.' };
  if (edid?.sizeCm && Math.hypot(edid.sizeCm.width, edid.sizeCm.height) >= 127) return { isTV: true, reason: 'It is 50 inches or larger.' };
  return { isTV: false, reason: null };
}

// ---------------------------------------------------------------- macOS

/**
 * Parse `system_profiler SPDisplaysDataType -json`. Keys differ between
 * macOS versions and Intel / Apple silicon, so nothing here is required.
 * @param {string} jsonText
 */
function parseSystemProfiler(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText || '{}');
  } catch {
    return [];
  }
  const out = [];
  for (const gpu of asArray(data?.SPDisplaysDataType)) {
    if (!gpu || typeof gpu !== 'object') continue;
    const chip = str(gpu.sppci_model) ?? str(gpu._name);
    for (const d of asArray(gpu.spdisplays_ndrvs)) {
      if (!d || typeof d !== 'object') continue;
      const rawName = str(d._name);
      const name = rawName && !/^spdisplays_/.test(rawName) ? rawName : null;
      const vendorHex = str(d['_spdisplays_display-vendor-id']);
      const productHex = str(d['_spdisplays_display-product-id']);
      const serialHex = str(d['_spdisplays_display-serial-number']);
      const pnp = vendorHex && /^[0-9a-f]+$/i.test(vendorHex) ? pnpFromCode(parseInt(vendorHex, 16)) : null;
      const connectionRaw = str(d.spdisplays_connection_type);
      const displayType = str(d.spdisplays_display_type);
      const resolutionText = str(d._spdisplays_resolution) ?? str(d.spdisplays_resolution);
      const pixels = parseSize(d._spdisplays_pixels ?? d.spdisplays_pixels);
      const looksLike = parseSize(resolutionText);
      const refresh = parseRefresh(resolutionText);
      const builtIn = /internal/i.test(connectionRaw ?? '') || /built-?in/i.test(displayType ?? '') || /^color lcd$/i.test(name ?? '');
      const current = pixels ?? looksLike;
      out.push({
        name,
        pnp,
        productHex: productHex ? productHex.toLowerCase() : null,
        serial: serialHex && !/^0+$/.test(serialHex) ? serialHex : null,
        year: Number(d['_spdisplays_display-year']) || null,
        builtIn,
        online: d.spdisplays_online == null ? true : yes(d.spdisplays_online),
        main: yes(d.spdisplays_main),
        mirror: yes(d.spdisplays_mirror),
        connection: builtIn ? 'Built-in' : connectionName(connectionRaw),
        current: current ? { ...current, refresh } : null,
        looksLike,
        native: parseNativeMac(d.spdisplays_pixelresolution ?? d._spdisplays_pixelresolution),
        chip,
        televisionFlag: Object.entries(d).some(([k, v]) => /television/i.test(k) && yes(v)),
        raw: d,
      });
    }
  }
  return out;
}

async function listMac(run) {
  const res = await run('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 30000 });
  if (!res.ok) return [];
  const screens = parseSystemProfiler(res.stdout);
  const model = await run('sysctl', ['-n', 'hw.model']);
  const hwModel = model.ok ? model.stdout.trim() || null : null;
  return screens.map((s) => ({ ...s, hwModel }));
}

// ---------------------------------------------------------------- Linux

async function readText(file) {
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
}

/** "card0-HDMI-A-1" -> "HDMI"; "card1-eDP-1" -> "eDP"; "card0-DVI-D-1" -> "DVI" */
function connectorKind(name) {
  const t = String(name).replace(/^card\d+-/, '').replace(/[-_]?\d+(-\d+)*$/, '');
  if (/^HDMI/i.test(t)) return 'HDMI';
  if (/^eDP/i.test(t)) return 'eDP';
  if (/^(DP|DisplayPort)/i.test(t)) return 'DP';
  if (/^DVI/i.test(t)) return 'DVI';
  return t;
}

/**
 * Parse `xrandr --query`: each output, its current mode and the rates it
 * offers.
 * @param {string} text
 */
function parseXrandr(text) {
  const outputs = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    const head = line.match(/^(\S+) (connected|disconnected)( primary)?(?: (\d+)x(\d+)\+\d+\+\d+)?/);
    if (head) {
      cur = { name: head[1], connected: head[2] === 'connected', primary: Boolean(head[3]), current: null, modes: [] };
      if (head[4]) cur.current = { width: Number(head[4]), height: Number(head[5]), refresh: null };
      outputs.push(cur);
      continue;
    }
    const mode = cur && line.match(/^\s+(\d+)x(\d+)(i?)\S*\s+(.*)$/);
    if (!mode) continue;
    const m = { width: Number(mode[1]), height: Number(mode[2]), interlaced: mode[3] === 'i', rates: [], current: false, preferred: false };
    let last = null;
    for (const tok of mode[4].trim().split(/\s+/)) {
      const r = tok.match(/^(\d+(?:\.\d+)?)(\*?)(\+?)$/);
      if (r) {
        last = Number(r[1]);
        m.rates.push(last);
        if (r[2]) {
          m.current = true;
          m.currentRate = last;
        }
        if (r[3]) m.preferred = true;
      } else if (last != null && /^[*+]+$/.test(tok)) {
        if (tok.includes('*')) {
          m.current = true;
          m.currentRate = last;
        }
        if (tok.includes('+')) m.preferred = true;
      }
    }
    cur.modes.push(m);
    if (m.current) cur.current = { width: m.width, height: m.height, refresh: m.currentRate };
  }
  return outputs;
}

/**
 * Read connected screens from /sys/class/drm/card*-* (status, enabled,
 * modes, edid), then add the current mode from xrandr when it can be matched.
 * @param {{ drmRoot?: string, run: Function }} ctx
 */
async function listLinux(ctx) {
  const root = ctx.drmRoot ?? DEFAULT_DRM;
  let names;
  try {
    names = (await fs.readdir(root)).filter((n) => /^card\d+-./.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  } catch {
    return [];
  }
  const screens = [];
  for (const connector of names) {
    const dir = path.join(root, connector);
    if ((await readText(path.join(dir, 'status'))) !== 'connected') continue;
    const enabled = await readText(path.join(dir, 'enabled'));
    const modes = ((await readText(path.join(dir, 'modes'))) ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    let edidBytes = null;
    try {
      edidBytes = await fs.readFile(path.join(dir, 'edid'));
    } catch {
      edidBytes = null;
    }
    const edid = edidBytes && edidBytes.length ? parseEdid(edidBytes) : null;
    const kind = connectorKind(connector);
    const builtIn = /^(eDP|LVDS|DSI)$/i.test(kind);
    const native = edid?.preferred ? { width: edid.preferred.width, height: edid.preferred.height, refresh: edid.preferred.refresh } : parseSize(modes[0]);
    screens.push({
      connector,
      kind,
      name: edid?.name ?? null,
      pnp: edid?.manufacturer ?? null,
      productHex: edid ? edid.productCode.toString(16).padStart(4, '0') : null,
      serial: edid?.serialString ?? (edid?.serialNumber ? edid.serialNumber.toString(16) : null),
      year: edid?.year ?? null,
      builtIn,
      online: true,
      enabled: enabled == null ? null : enabled === 'enabled',
      connection: builtIn ? 'Built-in' : { HDMI: 'HDMI', DP: 'DisplayPort', DVI: 'DVI', VGA: 'VGA' }[kind] ?? null,
      current: null,
      native,
      modes: modes.slice(0, 20),
      edid,
      raw: { connector, status: 'connected', enabled, modes: modes.slice(0, 20), edid: edidBytes?.length ? edidBytes.toString('hex') : null },
    });
  }

  // xrandr is X11 only and may be missing; without it there is no current mode.
  const xr = await ctx.run('xrandr', ['--query']);
  if (xr.ok) {
    const outputs = parseXrandr(xr.stdout).filter((o) => o.connected);
    const byKind = (list, kindOf) => list.reduce((m, x) => m.set(kindOf(x), [...(m.get(kindOf(x)) ?? []), x]), new Map());
    const drm = byKind(screens, (s) => s.kind);
    const xo = byKind(outputs, (o) => connectorKind(o.name));
    for (const [kind, list] of drm) {
      const matches = xo.get(kind) ?? [];
      // Names differ between drivers (HDMI-A-1 vs HDMI-1 vs HDMI-A-0); pair
      // by kind and order only when the counts agree.
      if (matches.length !== list.length) continue;
      list.forEach((s, i) => {
        const o = matches[i];
        s.output = o.name;
        s.primary = o.primary;
        if (o.current) {
          s.current = o.current;
          const mode = o.modes.find((m) => m.current) ?? o.modes.find((m) => m.width === o.current.width && m.height === o.current.height);
          s.availableRates = mode ? [...new Set(mode.rates)].sort((a, b) => b - a) : [];
        }
        s.raw.xrandr = o;
      });
    }
  }
  return screens;
}

// ---------------------------------------------------------------- Windows

/**
 * PowerShell that dumps monitors (WMI root\wmi) and video controllers as
 * JSON. The monitor ID strings come back as UInt16 arrays, decoded in JS.
 */
const WINDOWS_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$ids = @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID | Select-Object InstanceName, Active, ManufacturerName, ProductCodeID, SerialNumberID, UserFriendlyName, WeekOfManufacture, YearOfManufacture)',
  '$conn = @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorConnectionParams | Select-Object InstanceName, VideoOutputTechnology)',
  '$pref = @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorListedSupportedSourceModes | ForEach-Object {',
  '  try { $m = $_.MonitorSourceModes[$_.PreferredMonitorSourceModeIndex]; [pscustomobject]@{ InstanceName = $_.InstanceName; Width = $m.HorizontalActivePixels; Height = $m.VerticalActivePixels } } catch {}',
  '})',
  '$gpus = @(Get-CimInstance Win32_VideoController | Select-Object Name, VideoProcessor, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate, PNPDeviceID)',
  '[pscustomobject]@{ Monitors = $ids; Connections = $conn; Preferred = $pref; Controllers = $gpus } | ConvertTo-Json -Depth 4 -Compress',
].join('\n');

/** WMI monitor strings are UInt16 arrays padded with zeros. */
function wmiString(v) {
  if (typeof v === 'string') return v.replace(/\0/g, '').trim() || null;
  const chars = asArray(v).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 0x10000);
  const s = String.fromCharCode(...chars).trim();
  return s || null;
}

/** D3DKMDT_VIDEO_OUTPUT_TECHNOLOGY, as WmiMonitorConnectionParams reports it. */
const VIDEO_OUTPUT = {
  0: 'VGA', 1: 'S-Video', 2: 'Composite', 3: 'Component', 4: 'DVI', 5: 'HDMI', 6: 'Built-in', 8: 'D-Terminal', 9: 'SDI',
  10: 'DisplayPort', 11: 'Built-in', 12: 'UDI', 13: 'Built-in', 14: 'SDTV dongle', 15: 'Miracast (wireless)', 16: 'Indirect (USB or virtual)',
};

function videoOutput(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // D3DKMDT_VOT_INTERNAL is 0x80000000; signed or unsigned depending on the shell.
  if (n === 0x80000000 || n === -0x80000000) return 'Built-in';
  return VIDEO_OUTPUT[n] ?? null;
}

/**
 * Normalize the JSON produced by WINDOWS_SCRIPT.
 * @param {string} jsonText
 */
function parseWindows(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText || '{}');
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const conns = new Map(asArray(data.Connections).filter((c) => c?.InstanceName).map((c) => [c.InstanceName, c]));
  const prefs = new Map(asArray(data.Preferred).filter((p) => p?.InstanceName).map((p) => [p.InstanceName, p]));
  const gpus = asArray(data.Controllers).filter((g) => g && typeof g === 'object');
  const monitors = asArray(data.Monitors).filter((m) => m && typeof m === 'object' && m.Active !== false);
  const withMode = gpus.filter((g) => Number(g.CurrentHorizontalResolution) > 0);
  const chip = gpus.map((g) => str(g.Name)).filter(Boolean).join(', ') || null;

  return monitors.map((m) => {
    const instance = str(m.InstanceName) ?? '';
    const ids = instance.match(/^DISPLAY\\([A-Z@]{3})([0-9A-F]{4})\\/i);
    const pnp = wmiString(m.ManufacturerName) ?? (ids ? ids[1].toUpperCase() : null);
    const conn = videoOutput(conns.get(instance)?.VideoOutputTechnology);
    const pref = prefs.get(instance);
    const serial = wmiString(m.SerialNumberID);
    // Win32_VideoController has one mode per graphics chip, not per screen,
    // so it only describes a screen when there is exactly one of each.
    const g = monitors.length === 1 && withMode.length === 1 ? withMode[0] : null;
    return {
      instance,
      name: wmiString(m.UserFriendlyName),
      pnp: pnp && /^[A-Z@]{3}$/i.test(pnp) ? pnp.toUpperCase() : null,
      productHex: (wmiString(m.ProductCodeID) ?? (ids ? ids[2] : '')).toLowerCase() || null,
      serial: serial && serial !== '0' ? serial : null,
      year: Number(m.YearOfManufacture) || null,
      builtIn: conn === 'Built-in',
      online: true,
      connection: conn,
      current: g ? { width: Number(g.CurrentHorizontalResolution), height: Number(g.CurrentVerticalResolution), refresh: Number(g.CurrentRefreshRate) || null } : null,
      native: Number(pref?.Width) > 0 && Number(pref?.Height) > 0 ? { width: Number(pref.Width), height: Number(pref.Height) } : null,
      chip,
      raw: { monitor: m, connection: conns.get(instance) ?? null, preferred: pref ?? null, controllers: gpus },
    };
  });
}

async function listWindows(run) {
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], { timeout: 30000 });
  if (!res.ok) return [];
  return parseWindows(res.stdout);
}

// ---------------------------------------------------------------- shared

/**
 * Turn per-OS screen records into devices.
 * @param {any[]} screens
 * @param {NodeJS.Platform} platform
 */
function toDevices(screens, platform) {
  const externalCount = screens.filter((s) => !s.builtIn && s.online !== false).length;
  const seen = new Map();
  return screens.map((s) => {
    const vendorName = (s.pnp && PNP_VENDORS[s.pnp]) ?? null;
    const name = s.name ?? null;
    let key = s.pnp && s.productHex ? [s.pnp, s.productHex.toUpperCase(), s.serial].filter(Boolean).join('-') : (s.connector ?? s.instance ?? name ?? 'screen');
    key = String(key).replace(/[^A-Za-z0-9._-]+/g, '_');
    // Two identical monitors without serial numbers still need distinct IDs.
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) key = `${key}-${n}`;
    const tv = guessTv({ name, vendorName, edid: s.edid, builtIn: s.builtIn, televisionFlag: s.televisionFlag });
    const productName = name ?? (s.builtIn ? 'Built-in screen' : 'Screen');
    const displayName = s.builtIn
      ? 'Built-in screen'
      : tv.isTV && vendorName && productName.toLowerCase() === vendorName.toLowerCase()
        ? `${vendorName} TV`
        : vendorName && !productName.toLowerCase().startsWith(vendorName.toLowerCase().split(' ')[0])
        ? `${vendorName} ${productName}`
        : productName;
    const categories = tv.isTV ? ['display', 'tv'] : ['display'];
    return {
      id: `display:${key}`,
      source: 'display',
      platform,
      vendorName,
      productName,
      displayName,
      serial: s.serial ?? null,
      categories,
      icon: tv.isTV ? 'tv' : 'display',
      interfaces: [],
      nodes: [],
      driver: { bound: null, names: [], unboundInterfaces: [] },
      problem: null,
      details: {
        connection: s.connection ?? null,
        builtIn: Boolean(s.builtIn),
        enabled: s.enabled ?? null,
        current: s.current ?? null,
        looksLike: s.looksLike ?? null,
        native: s.native ?? null,
        isTV: tv.isTV,
        tvReason: tv.reason,
        main: s.main ?? s.primary ?? null,
        mirror: s.mirror ?? null,
        chip: s.chip ?? null,
        hwModel: s.hwModel ?? null,
        externalCount,
        output: s.output ?? null,
        connector: s.connector ?? null,
        availableRates: s.availableRates ?? null,
        manufacturerId: s.pnp ?? null,
        year: s.year ?? null,
        edid: s.edid
          ? {
              name: s.edid.name,
              manufacturer: s.edid.manufacturer,
              hdmi: s.edid.hdmi,
              hdmiForum: s.edid.cta?.hdmiForum ?? false,
              maxTmdsMhz: s.edid.cta?.maxTmdsMhz ?? null,
              hdr: s.edid.cta?.hdr ?? null,
              tvLike: s.edid.tvLike,
              sizeCm: s.edid.sizeCm,
              checksumOk: s.edid.checksumOk,
            }
          : null,
      },
      raw: s.raw ?? {},
    };
  });
}

/**
 * @param {{ platform?: NodeJS.Platform, run?: Function, drmRoot?: string }} [ctx]
 */
async function list(ctx = {}) {
  const platform = ctx.platform ?? process.platform;
  const run = ctx.run ?? defaultRun;
  let screens = [];
  if (platform === 'darwin') screens = await listMac(run);
  else if (platform === 'linux') screens = await listLinux({ ...ctx, run });
  else if (platform === 'win32') screens = await listWindows(run);
  return toDevices(screens, platform);
}

/** @type {import('./index').Source} */
const source = { id: 'display', label: 'Screens', intervalMs: 5000, list };

module.exports = {
  source,
  list,
  parseSystemProfiler,
  parseXrandr,
  parseWindows,
  listLinux,
  toDevices,
  guessTv,
  wmiString,
  connectionName,
  WINDOWS_SCRIPT,
  PNP_VENDORS,
};
