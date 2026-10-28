'use strict';

const { run: defaultRun } = require('../exec');
const kb = require('../kb');
const { detectManager } = require('../fix/packages');
const { className } = require('../usb/classes');
const { check } = require('./helpers');
const { diagnosePrinter } = require('./printer');
const { diagnoseSerial, SERIAL_CHIP_VENDORS } = require('./serial');
const { diagnoseStorage } = require('./storage');

/** The category we diagnose a device as; a printer that is also a scanner is a printer first. */
function primaryCategory(device) {
  const order = ['printer', 'storage', 'serial', 'camera', 'audio', 'input', 'wireless', 'network', 'smartcard'];
  const cats = new Set(device.categories);
  if (SERIAL_CHIP_VENDORS.has(device.vendorId) && !cats.has('printer')) cats.add('serial');
  return order.find((c) => cats.has(c)) ?? 'unknown';
}

/** Checks that apply to every device, whatever it is. */
function genericChecks(device) {
  const checks = [];
  if (device.problem) checks.push(check('os-problem', 'Operating system reports no errors', 'fail', device.problem.message));
  if (device.driver.bound === true) checks.push(check('driver-bound', 'A driver is attached', 'pass', device.driver.names.join(', ')));
  else if (device.driver.bound === false) checks.push(check('driver-bound', 'A driver is attached', 'fail', 'No driver has claimed any part of this device.'));
  return checks;
}

function genericVerdict(device, checks) {
  if (checks.some((c) => c.status === 'fail')) {
    const vendorSpecific = device.interfaces.every((i) => i.class === 'ff') && device.interfaces.length > 0;
    return {
      status: 'broken',
      headline: vendorSpecific
        ? 'This device speaks a private protocol and no driver on this computer knows it. The "Under the hood" tab has what you need to find or build one.'
        : 'No driver has claimed this device.',
    };
  }
  if (device.driver.bound === null && !device.problem) return { status: 'unknown', headline: 'Connected. Plug Doctor has no specific checks for this kind of device yet.' };
  return { status: 'ok', headline: 'Connected and working.' };
}

/**
 * Diagnose one device and propose fixes.
 * @param {any} device  normalized device from usb/index.js
 * @param {{ platform?: NodeJS.Platform, run?: Function, kbDir?: string }} [ctxIn]
 */
async function diagnose(device, ctxIn = {}) {
  const platform = ctxIn.platform ?? process.platform;
  const run = ctxIn.run ?? defaultRun;
  const ctx = { ...ctxIn, platform, run };
  ctx.manager = ctxIn.manager !== undefined ? ctxIn.manager : await detectManager(platform, run);
  const category = primaryCategory(device);
  ctx.recipes = kb.findForDevice(device, {}, ctxIn.kbDir).filter((r) => !r.category || r.category === category);

  const base = genericChecks(device);
  let result;
  try {
    if (category === 'printer') result = await diagnosePrinter(device, ctx);
    else if (category === 'serial') result = await diagnoseSerial(device, ctx);
    else if (category === 'storage') result = await diagnoseStorage(device, ctx);
  } catch (err) {
    base.push(check('internal', 'Plug Doctor ran its checks', 'warn', `A check crashed: ${err.message}`));
  }
  if (!result) result = { ...genericVerdict(device, base), checks: [], plans: [], facts: {} };

  return {
    deviceId: device.id,
    title: device.displayName ?? [device.vendorName, device.productName].filter(Boolean).join(' '),
    category,
    status: result.status,
    headline: result.headline,
    checks: [...base, ...result.checks],
    plans: result.plans.sort((a, b) => b.confidence - a.confidence),
    facts: {
      usbId: `${device.vendorId}:${device.productId}`,
      classes: [...new Set(device.interfaces.map((i) => className(i.class)))],
      ...result.facts,
    },
    recipes: ctx.recipes.map((r) => ({ id: r.id, name: r.name, summary: r.summary, notes: r.platforms?.[platform]?.notes ?? null, sources: r.sources ?? [] })),
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { diagnose, primaryCategory };
