'use strict';

/**
 * Parsers for the CUPS command-line tools. CUPS is the print system on both
 * macOS and Linux, so one set of parsers covers both.
 */

/**
 * `lpinfo --include-schemes usb -l -v`
 *
 *   Device: uri = usb://HP/LaserJet%201020?serial=FN16VR6
 *           class = direct
 *           info = HP LaserJet 1020
 *           make-and-model = HP LaserJet 1020
 *           device-id = MFG:Hewlett-Packard;MDL:HP LaserJet 1020;CMD:ACL;
 *           location =
 */
function parseLpinfoDevices(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const start = line.match(/^Device:\s*uri\s*=\s*(.+)$/);
    if (start) {
      cur = { uri: start[1].trim() };
      out.push(cur);
      continue;
    }
    const kv = line.match(/^\s+([\w-]+)\s*=\s*(.*)$/);
    if (cur && kv) cur[kv[1].replace(/-(\w)/g, (_, c) => c.toUpperCase())] = kv[2].trim();
  }
  return out;
}

/** `lpstat -v`  ->  [{ queue, uri }] */
function parseLpstatDevices(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^device for (.+?):\s*(\S+)/);
    if (m) out.push({ queue: m[1], uri: m[2] });
  }
  return out;
}

/** `lpstat -p`  ->  [{ queue, state: 'idle'|'printing'|'disabled', detail }] */
function parseLpstatPrinters(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^printer (\S+) (?:is )?(idle|now printing|disabled)/);
    if (m) out.push({ queue: m[1], state: m[2] === 'now printing' ? 'printing' : m[2], detail: line.trim() });
  }
  return out;
}

/** `lpinfo -m`  ->  [{ name, makeAndModel }] */
function parseLpinfoModels(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (m) out.push({ name: m[1], makeAndModel: m[2].trim() });
  }
  return out;
}

/** Compare two USB URIs ignoring percent-encoding differences and extra params. */
function sameUsbPrinter(a, b) {
  const norm = (u) => {
    try {
      const url = new URL(u);
      return `${decodeURIComponent(url.host)}${decodeURIComponent(url.pathname)}|${url.searchParams.get('serial') ?? ''}`.toLowerCase();
    } catch {
      return String(u).toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

/** A CUPS-safe queue name: letters, digits, underscore and dash, max 127. */
function queueNameFor(makeModel) {
  const name = String(makeModel || 'USB_Printer')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
  return name || 'USB_Printer';
}

module.exports = {
  parseLpinfoDevices,
  parseLpstatDevices,
  parseLpstatPrinters,
  parseLpinfoModels,
  sameUsbPrinter,
  queueNameFor,
};
