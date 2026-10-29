'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { installStep } = require('../fix/packages');
const { check, plan } = require('./helpers');

/**
 * Phones and tablets over USB: Android (MTP, PTP, ADB, tethering) and
 * iPhone / iPad. The usual failure is not a missing driver: Android starts
 * in charge-only mode, macOS cannot open Android phones by itself, and Linux
 * needs usbmuxd before it can talk to an iPhone.
 */

/** Vendors whose USB IDs are mostly phones. Phone-like interfaces are still required. */
const ANDROID_VENDORS = {
  '18d1': 'Google',
  '04e8': 'Samsung',
  '22b8': 'Motorola',
  '2717': 'Xiaomi',
  '2a70': 'OnePlus',
  '12d1': 'Huawei',
  '0bb4': 'HTC',
  '1004': 'LG',
  '0fce': 'Sony',
  '22d9': 'Oppo / Realme',
};

/** Product names that only phones use. Huawei is left out: its LTE sticks say "HUAWEI Mobile". */
const PHONE_NAME = /android|\bpixel\b|\bnexus\b|galaxy|^SM-[A-Z]\d|\bmoto\b|redmi|xiaomi|\bpoco\b|oneplus|xperia|realme|\boppo\b|\bphone\b/i;

/** Apple product IDs that are iPhones, iPads and iPod touches (from usb.ids). */
const IOS_PRODUCTS = {
  '1290': 'iPhone', '1291': 'iPod touch', '1292': 'iPhone', '1293': 'iPod touch', '1294': 'iPhone', '1296': 'iPod touch',
  '1297': 'iPhone', '1299': 'iPod touch', '129a': 'iPad', '129c': 'iPhone', '129e': 'iPod touch', '129f': 'iPad',
  '12a0': 'iPhone', '12a2': 'iPad', '12a3': 'iPad', '12a4': 'iPad', '12a5': 'iPad', '12a6': 'iPad',
  '12a8': 'iPhone', '12a9': 'iPad', '12aa': 'iPod touch', '12ab': 'iPad',
};
/** Apple 12xx devices that speak usbmux but are not phones or tablets (TV, Watch, HomePod). */
const NOT_IOS = new Set(['12a7', '12af', '12b0']);

const is = (i, cls, sub, proto) => i.class === cls && (sub == null || i.subclass === sub) && (proto == null || i.protocol === proto);

/** Which USB functions an Android phone exposes, and the mode that implies. */
function androidModes(device) {
  const itfs = device.interfaces ?? [];
  const mtp = itfs.some((i) => /\bMTP\b/i.test(i.name ?? '') || (i.windowsClass === 'WPD' && i.class === 'ff'));
  const ptp = !mtp && itfs.some((i) => is(i, '06', '01', '01'));
  const adb = itfs.some((i) => is(i, 'ff', '42', '01') || /\bADB\b/.test(i.name ?? ''));
  const fastboot = itfs.some((i) => is(i, 'ff', '42', '03'));
  const tether = itfs.some((i) => is(i, 'e0', '01', '03') || is(i, 'ef', '04', '01'));
  const video = itfs.some((i) => i.class === '0e');
  const mode = mtp ? 'file-transfer' : ptp ? 'photo-transfer' : tether ? 'tethering' : fastboot && !adb ? 'fastboot' : 'charge-only';
  return { mtp, ptp, adb, fastboot, tether, video, mode };
}

/** 'iPhone', 'iPad', 'iPod touch', or null when this is not an iOS device. */
function iosKind(device) {
  if (device.vendorId !== '05ac') return null;
  const pid = device.productId;
  if (IOS_PRODUCTS[pid]) return IOS_PRODUCTS[pid];
  const usbmux = (device.interfaces ?? []).some((i) => is(i, 'ff', 'fe', '02'));
  return usbmux && /^12/.test(pid ?? '') && !NOT_IOS.has(pid) ? 'iPhone or iPad' : null;
}

function matchPhone(d) {
  if (d.vendorId === '05ac') return iosKind(d) ? 92 : 0;
  if (!ANDROID_VENDORS[d.vendorId]) return 0;
  const m = androidModes(d);
  if (m.mtp || m.adb || m.fastboot) return 88;
  const phoneName = PHONE_NAME.test(d.productName ?? '');
  // Samsung also made PTP cameras, so a bare PTP interface is not enough there.
  if (m.ptp) return d.vendorId !== '04e8' || phoneName ? 86 : 0;
  // A phone in webcam mode is best handled as a webcam (camera scores 75).
  if (phoneName) return m.video ? 70 : 78;
  return 0;
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const FILE_TRANSFER_STEP = {
  kind: 'manual',
  title: 'Choose "File transfer" on the phone',
  explain: 'On your phone, pull down the notification shade, tap the USB notification and choose File transfer. Unlock the phone first if it asks.',
};

function fileTransferPlan(confidence) {
  return plan({
    id: 'choose-file-transfer',
    title: 'Turn on file transfer on the phone',
    why: 'Android phones connect for charging only until you allow file transfer on the phone itself. That protects your files when you plug into a public charger.',
    confidence,
    steps: [FILE_TRANSFER_STEP],
  });
}

function modeCheck(m) {
  const label = 'Phone shares its files';
  switch (m.mode) {
    case 'file-transfer':
      return check('usb-mode', label, 'pass', 'File transfer (MTP) is on.');
    case 'photo-transfer':
      return check('usb-mode', label, 'warn', 'The phone is in photo transfer (PTP) mode: only photos and videos are visible. Choose File transfer on the phone to see every file.');
    case 'tethering':
      return check('usb-mode', label, 'info', 'The phone is sharing its internet connection over USB (tethering). It does not share files in this mode.');
    case 'fastboot':
      return check('usb-mode', label, 'info', 'The phone is in fastboot (bootloader) mode, which is only used to install system software.');
    default:
      return check('usb-mode', label, 'warn', 'The phone is only charging. It shares no files until you allow it on the phone.');
  }
}

const adbCheck = () => check('adb', 'USB debugging', 'info', 'USB debugging (ADB) is on. That is normal for developers; you can turn it off in Developer options if you did not mean to enable it.');

/** Directories gvfs installs its backends into (Debian/Fedora, older Debian, Arch). */
const GVFS_DIRS = ['/usr/libexec', '/usr/lib/gvfs', '/usr/lib'];

/** File manager plug-ins: gvfs backends per package manager. */
const GVFS_PACKAGES = {
  mtp: { apt: ['gvfs-backends'], dnf: ['gvfs-mtp'], pacman: ['gvfs-mtp'] },
  gphoto2: { apt: ['gvfs-backends'], dnf: ['gvfs-gphoto2'], pacman: ['gvfs-gphoto2'] },
};

/**
 * Can the Linux file manager open phones (`mtp`) or cameras (`gphoto2`)?
 * GNOME, Cinnamon, Xfce and MATE use gvfs; KDE uses kio-extras.
 * @returns {Promise<{ state: string, check: any, plan?: any }>}
 */
async function linuxFileManager(backend, ctx) {
  const env = ctx.env ?? process.env;
  const label = 'File manager can open it';
  if (/kde/i.test(env.XDG_CURRENT_DESKTOP ?? '')) {
    return { state: 'kio', check: check('file-manager', label, 'info', 'KDE\'s Dolphin opens phones and cameras through kio-extras, which Plasma normally includes.') };
  }
  const exists = ctx.exists ?? fileExists;
  for (const dir of GVFS_DIRS) {
    const file = path.posix.join(dir, `gvfsd-${backend}`);
    if (await exists(file)) return { state: 'gvfs', check: check('file-manager', label, 'pass', `The file manager's ${backend.toUpperCase()} support is installed (${file}).`) };
  }
  const step = installStep(GVFS_PACKAGES[backend], ctx.manager);
  const what = backend === 'mtp' ? 'phones' : 'cameras';
  return {
    state: 'missing',
    check: check('file-manager', label, 'fail', `The file manager's support for ${what} (gvfs ${backend.toUpperCase()}) is not installed.`),
    plan: plan({
      id: `install-gvfs-${backend}`,
      title: `Let the file manager open ${what}`,
      why:
        `Installs the file manager plug-in that shows ${what} in the sidebar. You may need to unplug and replug the device, or log out and back in, afterwards.` +
        (backend === 'mtp' ? ' (People who prefer the terminal can mount phones with jmtpfs instead.)' : ''),
      confidence: 0.8,
      auto: step.kind === 'command',
      steps: [step],
    }),
  };
}

function fastbootResult(checks, facts) {
  return { status: 'ok', headline: 'The phone is in fastboot mode, used to install system software. Restart it normally to use it as a phone.', checks, plans: [], facts };
}

async function linuxAndroid(device, ctx, m) {
  const checks = [modeCheck(m)];
  const plans = [];
  const facts = { phone: 'android', mode: m.mode, usbDebugging: m.adb };
  if (m.adb) checks.push(adbCheck());
  if (m.mode === 'fastboot') return fastbootResult(checks, facts);

  const fm = await linuxFileManager(m.mode === 'photo-transfer' ? 'gphoto2' : 'mtp', ctx);
  checks.push(fm.check);
  facts.fileManager = fm.state;
  if (fm.plan) plans.push(fm.plan);

  if (m.mode === 'charge-only') {
    plans.push(fileTransferPlan(0.9));
    return { status: 'needs-fix', headline: 'The phone is connected for charging only. Allow file transfer on the phone to see its files.', checks, plans, facts };
  }
  if (fm.plan) return { status: 'needs-fix', headline: 'Your file manager cannot open phones yet. One install fixes it.', checks, plans, facts };
  if (m.mode === 'tethering') {
    plans.push(fileTransferPlan(0.3));
    return { status: 'ok', headline: 'The phone is sharing its internet connection over USB.', checks, plans, facts };
  }
  if (m.mode === 'photo-transfer') {
    plans.push(fileTransferPlan(0.4));
    return { status: 'ok', headline: 'Photos and videos are in your file manager. Choose File transfer on the phone to see every file.', checks, plans, facts };
  }
  return { status: 'ok', headline: 'Ready: open your file manager, the phone is in the sidebar.', checks, plans, facts };
}

const OPENMTP_URL = 'https://openmtp.ganeshrvel.com/';

async function macAndroid(device, ctx, m) {
  const checks = [modeCheck(m)];
  const plans = [];
  const facts = { phone: 'android', mode: m.mode, usbDebugging: m.adb };
  const support = {
    level: 'app',
    note: 'macOS has no built-in way to open Android phones. A free app such as OpenMTP does it. (Google\'s old Android File Transfer app is discontinued.)',
  };
  if (m.adb) checks.push(adbCheck());
  if (m.mode === 'fastboot') return { ...fastbootResult(checks, facts), support };

  const hasApp = await (ctx.exists ?? fileExists)('/Applications/OpenMTP.app');
  facts.openMtpInstalled = hasApp;
  checks.push(
    hasApp
      ? check('mtp-app', 'Android file transfer app installed', 'pass', 'OpenMTP is installed. Only one app can talk to the phone at a time, so quit other phone apps if OpenMTP cannot see it.')
      : check('mtp-app', 'Android file transfer app installed', 'warn', 'No Android file transfer app was found. macOS needs one to open the phone\'s files.'),
  );
  if (m.mode === 'photo-transfer') {
    checks.push(check('photos', 'Photo import', 'info', 'In photo transfer mode, the Photos and Image Capture apps can import pictures without any extra app.'));
  }

  const noFiles = m.mode === 'charge-only' || m.mode === 'tethering';
  if (noFiles) plans.push(fileTransferPlan(m.mode === 'charge-only' ? 0.9 : 0.3));
  if (!hasApp) {
    plans.push(
      plan({
        id: 'install-openmtp',
        title: 'Get OpenMTP, a free Android file transfer app',
        why: 'macOS cannot open Android phones by itself. OpenMTP is free, open source and runs as a normal app: no driver, no security changes.',
        confidence: 0.8,
        steps: [
          { kind: 'open-url', title: 'Download OpenMTP', explain: 'Download the version for your Mac, open it and drag OpenMTP into Applications.', url: OPENMTP_URL },
          FILE_TRANSFER_STEP,
          { kind: 'manual', title: 'Open OpenMTP', explain: 'Your phone\'s files appear on the right side of the window. Drag files across to copy them.' },
        ],
      }),
    );
  }

  if (m.mode === 'charge-only') return { status: 'needs-fix', headline: 'The phone is connected for charging only. Allow file transfer on the phone to see its files.', checks, plans, facts, support };
  if (!hasApp) return { status: 'needs-fix', headline: 'macOS needs a free app to open Android phones. Plug Doctor can point you to one.', checks, plans, facts, support };
  if (m.mode === 'tethering') return { status: 'ok', headline: 'The phone is sharing its internet connection over USB.', checks, plans, facts, support };
  return { status: 'ok', headline: 'Ready: open OpenMTP to see the phone\'s files.', checks, plans, facts, support };
}

async function windowsAndroid(device, ctx, m) {
  const checks = [modeCheck(m)];
  const plans = [];
  const facts = { phone: 'android', mode: m.mode, usbDebugging: m.adb };
  if (m.adb) checks.push(adbCheck());

  if (device.problem) {
    facts.problemCode = device.problem.code;
    // A missing ADB driver is common and harmless when file transfer works.
    const adbOnly = (device.interfaces ?? []).filter((i) => i.problem).every((i) => is(i, 'ff', '42', '01') || /\bADB\b/.test(i.name ?? ''));
    if (adbOnly && m.adb && m.mode !== 'charge-only') {
      checks.push(check('adb-driver', 'USB debugging driver', 'info', 'Only the USB debugging (ADB) part has no driver. File transfer is not affected.'));
      plans.push(
        plan({
          id: 'google-usb-driver',
          title: 'Install Google\'s USB driver for USB debugging',
          why: 'Only needed for app developers using ADB. Some phone makers ship their own driver instead.',
          confidence: 0.3,
          steps: [{ kind: 'open-url', title: 'Open the Google USB Driver page', explain: 'Follow the instructions for your phone.', url: 'https://developer.android.com/studio/run/win-usb' }],
        }),
      );
      return { status: 'ok', headline: 'Ready: open File Explorer, the phone is under This PC.', checks, plans, facts };
    }
    checks.push(check('driver', 'Windows has a driver', 'fail', device.problem.message));
    plans.push(
      plan({
        id: 'windows-rescan',
        title: 'Ask Windows to set the phone up again',
        why: 'Windows has built-in support for Android phones; re-scanning usually installs it.',
        confidence: 0.6,
        auto: true,
        steps: [{ kind: 'command', title: 'Re-scan devices', explain: 'Asks Windows to re-detect hardware and fetch a driver.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true }],
      }),
    );
    if (m.mode === 'charge-only') plans.push(fileTransferPlan(0.5));
    return { status: 'broken', headline: 'Windows could not set up this phone.', checks, plans, facts };
  }
  if (m.mode === 'fastboot') return fastbootResult(checks, facts);
  if (m.mode === 'charge-only') {
    plans.push(fileTransferPlan(0.9));
    return { status: 'needs-fix', headline: 'The phone is connected for charging only. Allow file transfer on the phone to see its files.', checks, plans, facts };
  }
  if (m.mode === 'tethering') return { status: 'ok', headline: 'The phone is sharing its internet connection over USB.', checks, plans, facts };
  return { status: 'ok', headline: 'Ready: open File Explorer, the phone is under This PC.', checks, plans, facts };
}

const TRUST_STEP = {
  kind: 'manual',
  title: 'Unlock the phone and tap "Trust"',
  explain: 'Unlock your iPhone or iPad. When it asks "Trust This Computer?", tap Trust and enter your passcode.',
};

// The prompt sometimes never appears. Resetting location and privacy settings brings it back, and removes no photos or apps.
const TRUST_RESET_STEP = {
  kind: 'manual',
  title: 'If the prompt never appears, reset location and privacy',
  explain: 'On the iPhone or iPad, go to Settings > General > Transfer or Reset iPhone > Reset > Reset Location & Privacy (on older versions, Settings > General > Reset). Then unplug the cable, plug it back in, unlock the phone and check again. Apps may ask for location again. If the prompt still does not appear, restart both the phone and this computer, and try another cable or port.',
};

async function macIos(device, ctx, kind) {
  return {
    status: 'ok',
    headline: `macOS supports the ${kind} directly: it appears in the Finder sidebar, and in Photos for importing pictures.`,
    checks: [check('trust', 'Phone trusts this Mac', 'info', `The first time, the ${kind} asks "Trust This Computer?". Tap Trust, or the Mac cannot see its contents.`)],
    plans: [
      plan({
        id: 'trust',
        title: `Let the ${kind} trust this Mac`,
        why: 'iPhones and iPads hide their contents until you approve the computer on the device itself.',
        confidence: 0.5,
        steps: [TRUST_STEP, TRUST_RESET_STEP, { kind: 'manual', title: 'Open Finder', explain: `Click the ${kind} in the Finder sidebar under Locations.` }],
      }),
    ],
    facts: { phone: 'ios', kind },
    support: { level: 'native' },
  };
}

async function linuxIos(device, ctx, kind) {
  const { run } = ctx;
  const checks = [];
  const plans = [];
  const facts = { phone: 'ios', kind };

  const ids = await run('idevice_id', ['-l']);
  if (ids.missing) {
    checks.push(check('usbmuxd', 'iPhone support (usbmuxd, libimobiledevice) installed', 'fail', 'Linux needs usbmuxd and libimobiledevice to talk to iPhones and iPads.'));
    const step = installStep(
      {
        apt: ['usbmuxd', 'libimobiledevice-utils', 'ifuse'],
        dnf: ['usbmuxd', 'libimobiledevice-utils', 'ifuse'],
        pacman: ['usbmuxd', 'libimobiledevice', 'ifuse'],
      },
      ctx.manager,
    );
    plans.push(
      plan({
        id: 'install-usbmuxd',
        title: 'Install iPhone support',
        why: 'usbmuxd and libimobiledevice are the open-source tools Linux uses to talk to iPhones and iPads. Unplug and replug the device afterwards.',
        confidence: 0.85,
        auto: step.kind === 'command',
        steps: [step],
      }),
    );
    return { status: 'needs-fix', headline: `Linux needs one install to talk to this ${kind}.`, checks, plans, facts };
  }
  checks.push(check('usbmuxd', 'iPhone support (usbmuxd, libimobiledevice) installed', 'pass'));

  const udids = ids.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[0-9a-f-]{20,}$/i.test(l));
  facts.udids = udids;
  if (udids.length === 0) {
    checks.push(check('seen', 'iPhone tools can see the device', 'fail', 'usbmuxd is installed but did not report the device. It starts when an Apple device is plugged in.'));
    plans.push(
      plan({
        id: 'restart-usbmuxd',
        title: 'Reconnect the device',
        why: 'usbmuxd starts when an iPhone or iPad is plugged in. If it was installed after you plugged in, it missed the connection.',
        confidence: 0.6,
        steps: [
          { kind: 'command', title: 'Start usbmuxd', explain: 'Starts the iPhone connection service now.', cmd: 'systemctl', args: ['start', 'usbmuxd'], admin: true, safe: true, optional: true },
          { kind: 'manual', title: 'Unplug and replug the device', explain: 'Then unlock it and press "Check again".' },
        ],
      }),
    );
    return { status: 'needs-fix', headline: `The ${kind} is plugged in but the iPhone tools cannot see it yet.`, checks, plans, facts };
  }
  checks.push(check('seen', 'iPhone tools can see the device', 'pass', udids.join(', ')));

  const pair = await run('idevicepair', ['validate']);
  const out = `${pair.stdout}\n${pair.stderr}`;
  if (pair.ok && /SUCCESS/.test(out)) {
    checks.push(check('trust', 'Phone trusts this computer', 'pass'));
    checks.push(check('files', 'Opening files', 'info', 'Photos open in the file manager. App documents can be mounted with ifuse.'));
    return { status: 'ok', headline: `Ready: the ${kind} trusts this computer.`, checks, plans, facts };
  }
  const detail = /passcode/i.test(out)
    ? `Unlock the ${kind} with its passcode, then tap Trust.`
    : `The ${kind} has not trusted this computer yet. Tap Trust on its screen.`;
  checks.push(check('trust', 'Phone trusts this computer', 'fail', detail));
  plans.push(
    plan({
      id: 'trust',
      title: `Let the ${kind} trust this computer`,
      why: 'iPhones and iPads hide their contents until you approve the computer on the device itself.',
      confidence: 0.8,
      steps: [TRUST_STEP, TRUST_RESET_STEP],
    }),
  );
  return { status: 'needs-fix', headline: `Unlock the ${kind} and tap "Trust" to finish connecting.`, checks, plans, facts };
}

const APPLE_DEVICES_URL = 'https://apps.microsoft.com/detail/9np83lwlpz9k';

async function windowsIos(device, ctx, kind) {
  const checks = [];
  const plans = [];
  const facts = { phone: 'ios', kind };
  const appleDriver = (device.driver?.names ?? []).some((n) => /usbaapl/i.test(n));
  facts.appleDriver = appleDriver;
  const appleDevicesPlan = (confidence) =>
    plan({
      id: 'apple-devices',
      title: 'Install Apple Devices from the Microsoft Store',
      why: 'Apple\'s free Apple Devices app brings the driver Windows needs to back up, sync and update iPhones and iPads.',
      confidence,
      steps: [
        { kind: 'open-url', title: 'Open Apple Devices in the Microsoft Store', explain: 'Click Get or Install.', url: APPLE_DEVICES_URL },
        TRUST_STEP,
        TRUST_RESET_STEP,
      ],
    });

  if (device.problem) {
    facts.problemCode = device.problem.code;
    checks.push(check('driver', 'Windows has a driver', 'fail', device.problem.message));
    plans.push(appleDevicesPlan(0.7));
    plans.push(
      plan({
        id: 'windows-rescan',
        title: 'Ask Windows to set the device up again',
        why: 'Re-detects the device after the Apple driver is installed.',
        confidence: 0.5,
        auto: true,
        steps: [{ kind: 'command', title: 'Re-scan devices', explain: 'Asks Windows to re-detect hardware.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true }],
      }),
    );
    return { status: 'broken', headline: `Windows could not set up the ${kind}. Apple's free Apple Devices app usually fixes it.`, checks, plans, facts };
  }
  checks.push(check('trust', 'Phone trusts this computer', 'info', `The first time, tap Trust on the ${kind} when it asks about this computer.`));
  if (appleDriver) {
    checks.push(check('apple-driver', 'Apple\'s driver installed', 'pass'));
    return { status: 'ok', headline: `Ready: photos are in File Explorer, and Apple Devices can back up the ${kind}.`, checks, plans, facts };
  }
  checks.push(check('apple-driver', 'Apple\'s driver installed', 'info', 'Photos are available in File Explorer without it. To back up or sync, install Apple Devices.'));
  plans.push(appleDevicesPlan(0.5));
  return { status: 'ok', headline: `Photos on the ${kind} are available in File Explorer.`, checks, plans, facts };
}

async function diagnosePhone(device, ctx) {
  const kind = iosKind(device);
  if (kind) {
    if (ctx.platform === 'darwin') return macIos(device, ctx, kind);
    if (ctx.platform === 'linux') return linuxIos(device, ctx, kind);
    return windowsIos(device, ctx, kind);
  }
  const m = androidModes(device);
  if (ctx.platform === 'darwin') return macAndroid(device, ctx, m);
  if (ctx.platform === 'linux') return linuxAndroid(device, ctx, m);
  return windowsAndroid(device, ctx, m);
}

/** @type {import('./index').Family} */
const family = {
  id: 'phone',
  label: 'Phone or tablet',
  icon: 'phone',
  sources: ['usb'],
  match: matchPhone,
  // MTP, PTP, ADB and usbmuxd all talk to the phone from user space on
  // macOS and Linux. Windows binds its own WPD drivers.
  userspace: (platform) => platform !== 'win32',
  diagnose: diagnosePhone,
};

module.exports = { family, diagnosePhone, androidModes, iosKind, linuxFileManager, ANDROID_VENDORS };
