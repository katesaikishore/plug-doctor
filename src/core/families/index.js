'use strict';

/**
 * Device families are plug-ins. Each one knows one kind of device: how to
 * recognize it, what to check and how to fix it. See docs/FAMILIES.md.
 *
 * @typedef {object} Family
 * @property {string} id          also the `category` that knowledge base recipes use
 * @property {string} label       human name ("Printer")
 * @property {string} icon        icon key in the renderer
 * @property {string[]} sources   device sources it handles: usb, display, bluetooth, network
 * @property {(device: any, ctx: any) => number} match   0 = not mine; highest score wins
 * @property {(platform: NodeJS.Platform, device: any) => boolean} [userspace]
 *           true when the device works without a kernel driver on this OS
 *           (CUPS printers, MTP phones), so "no driver attached" is normal
 * @property {(device: any, ctx: any) => Promise<FamilyResult>} diagnose
 *
 * @typedef {object} FamilyResult
 * @property {'ok'|'needs-fix'|'broken'|'unknown'|'idle'} status  idle = fine, just not connected now
 * @property {string} headline
 * @property {any[]} checks
 * @property {any[]} plans
 * @property {object} facts
 * @property {{ level: string, note?: string }} [support]  overrides the generic verdict
 */

const { family: printer } = require('./printer');
const { family: serial } = require('./serial');
const { family: storage } = require('./storage');
const { family: generic } = require('./generic');

/** Registered families. Order only breaks ties. */
const FAMILIES = [printer, storage, serial];

/** Add a family (used by the optional families below and by tests). */
function register(f) {
  if (!FAMILIES.some((x) => x.id === f.id)) FAMILIES.push(f);
}

// Families that live in their own files register themselves here.
for (const name of ['display', 'bluetooth', 'network-device', 'phone', 'camera', 'audio', 'input', 'network-adapter', 'scanner']) {
  try {
    register(require(`./${name}`).family);
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND' || !String(err.message).includes(`./${name}`)) throw err;
  }
}

/** The family that should handle this device. Never null: falls back to generic. */
function familyFor(device, ctx = {}) {
  let best = generic;
  let bestScore = 0;
  for (const f of FAMILIES) {
    if (f.sources && !f.sources.includes(device.source ?? 'usb')) continue;
    const score = f.match(device, ctx) || 0;
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

module.exports = { FAMILIES, familyFor, register, generic };
