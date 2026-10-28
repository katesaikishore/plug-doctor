'use strict';

/**
 * The first question for any device: can this computer use it at all, and
 * how? One of:
 *
 *   native         the operating system's own drivers handle it
 *   app            works through software that runs as a normal app (the
 *                  print system, a file-transfer app, a scanner backend);
 *                  no driver install
 *   vendor-driver  needs a driver from the maker
 *   unsupported    cannot work on this computer (for example no driver for
 *                  Macs with Apple silicon); say so and suggest alternatives
 *   unknown        not enough information yet
 *
 * On Macs with Apple silicon, third-party kernel extensions only load after
 * lowering the Mac's security, which Plug Doctor never recommends. That one
 * rule is why "app" matters so much on the Mac.
 */

const OS_NAME = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** USB classes every desktop OS drives with built-in drivers. */
const NATIVE_CLASSES = new Set(['01', '02', '03', '08', '09', '0a', '0b', '0e', '10', '11']);
/** Classes that carry no meaning for support (diagnostic, app-specific, misc). */
const NEUTRAL_CLASSES = new Set(['dc', 'fe', 'ef', '00']);

function label(level, platform, arch) {
  const os = OS_NAME[platform] ?? platform;
  const mac = platform === 'darwin' ? (arch === 'arm64' ? 'this Mac (Apple silicon)' : 'this Mac') : `this ${os} computer`;
  return {
    native: `Works with ${os}'s built-in drivers`,
    app: 'Works through an app, no driver to install',
    'vendor-driver': "Needs a driver from the device's maker",
    unsupported: `Cannot work on ${mac}`,
    unknown: 'Support not known yet',
  }[level];
}

/**
 * @param {any} device
 * @param {{ platform: NodeJS.Platform, arch?: string, recipes?: any[] }} ctx
 * @returns {{ level: string, label: string, note: string|null }}
 */
function supportFor(device, { platform, arch = process.arch, recipes = [] }) {
  const out = (level, note = null) => ({ level, label: label(level, platform, arch), note });

  for (const r of recipes) {
    const level = r.support?.[`${platform}-${arch}`] ?? r.support?.[platform];
    if (level) return out(level, r.supportNote?.[platform] ?? null);
  }

  if (device.source && device.source !== 'usb') return out('native');

  const classes = new Set([device.deviceClass, ...device.interfaces.map((i) => i.class)].filter((c) => c && !NEUTRAL_CLASSES.has(c)));
  if (classes.size === 0) return device.driver?.bound ? out('native') : out('unknown');

  if (classes.has('07')) return out('app', 'Printers are driven by the print system. Plug Doctor picks the driver.');
  if (classes.has('06')) return platform === 'linux' ? out('app') : out('native');
  // A USB Bluetooth adapter that macOS has already bound is working, so only unbound ones are refused.
  if (classes.has('e0') && platform === 'darwin' && !device.driver?.bound) {
    return out('unsupported', 'macOS only uses its built-in Bluetooth. USB Bluetooth adapters are not supported.');
  }
  if ([...classes].every((c) => NATIVE_CLASSES.has(c))) return out('native');
  // Something already drives the vendor-specific part.
  if (device.driver?.bound) return out('native');
  if (classes.has('ff')) return out('vendor-driver', 'The device uses its own protocol, so it needs software that knows it.');
  return out('unknown');
}

/** A verdict a family decided itself, with the standard wording. */
function verdict(level, { platform, arch = process.arch }, note = null) {
  return { level, label: label(level, platform, arch), note };
}

module.exports = { supportFor, verdict, NATIVE_CLASSES };
