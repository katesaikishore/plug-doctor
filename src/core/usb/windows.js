'use strict';

const { hex2 } = require('./classes');

/**
 * PowerShell that dumps present Plug and Play devices whose instance ID is
 * USB-ish, as JSON. Problem codes are the CM_PROB_* values Device Manager
 * shows ("This device cannot start. (Code 10)").
 */
const PNP_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Get-PnpDevice -PresentOnly |',
  ' Where-Object { $_.InstanceId -match "^(USB|USBPRINT|USBSTOR)\\\\" } |',
  ' Select-Object InstanceId, FriendlyName, Class, Status, Manufacturer, Service,',
  '  @{n="Problem";e={[int]$_.ConfigManagerErrorCode}}, CompatibleID |',
  ' ConvertTo-Json -Depth 3 -Compress',
].join('\n');

/** CM_PROB codes worth explaining to a person. */
const PROBLEM_CODES = {
  1: 'The device is not configured correctly (Code 1).',
  3: 'The driver may be corrupted or the system is low on memory (Code 3).',
  10: 'The device cannot start (Code 10).',
  18: 'The drivers need to be reinstalled (Code 18).',
  22: 'The device is disabled (Code 22).',
  24: 'The device is not present or not working properly (Code 24).',
  28: 'No driver is installed for this device (Code 28).',
  31: 'Windows cannot load the driver (Code 31).',
  37: 'The driver returned a failure (Code 37).',
  39: 'The driver is corrupted or missing (Code 39).',
  43: 'Windows stopped the device because it reported problems (Code 43).',
  45: 'The device is not connected (Code 45).',
  48: 'The driver was blocked because it has known issues (Code 48).',
  52: 'The driver is not digitally signed (Code 52).',
};

const ID_RE = /^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})(&MI_([0-9A-F]{2}))?\\(.*)$/i;
const CLASS_RE = /USB\\Class_([0-9A-F]{2})(&SubClass_([0-9A-F]{2}))?(&Prot_([0-9A-F]{2}))?/i;

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function classFromCompatible(ids) {
  for (const id of asArray(ids)) {
    const m = String(id).match(CLASS_RE);
    if (m) return { class: hex2(m[1]), subclass: hex2(m[3]), protocol: hex2(m[5]) };
  }
  return null;
}

/**
 * Normalize the JSON produced by PNP_SCRIPT. Composite devices show up as a
 * parent (`USB\VID_x&PID_y\serial`) plus one entry per interface (`&MI_nn`);
 * the interfaces are folded into their parent.
 * @param {string} jsonText
 */
function devicesFromPnp(jsonText) {
  let rows;
  try {
    rows = asArray(JSON.parse(jsonText || '[]'));
  } catch {
    return [];
  }

  const parents = new Map();
  const children = [];
  const functions = [];
  for (const row of rows) {
    const id = String(row.InstanceId ?? '');
    const m = id.match(ID_RE);
    if (!m) {
      functions.push(row); // USBPRINT\..., USBSTOR\...
      continue;
    }
    const key = `${m[1]}:${m[2]}`.toLowerCase();
    if (m[3]) children.push({ key, mi: m[4], row });
    else parents.set(id, { key, serial: m[5], row });
  }

  const out = [];
  for (const [instanceId, { key, serial, row }] of parents) {
    const [vendorId, productId] = key.split(':');
    const own = classFromCompatible(row.CompatibleID);
    const kids = children.filter((c) => c.key === key);
    const interfaces = kids.map((c) => ({
      number: c.mi,
      ...(classFromCompatible(c.row.CompatibleID) ?? { class: null, subclass: null, protocol: null }),
      name: c.row.FriendlyName ?? null,
      windowsClass: c.row.Class ?? null,
      driver: c.row.Service || null,
      status: c.row.Status,
      problem: c.row.Problem || 0,
      nodes: [],
    }));
    if (interfaces.length === 0 && own) {
      interfaces.push({ number: '00', ...own, driver: row.Service || null, status: row.Status, problem: row.Problem || 0, nodes: [] });
    }
    const worst = [row, ...kids.map((k) => k.row)].find((r) => r.Problem && r.Problem !== 0);
    const problemCode = worst ? Number(worst.Problem) : 0;
    out.push({
      id: null,
      vendorId,
      productId,
      vendorName: row.Manufacturer && !/^\(Standard/.test(row.Manufacturer) ? row.Manufacturer : null,
      productName: row.FriendlyName ?? null,
      // Windows makes up "6&1a2b3c&0&2"-style IDs when there is no serial.
      serial: serial && !serial.includes('&') ? serial : null,
      deviceClass: own && interfaces.length === 0 ? own.class : '00',
      location: null,
      interfaces,
      nodes: [],
      windowsClass: row.Class ?? null,
      driver: {
        bound: problemCode === 0 && row.Status === 'OK',
        names: [...new Set([row.Service, ...kids.map((k) => k.row.Service)].filter(Boolean))],
        unboundInterfaces: interfaces.filter((i) => !i.driver).map((i) => i.number),
      },
      problem: problemCode ? { code: problemCode, message: PROBLEM_CODES[problemCode] ?? `Device Manager reports problem code ${problemCode}.` } : null,
      raw: {
        pnp: row,
        // USBPRINT\ and USBSTOR\ function devices carry the parent's serial in their ID.
        functions: serial ? functions.filter((f) => String(f.InstanceId).toLowerCase().includes(serial.toLowerCase())) : [],
      },
    });
  }
  return out;
}

async function listDevices({ run }) {
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PNP_SCRIPT], { timeout: 30000 });
  if (!res.ok) return [];
  // Hubs and host controllers are plumbing, not things people plug in.
  return devicesFromPnp(res.stdout).filter((d) => d.problem || !/\bhub\b|host controller/i.test(d.productName ?? ''));
}

module.exports = { PNP_SCRIPT, PROBLEM_CODES, devicesFromPnp, listDevices };
