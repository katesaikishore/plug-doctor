'use strict';

/**
 * Every USB printer answers GET_DEVICE_ID with an IEEE 1284 device ID:
 *
 *   MFG:Hewlett-Packard;MDL:HP LaserJet 1020;CMD:ACL;CLS:PRINTER;DES:HP LaserJet 1020;
 *
 * CMD (the "command set") is the single most useful fact for making an
 * unsupported printer work: it says which page description language the
 * printer understands, which tells us which generic driver can drive it.
 */

const KEY_ALIASES = {
  MANUFACTURER: 'MFG',
  MODEL: 'MDL',
  'COMMAND SET': 'CMD',
  COMMANDSET: 'CMD',
  CLASS: 'CLS',
  DESCRIPTION: 'DES',
  'SERIAL NUMBER': 'SN',
  SERN: 'SN',
};

/** Normalized command-set families. */
const LANGUAGE_FAMILIES = [
  { family: 'postscript', match: /^(POSTSCRIPT|PS|PS2|PS3|BR-SCRIPT\d*|KPDL)$/ },
  { family: 'pclxl', match: /^(PCLXL|PCL6|PCL 6|PCL-XL|PXL)$/ },
  // PJL is a job-control wrapper, not a page language, so it is deliberately absent.
  { family: 'pcl', match: /^(PCL|PCL3|PCL3GUI|PCL5|PCL5E|PCL5C|PCL4)$/ },
  { family: 'driverless', match: /^(URF|PWG|PWGRASTER|PWG-RASTER|IPP|APPLE-RASTER)$/ },
  { family: 'escp', match: /^(ESC\/?P.*|ESCPL2|ESCPAGE.*|ESCPR.*)$/ },
  // Host-based ("GDI", "winprinter") languages: the computer does all the
  // rasterizing and the printer only accepts a proprietary stream.
  { family: 'hostbased', match: /^(ACL|ZJS|ZJSTREAM|GDI|LIDIL|CAPT|SPL|QPDL|LAVAFLOW|OPL|XQX|HIPERC|SPLC|LIPS.*|CPCA|UFR.*)$/ },
  { family: 'label', match: /^(ZPL.*|EPL.*|DPL|TSPL.*|ESC\/POS|ESCPOS|STAR.*)$/ },
];

/**
 * @param {string} raw
 * @returns {{ manufacturer: string|null, model: string|null, commandSet: string[], languages: string[], class: string|null, description: string|null, serial: string|null, fields: Record<string,string> }}
 */
function parseDeviceId(raw) {
  const fields = {};
  for (const part of String(raw ?? '').split(';')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    let key = part.slice(0, idx).trim().toUpperCase();
    key = KEY_ALIASES[key] ?? key;
    const value = part.slice(idx + 1).trim();
    if (value && !(key in fields)) fields[key] = value;
  }
  const commandSet = (fields.CMD ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    manufacturer: fields.MFG ?? null,
    model: fields.MDL ?? null,
    commandSet,
    languages: languagesOf(commandSet),
    class: fields.CLS ?? null,
    description: fields.DES ?? null,
    serial: fields.SN ?? null,
    fields,
  };
}

/** Map a raw CMD list to normalized families, most capable first. */
function languagesOf(commandSet) {
  const found = new Set();
  for (const cmd of commandSet) {
    const upper = cmd.toUpperCase();
    for (const { family, match } of LANGUAGE_FAMILIES) {
      if (match.test(upper)) found.add(family);
    }
  }
  const order = ['driverless', 'postscript', 'pclxl', 'pcl', 'escp', 'label', 'hostbased'];
  return order.filter((f) => found.has(f));
}

module.exports = { parseDeviceId, languagesOf };
