'use strict';

const kb = require('../kb');
const { installStep } = require('../fix/packages');
const { check, plan } = require('./helpers');

/**
 * Stand-alone USB scanners. Most present a vendor-specific interface, so
 * they are recognized by knowledge base recipes and product names. On Linux
 * SANE drives them from user space; on macOS Image Capture does, given a
 * driver from the maker or a scanner that supports driverless scanning.
 * All-in-one printers stay with the printer family.
 */

const SANE_PACKAGES = { apt: ['sane-utils'], dnf: ['sane-backends'], pacman: ['sane'] };
const AIRSCAN_PACKAGES = { apt: ['sane-airscan'], dnf: ['sane-airscan'], pacman: ['sane-airscan'] };

/** "CanoScan", "ScanSnap", "ScanJet", "Scanner", and Epson's Perfection / DS- / ES- lines. */
function looksLikeScanner(d) {
  const name = d.productName ?? '';
  if (/barcode|bar code|finger/i.test(name)) return false;
  // Barcode scanners pretend to be keyboards (HID) or serial ports (CDC).
  if ((d.interfaces ?? []).some((i) => i.class === '03' || i.class === '02')) return false;
  if (/scan/i.test(name)) return true;
  return d.vendorId === '04b8' && /\bperfection\b|\b(DS|ES)-\d/i.test(name);
}

function hasScannerRecipe(d) {
  try {
    return kb.findForDevice(d).some((r) => r.category === 'scanner');
  } catch {
    return false;
  }
}

function matchScanner(d) {
  if (hasScannerRecipe(d)) return 80;
  if (!looksLikeScanner(d)) return 0;
  // Beat the camera family (65) on still-image interfaces, never the printer family (90).
  return (d.interfaces ?? []).some((i) => i.class === '06') ? 70 : 55;
}

/** `scanimage -L` lines: device `pixma:04A91912_123456' is a CANON CanoScan LiDE 400 flatbed scanner */
function parseScanimageList(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^device [`'‘]([^'’]+)['’] is an? (.+)$/);
    if (m) out.push({ name: m[1], description: m[2].trim() });
  }
  return out;
}

/** Network and webcam backends are never this USB scanner. */
const NOT_USB = /^(airscan|escl|net|v4l|test):/;

/** Which `scanimage -L` entry is this device? */
function findSaneDevice(device, list) {
  const usb = list.filter((s) => !NOT_USB.test(s.name));
  const ids = `${device.vendorId}${device.productId}`.toUpperCase();
  const pad = (n) => String(n).padStart(3, '0');
  const port = device.busnum && device.devnum ? `libusb:${pad(device.busnum)}:${pad(device.devnum)}` : null;
  const byId = usb.find((s) => s.name.toUpperCase().includes(ids) || (port && s.name.includes(port)));
  if (byId) return byId;
  // A lone entry is ours only if it does not name another device (pixma:04A9176D_..., libusb:001:009).
  const others = usb.filter((s) => /[0-9A-F]{8}_|libusb:\d{3}:\d{3}/i.test(s.name));
  return usb.length === 1 && others.length === 0 ? usb[0] : null;
}

async function linuxScanner(device, ctx) {
  const checks = [];
  const plans = [];
  const facts = {};
  const recipe = ctx.recipes?.[0];

  const res = await ctx.run('scanimage', ['-L'], { timeout: 60000 });
  if (res.missing) {
    checks.push(check('sane', 'Scanning system (SANE) installed', 'fail', 'The SANE scanning tools are not installed.'));
    const step = installStep(recipe?.platforms?.linux?.packages ?? SANE_PACKAGES, ctx.manager);
    plans.push(
      plan({
        id: 'install-sane',
        title: 'Install the scanning system',
        why: 'Linux scans through SANE, which supports thousands of scanners. Plug Doctor will install it, then you can press "Check again".',
        confidence: recipe ? 0.9 : 0.8,
        auto: step.kind === 'command',
        steps: [step],
      }),
    );
    return { status: 'broken', headline: 'Your computer has no scanning system installed.', checks, plans, facts, support: { level: 'app' } };
  }
  checks.push(check('sane', 'Scanning system (SANE) installed', 'pass'));

  const list = parseScanimageList(res.stdout);
  facts.saneDevices = list.map((s) => s.name);
  const mine = findSaneDevice(device, list);
  if (mine) {
    facts.saneDevice = mine.name;
    checks.push(check('sane-sees', 'Scanning system can see the scanner', 'pass', `${mine.description} (${mine.name})`));
    return { status: 'ok', headline: 'Ready: scan with Document Scanner, Skanlite or any scanning app.', checks, plans, facts, support: { level: 'app' } };
  }

  checks.push(check('sane-sees', 'Scanning system can see the scanner', 'fail', 'SANE did not list this scanner.'));
  if (recipe) {
    plans.push(
      plan({
        id: 'reconnect',
        title: 'Reconnect the scanner',
        why: `${recipe.name} is supported by SANE. If it was plugged in before the scanning system was installed, it is not picked up until it is reconnected.`,
        confidence: 0.6,
        steps: [
          ...(recipe.platforms?.linux?.steps ?? []),
          { kind: 'manual', title: 'Unplug and replug the scanner', explain: 'Then press "Check again".' },
        ],
      }),
    );
    return { status: 'needs-fix', headline: 'The scanner is supported, but the scanning system has not picked it up yet.', checks, plans, facts, support: { level: 'app' } };
  }

  const step = installStep(AIRSCAN_PACKAGES, ctx.manager);
  plans.push(
    plan({
      id: 'install-airscan',
      title: 'Add driverless scanning support',
      why: 'sane-airscan drives scanners that support driverless scanning (eSCL / AirScan), which many recent models do. It does not help older scanners; those need a SANE backend for their model.',
      confidence: 0.35,
      auto: false,
      steps: [step, { kind: 'manual', title: 'Unplug and replug the scanner', explain: 'Then press "Check again".' }],
    }),
  );
  return {
    status: 'needs-fix',
    headline: 'The scanning system does not recognize this scanner yet.',
    checks,
    plans,
    facts,
    support: { level: 'unknown', note: 'SANE may not support this model. The SANE project lists supported scanners at sane-project.org.' },
  };
}

async function macScanner() {
  return {
    status: 'unknown',
    headline: 'Open Image Capture: if the scanner is listed there, it is ready. If not, it needs its maker\'s macOS driver or a scanning app.',
    checks: [
      check('image-capture', 'macOS scanner support', 'info', 'Image Capture works with scanners that support driverless scanning and with scanners whose maker provides a macOS driver. Many older scanners have no driver for current macOS; third-party apps such as VueScan support many of them.'),
    ],
    plans: [
      plan({
        id: 'open-image-capture',
        title: 'Open Image Capture',
        why: 'Image Capture, built into macOS, lists every scanner the Mac can use.',
        confidence: 0.7,
        steps: [{ kind: 'command', title: 'Open Image Capture', explain: 'Opens Apple\'s scanning app. Your scanner should appear on the left.', cmd: 'open', args: ['-a', 'Image Capture'], admin: false, safe: true }],
      }),
    ],
    facts: {},
    support: { level: 'vendor-driver', note: 'Works in Image Capture when the maker provides a macOS driver or the scanner supports driverless scanning.' },
  };
}

async function windowsScanner(device) {
  if (!device.problem) {
    return {
      status: 'ok',
      headline: 'Windows has a driver for this scanner. Scan with the Windows Scan app or the maker\'s app.',
      checks: [check('driver', 'Windows has a driver', 'pass', (device.driver?.names ?? []).join(', '))],
      plans: [],
      facts: {},
    };
  }
  return {
    status: 'broken',
    headline: 'Windows has no working driver for this scanner.',
    checks: [check('driver', 'Windows has a driver', 'fail', device.problem.message)],
    plans: [
      plan({
        id: 'windows-update',
        title: 'Ask Windows to look for a driver',
        why: 'Windows Update carries drivers for many scanners; this makes Windows search again. If it finds none, the maker\'s website has one.',
        confidence: 0.6,
        auto: true,
        steps: [{ kind: 'command', title: 'Re-scan devices', explain: 'Asks Windows to re-detect hardware and fetch a driver.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true }],
      }),
    ],
    facts: { problemCode: device.problem.code },
  };
}

async function diagnoseScanner(device, ctx) {
  if (ctx.platform === 'linux') return linuxScanner(device, ctx);
  if (ctx.platform === 'darwin') return macScanner(device, ctx);
  return windowsScanner(device, ctx);
}

/** @type {import('./index').Family} */
const family = {
  id: 'scanner',
  label: 'Scanner',
  icon: 'scanner',
  sources: ['usb'],
  match: matchScanner,
  // SANE (Linux) and Image Capture (macOS) talk to scanners from user space.
  userspace: (platform) => platform !== 'win32',
  diagnose: diagnoseScanner,
};

module.exports = { family, diagnoseScanner, parseScanimageList, findSaneDevice, looksLikeScanner };
