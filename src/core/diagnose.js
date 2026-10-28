'use strict';

const { run: defaultRun } = require('./exec');
const kb = require('./kb');
const { detectManager } = require('./fix/packages');
const { className } = require('./usb/classes');
const { supportFor, verdict } = require('./support');
const { familyFor } = require('./families');
const { check } = require('./families/helpers');

/** Checks that apply to every device, whatever it is. */
function genericChecks(device, family, platform) {
  const checks = [];
  if (device.problem) checks.push(check('os-problem', 'Operating system reports no errors', 'fail', device.problem.message));
  if (!device.driver) return checks;
  if (device.driver.bound === true) {
    checks.push(check('driver-bound', 'A driver is attached', 'pass', device.driver.names.join(', ')));
  } else if (device.driver.bound === false) {
    // Smart-card readers (class 0b) are driven by a normal service, not a kernel driver.
    const smartCard = device.interfaces?.some((i) => i.class === '0b');
    if (smartCard || family.userspace?.(platform, device)) {
      checks.push(check('driver-bound', 'Driver', 'info', 'Handled by software that runs as a normal app; no kernel driver is needed.'));
    } else {
      checks.push(check('driver-bound', 'A driver is attached', 'fail', 'No driver has claimed any part of this device.'));
    }
  }
  return checks;
}

/**
 * Diagnose one device and propose fixes.
 * @param {any} device  normalized device from a source (usb, display, bluetooth, network)
 * @param {{ platform?: NodeJS.Platform, arch?: string, run?: Function, kbDir?: string, manager?: any }} [ctxIn]
 */
async function diagnose(device, ctxIn = {}) {
  const platform = ctxIn.platform ?? process.platform;
  const arch = ctxIn.arch ?? process.arch;
  const run = ctxIn.run ?? defaultRun;
  const ctx = { ...ctxIn, platform, arch, run };
  ctx.manager = ctxIn.manager !== undefined ? ctxIn.manager : await detectManager(platform, run);
  const family = familyFor(device, ctx);
  ctx.recipes = kb.findForDevice(device, {}, ctxIn.kbDir).filter((r) => !r.category || r.category === family.id);

  const base = genericChecks(device, family, platform);
  ctx.baseChecks = base;
  let result;
  try {
    result = await family.diagnose(device, ctx);
  } catch (err) {
    base.push(check('internal', 'Plug Doctor ran its checks', 'warn', `A check crashed: ${err.message}`));
    const { family: generic } = require('./families/generic');
    result = await generic.diagnose(device, ctx);
  }

  // Families may return a level string or { level, note }.
  const own = typeof result.support === 'string' ? { level: result.support } : result.support;
  const support = own?.level
    ? verdict(own.level, { platform, arch }, own.note ?? null)
    : supportFor(device, { platform, arch, recipes: ctx.recipes });

  return {
    deviceId: device.id,
    source: device.source ?? 'usb',
    title: device.displayName ?? [device.vendorName, device.productName].filter(Boolean).join(' '),
    category: family.id,
    categoryLabel: family.label,
    icon: family.icon,
    status: result.status,
    headline: result.headline,
    support,
    checks: [...base, ...result.checks],
    plans: [...result.plans].sort((a, b) => b.confidence - a.confidence),
    facts: {
      ...(device.vendorId ? { usbId: `${device.vendorId}:${device.productId}` } : {}),
      ...(device.interfaces?.length ? { classes: [...new Set(device.interfaces.map((i) => className(i.class)))] } : {}),
      ...result.facts,
    },
    recipes: ctx.recipes.map((r) => ({ id: r.id, name: r.name, summary: r.summary, notes: r.platforms?.[platform]?.notes ?? null, sources: r.sources ?? [] })),
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { diagnose };
