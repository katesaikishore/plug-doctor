'use strict';

/**
 * Fallback for devices no family claims. The generic driver checks in
 * diagnose.js already ran; this turns them into a verdict.
 */

async function diagnoseGeneric(device, ctx) {
  const failed = ctx.baseChecks.some((c) => c.status === 'fail');
  if (failed) {
    const vendorSpecific = device.interfaces.length > 0 && device.interfaces.every((i) => i.class === 'ff');
    return {
      status: 'broken',
      headline: vendorSpecific
        ? 'This device speaks a private protocol and no driver on this computer knows it. The "Under the hood" tab has what you need to find or build one.'
        : 'No driver has claimed this device.',
      checks: [],
      plans: [],
      facts: {},
    };
  }
  if (device.driver?.bound === null && !device.problem) {
    return { status: 'unknown', headline: 'Connected. Plug Doctor has no specific checks for this kind of device yet.', checks: [], plans: [], facts: {} };
  }
  return { status: 'ok', headline: 'Connected and working.', checks: [], plans: [], facts: {} };
}

/** @type {import('./index').Family} */
const family = {
  id: 'generic',
  label: 'Device',
  icon: 'unknown',
  sources: ['usb', 'display', 'bluetooth', 'network'],
  match: () => 1,
  diagnose: diagnoseGeneric,
};

module.exports = { family };
