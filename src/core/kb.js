'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The knowledge base is a folder of JSON "recipes", one per device or device
 * family, contributed by the community. See docs/ADDING_A_DEVICE.md.
 */
const DEFAULT_DIR = path.join(__dirname, '..', '..', 'knowledge', 'devices');

let cache = null;

function loadAll(dir = DEFAULT_DIR) {
  if (cache && cache.dir === dir) return cache.entries;
  const entries = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    files = [];
  }
  for (const file of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      entry.file = file;
      entries.push(entry);
    } catch (err) {
      // A broken community file must not take the app down.
      process.emitWarning(`knowledge/${file}: ${err.message}`);
    }
  }
  cache = { dir, entries };
  return entries;
}

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Find recipes for a device: by exact VID:PID first, then by the model name
 * the printer reports in its IEEE 1284 ID, then by vendor-wide entries.
 * @param {{ vendorId: string, productId: string, productName?: string|null }} device
 * @param {{ model?: string|null }} [extra]
 */
function findForDevice(device, extra = {}, dir) {
  const usbId = `${device.vendorId}:${device.productId}`.toLowerCase();
  const names = [device.productName, extra.model].filter(Boolean).map(norm);
  const hits = [];
  for (const entry of loadAll(dir)) {
    const m = entry.match ?? {};
    if ((m.usb ?? []).map((s) => s.toLowerCase()).includes(usbId)) {
      hits.push({ entry, score: 3 });
    } else if ((m.models ?? []).some((mm) => names.some((n) => n && (n === norm(mm) || n.endsWith(' ' + norm(mm)))))) {
      hits.push({ entry, score: 2 });
    } else if ((m.vendors ?? []).map((s) => s.toLowerCase()).includes(device.vendorId)) {
      hits.push({ entry, score: 1 });
    }
  }
  // A model-specific recipe supersedes vendor-wide advice.
  const top = Math.max(0, ...hits.map((h) => h.score));
  return hits.filter((h) => h.score === top).map((h) => h.entry);
}

/** Plain-text search used by the assistant. */
function search(query, dir) {
  const q = norm(query).split(' ').filter(Boolean);
  if (q.length === 0) return [];
  return loadAll(dir)
    .map((entry) => {
      const hay = norm(JSON.stringify(entry));
      return { entry, score: q.filter((t) => hay.includes(t)).length };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((h) => h.entry);
}

function reset() {
  cache = null;
}

module.exports = { loadAll, findForDevice, search, reset, DEFAULT_DIR };
