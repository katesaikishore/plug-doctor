'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
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
  explain: 'Unlock the phone, pull down the notification shade and tap the USB notification ("Charging this device via USB"). If it offers more options, tap "Tap for more options" first. Then choose File transfer under "Use USB for".',
};

// Some phones show no USB notification at all. Google and the OpenMTP guide both give these routes.
const NO_NOTIFICATION_STEP = {
  kind: 'manual',
  title: 'If no USB notification appears',
  explain: 'Open Settings and search for "USB", then choose File transfer. On some Sony phones the route is Settings, then Connected devices, then USB. Or turn on Developer options (tap Build number seven times under About phone), open Developer options, and choose File transfer (MTP) under Select USB configuration. Menu names vary by brand.',
};

function fileTransferPlan(confidence) {
  return plan({
    id: 'choose-file-transfer',
    title: 'Turn on file transfer on the phone',
    why: 'Android phones connect for charging only until you allow file transfer on the phone itself. That protects your files when you plug into a public charger.',
    confidence,
    steps: [FILE_TRANSFER_STEP, NO_NOTIFICATION_STEP],
  });
}

/** iPhones save photos as HEIC by default, which some computers cannot open. This setting makes the iPhone send JPEG copies. */
function photoFormatPlan() {
  return plan({
    id: 'photo-format',
    title: 'Let the iPhone send photos in a format your computer opens',
    why: 'iPhones save photos as HEIC by default. Computers that cannot open HEIC show an error or no picture.',
    confidence: 0.3,
    steps: [
      {
        kind: 'manual',
        title: 'Choose Automatically for photo transfer',
        explain: 'On the iPhone or iPad, go to Settings, then Photos, scroll to Transfer to Mac or PC, and choose Automatically. Then import again.',
      },
    ],
  });
}

/** Personal Hotspot can share the iPhone's mobile data over the cable. */
function hotspotPlan() {
  return plan({
    id: 'iphone-hotspot',
    title: 'Share the iPhone\'s internet over the cable',
    why: 'Personal Hotspot can share the iPhone\'s mobile data over USB. On Windows, Apple Devices must be installed for it to work.',
    confidence: 0.2,
    steps: [
      {
        kind: 'manual',
        title: 'Turn on Personal Hotspot',
        explain: 'On the iPhone, go to Settings, then Personal Hotspot, and turn it on. Keep the iPhone unlocked and plugged in with the cable.',
      },
    ],
  });
}

/** The file manager can mount an iPhone twice, and the copies can block each other. */
function duplicateEntryPlan() {
  return plan({
    id: 'iphone-duplicate-entry',
    title: 'Unmount the copy of the iPhone that does not open',
    why: 'The file manager can show the iPhone twice, once as a camera, and the two copies can block each other.',
    confidence: 0.3,
    steps: [
      {
        kind: 'manual',
        title: 'Unmount the copy that does not open',
        explain: 'In the file manager sidebar, right-click the iPhone entry that does not open and choose Unmount or Eject. Then open the other entry.',
      },
    ],
  });
}

/** A Mac cannot use USB tethering. A Wi-Fi hotspot on the phone shares its internet with any computer. */
function wifiHotspotPlan() {
  return plan({
    id: 'wifi-hotspot',
    title: 'Share the phone\'s internet over Wi-Fi instead',
    why: 'macOS cannot use the phone\'s internet over the cable. A Wi-Fi hotspot works with a Mac.',
    confidence: 0.5,
    steps: [
      {
        kind: 'manual',
        title: 'Turn on the Wi-Fi hotspot',
        explain: 'On an Android phone, open Settings, then Network & internet (or Connections), then Hotspot & tethering, and turn on Wi-Fi hotspot. Then connect the Mac to the phone\'s network. Menu names vary by brand.',
      },
    ],
  });
}

/** OpenMTP and macOS' camera helpers can hold the phone; the person quits them, Plug Doctor never force-quits anything. */
function cameraHelpersPlan() {
  return plan({
    id: 'quit-camera-helpers',
    title: 'Quit the programs that may hold the phone',
    why: 'Mac camera helpers and other phone apps can keep the phone to themselves, so OpenMTP cannot see it.',
    confidence: 0.2,
    steps: [
      {
        kind: 'manual',
        title: 'Quit the other phone apps',
        explain: 'Quit Preview, Image Capture, Photos, Google Drive, Dropbox, OneDrive and Android File Transfer if they are open. If OpenMTP still cannot see the phone, open Activity Monitor from Applications, then Utilities, search for ptpcamerad or mscamerad-xpc, and choose Force Quit. Unplug the phone, plug it back in, and tap Refresh in OpenMTP.',
      },
    ],
  });
}

/** Windows 11 can show an Android phone in File Explorer over the wireless link when the cable route fails. */
function wirelessPlan() {
  return plan({
    id: 'windows-wireless',
    title: 'Show the phone in File Explorer without the cable',
    why: 'When the cable route will not work, Windows 11 can show an Android phone in File Explorer over the wireless link. Only one mobile device can show at a time.',
    confidence: 0.3,
    steps: [
      {
        kind: 'manual',
        title: 'Turn on the wireless route in Windows',
        explain: 'On Windows 11, open Settings, then Bluetooth & devices, then Mobile devices, then Manage devices, and choose Show mobile device in File Explorer. Files you delete go to the Recycle bin for the connected device, and stay there for 30 days.',
      },
    ],
  });
}

/** ifuse mounts an iPhone through FUSE, so the account must be in the fuse group. Adding a group only adds access. */
function fuseGroupPlan() {
  const steps = [];
  const user = os.userInfo().username;
  if (/^[a-z_][a-z0-9_-]*$/.test(user)) {
    steps.push({
      kind: 'command',
      title: 'Let your account mount the iPhone with ifuse',
      explain: 'Adds your account to the fuse group, which ifuse needs.',
      cmd: 'usermod',
      args: ['-aG', 'fuse', user],
      admin: true,
      safe: true,
    });
  }
  steps.push({ kind: 'manual', title: 'Log out, log back in, then plug the iPhone in again', explain: 'The new group applies after you log in again. Then press "Check again".' });
  return plan({
    id: 'ifuse-fuse-group',
    title: 'Let your account mount the iPhone with ifuse',
    why: 'ifuse reads the iPhone through FUSE, and only members of the fuse group may use it.',
    confidence: 0.4,
    steps,
  });
}

/** Tethering shares the phone's internet only while USB tethering is switched on in its settings. */
function tetherPlan() {
  return plan({
    id: 'usb-tethering',
    title: 'Check USB tethering on the phone',
    why: 'The phone shares its internet over USB only while USB tethering is on, and it needs mobile data or Wi-Fi to share.',
    confidence: 0.3,
    steps: [
      {
        kind: 'manual',
        title: 'Turn on USB tethering',
        explain: 'On an Android phone, open Settings, then Network & internet (or Connections), then Hotspot & tethering, and switch on USB tethering. Menu names vary by brand. Make sure mobile data or Wi-Fi is on.',
      },
    ],
  });
}

/** Some cables only charge and carry no data. Google and Samsung both name this as a common cause. */
function cablePlan() {
  return plan({
    id: 'swap-cable',
    title: 'Try a different USB cable and port',
    why: 'Some cables only charge and carry no data. Plug straight into a port on the computer, not a hub, and use the cable that came with the phone if you can.',
    confidence: 0.4,
    steps: [{ kind: 'manual', title: 'Swap the cable and port', explain: 'Unplug the phone and try the cable that came with it (or the maker\'s own cable), in a port on the computer itself. Make sure the cable and the port are dry. Then choose File transfer again.' }],
  });
}

const OEM_USB_URL = 'https://developer.android.com/studio/run/oem-usb';

/**
 * Windows' built-in MTP driver, picked by hand when the rescan does not
 * bring it back. Every step is the person's to take on the computer or phone.
 */
function mtpDriverPlan(device) {
  const steps = [FILE_TRANSFER_STEP];
  if (device.vendorId === '04e8') {
    steps.push({ kind: 'manual', title: 'Tap "Allow access to phone data"', explain: 'On a Samsung phone, unlock it and tap Allow when it asks to let this computer access its data.' });
  }
  steps.push(
    {
      kind: 'manual',
      title: 'Pick "MTP USB Device" as the driver',
      explain: 'Press Windows + R, type devmgmt.msc and press Enter. Under Portable Devices or Other devices, right-click the phone, choose Update driver, then Browse my computer, Let me pick from a list, and select MTP USB Device.',
    },
    {
      kind: 'manual',
      title: 'If the warning stays, reinstall the phone',
      explain: 'In Device Manager, choose Uninstall device for the phone. Unplug it, restart the computer, then plug it back in and unlock it.',
    },
    {
      kind: 'open-url',
      title: 'Get your phone maker\'s USB driver, if it has one',
      explain: 'Find your phone\'s maker in the table, install the driver it names, then try again. If your maker is not in the table, search its support site for a USB driver. OnePlus and Nothing phones are not in the table.',
      url: OEM_USB_URL,
    },
  );
  return plan({
    id: 'mtp-driver',
    title: 'Install the right Windows driver for the phone',
    why: 'Windows usually sets up phones on its own, with a built-in MTP driver that shows the phone\'s files. Maker drivers are mainly for developers using adb. When Windows cannot load the built-in driver, picking it by hand usually fixes it.',
    confidence: 0.5,
    steps,
  });
}

/** Restart usbmuxd when pairing keeps failing. Starting a service is add-only and touches no pairing record. */
function restartPairingPlan() {
  return plan({
    id: 'restart-usbmuxd-pairing',
    title: 'Restart the iPhone connection service, then pair again',
    why: 'When the pairing record is stuck, restarting the service and pairing again often clears it. Plug Doctor does not delete any pairing record.',
    confidence: 0.4,
    steps: [
      { kind: 'command', title: 'Restart usbmuxd', explain: 'Restarts the iPhone connection service.', cmd: 'systemctl', args: ['restart', 'usbmuxd'], admin: true, safe: true, optional: true },
      { kind: 'manual', title: 'Unplug the iPhone, plug it back in, unlock it and tap Trust', explain: 'Then press "Check again".' },
    ],
  });
}

/** The Apple service that Apple Devices and iTunes talk through. Starting it is add-only and changes no settings. */
function startAppleServicePlan() {
  return plan({
    id: 'start-apple-service',
    title: 'Start the Apple Mobile Device Service',
    why: 'Apple Devices and iTunes cannot find the iPhone while this Windows service is stopped. Starting it changes no settings.',
    confidence: 0.3,
    steps: [
      {
        kind: 'command',
        title: 'Start the service',
        explain: 'Starts Apple Mobile Device Service now.',
        cmd: 'powershell.exe',
        args: ['-NoProfile', '-Command', "Start-Service -Name 'Apple Mobile Device Service'"],
        admin: true,
        safe: true,
        optional: true,
      },
      {
        kind: 'manual',
        title: 'If it stops again, set its Startup type to Automatic',
        explain: 'In services.msc, double-click Apple Mobile Device Service, set Startup type to Automatic, and click OK. Plug Doctor does not change the Startup type.',
      },
    ],
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
    plans.push(fileTransferPlan(0.9), cablePlan());
    return { status: 'needs-fix', headline: 'The phone is connected for charging only. Allow file transfer on the phone to see its files.', checks, plans, facts };
  }
  if (fm.plan) return { status: 'needs-fix', headline: 'Your file manager cannot open phones yet. One install fixes it.', checks, plans, facts };
  if (m.mode === 'tethering') {
    plans.push(fileTransferPlan(0.3), tetherPlan());
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
  if (hasApp) plans.push(cameraHelpersPlan());
  if (device.vendorId === '1004') {
    checks.push(check('lg-bridge', 'LG\'s own tool', 'info', 'LG Bridge is LG\'s own tool. It does not support every LG phone, so if it cannot connect, check LG\'s support list for your model.'));
  }
  if (m.mode === 'photo-transfer') {
    checks.push(check('photos', 'Photo import', 'info', 'In photo transfer mode, the Photos and Image Capture apps can import pictures without any extra app.'));
  }

  const noFiles = m.mode === 'charge-only' || m.mode === 'tethering';
  if (noFiles) plans.push(fileTransferPlan(m.mode === 'charge-only' ? 0.9 : 0.3));
  if (!hasApp && m.mode !== 'tethering') {
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

  if (m.mode === 'charge-only') {
    plans.push(cablePlan());
    return { status: 'needs-fix', headline: 'The phone is connected for charging only. Allow file transfer on the phone to see its files.', checks, plans, facts, support };
  }
  if (m.mode === 'tethering') {
    // macOS cannot use USB tethering, so the Wi-Fi hotspot is the route that works.
    plans.push(wifiHotspotPlan());
    return { status: 'ok', headline: 'This phone is sharing its internet over USB, which a Mac cannot use. Share it through a Wi-Fi hotspot instead.', checks, plans, facts, support };
  }
  if (!hasApp) return { status: 'needs-fix', headline: 'macOS needs a free app to open Android phones. Plug Doctor can point you to one.', checks, plans, facts, support };
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
      // Google's driver is for Google phones only; every other maker supplies its own.
      const isGoogle = device.vendorId === '18d1';
      plans.push(
        plan({
          id: 'google-usb-driver',
          title: isGoogle ? 'Install Google\'s USB driver for USB debugging' : 'Install your phone maker\'s USB driver for USB debugging',
          why: 'Only needed for app developers using ADB. Some phone makers ship their own driver instead.',
          confidence: 0.3,
          steps: [
            isGoogle
              ? { kind: 'open-url', title: 'Open the Google USB Driver page', explain: 'Follow the instructions for your phone.', url: 'https://developer.android.com/studio/run/win-usb' }
              : { kind: 'open-url', title: 'Open the maker driver table', explain: 'Find your phone\'s maker and follow the instructions it gives.', url: OEM_USB_URL },
          ],
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
    plans.push(mtpDriverPlan(device), wirelessPlan());
    if (m.mode === 'charge-only') plans.push(fileTransferPlan(0.5), cablePlan());
    return { status: 'broken', headline: 'Windows could not set up this phone.', checks, plans, facts };
  }
  if (m.mode === 'fastboot') return fastbootResult(checks, facts);
  if (m.mode === 'charge-only') {
    plans.push(fileTransferPlan(0.9), cablePlan());
    return { status: 'needs-fix', headline: 'The phone is connected for charging only. Allow file transfer on the phone to see its files.', checks, plans, facts };
  }
  if (m.mode === 'tethering') {
    plans.push(tetherPlan());
    return { status: 'ok', headline: 'The phone is sharing its internet connection over USB.', checks, plans, facts };
  }
  return { status: 'ok', headline: 'Ready: open File Explorer, the phone is under This PC.', checks, plans, facts };
}

const TRUST_STEP = {
  kind: 'manual',
  title: 'Unlock the phone and tap "Trust"',
  explain: 'Unlock your iPhone or iPad. When it asks "Trust This Computer?", tap Trust and enter your passcode. If you tapped Don\'t Trust by mistake, use the reset step below. The question can come back on every connection when automatic backups are on. Keep the iPhone unlocked while it is connected: a locked iPhone can stop talking to the computer after a while.',
};

// The prompt sometimes never appears. Resetting location and privacy settings brings it back, and removes no photos or apps.
const TRUST_RESET_STEP = {
  kind: 'manual',
  title: 'If the prompt never appears, reset location and privacy',
  explain: 'On the iPhone or iPad, go to Settings > General > Transfer or Reset iPhone > Reset > Reset Location & Privacy (on older versions, Settings > General > Reset). Then unplug the cable, plug it back in, unlock the phone and check again. Apps may ask for location again. If the prompt still does not appear, restart both the phone and this computer, and try another cable or port.',
};

async function macIos(device, ctx, kind) {
  const result = {
    status: 'ok',
    headline: `macOS supports the ${kind} directly: it appears in the Finder sidebar, and in Photos for importing pictures.`,
    checks: [check('trust', 'Phone trusts this Mac', 'info', `The first time, the ${kind} asks "Trust This Computer?". Tap Trust, or the Mac cannot see its contents.`)],
    plans: [
      plan({
        id: 'trust',
        title: `Let the ${kind} trust this Mac`,
        why: 'iPhones and iPads hide their contents until you approve the computer on the device itself.',
        confidence: 0.5,
        steps: [
          TRUST_STEP,
          {
            kind: 'manual',
            title: 'If "Allow accessory to connect?" appears, click Allow',
            explain: 'Click Allow on the Mac. If you clicked Don\'t Allow, unplug the iPhone, plug it back in, and click Allow when it asks.',
          },
          TRUST_RESET_STEP,
          { kind: 'manual', title: 'Open Finder', explain: `Click the ${kind} in the Finder sidebar under Locations. If the sidebar is hidden, choose View > Show Sidebar.` },
        ],
      }),
    ],
    facts: { phone: 'ios', kind },
    support: { level: 'native' },
  };
  result.plans.push(photoFormatPlan());
  return result;
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
    plans.push(duplicateEntryPlan());
    const groups = await run('id', ['-nG']);
    if (!groups.missing && !groups.stdout.split(/\s+/).includes('fuse')) plans.push(fuseGroupPlan());
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
  plans.push(restartPairingPlan());
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
  plans.push(appleDevicesPlan(0.5), startAppleServicePlan(), photoFormatPlan(), hotspotPlan());
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
  let result;
  if (ctx.platform === 'darwin') result = await macAndroid(device, ctx, m);
  else if (ctx.platform === 'linux') result = await linuxAndroid(device, ctx, m);
  else result = await windowsAndroid(device, ctx, m);
  if (m.adb) {
    const authPlan = await adbAuthPlan(ctx);
    if (authPlan) result.plans.push(authPlan);
    const permissionPlan = ctx.platform === 'linux' ? await adbPermissionPlan(ctx) : null;
    if (permissionPlan) result.plans.push(permissionPlan);
  }
  return result;
}

/**
 * On Linux, adb lists a phone as "no permissions" until the user may open
 * USB devices: Android's udev rules and membership of the plugdev group.
 * Installing the rules only adds files; the group change needs a fresh login.
 */
async function adbPermissionPlan(ctx) {
  const out = await ctx.run('adb', ['devices']);
  if (out.missing || !/no permissions/.test(out.stdout)) return null;
  const steps = [installStep({ apt: ['android-sdk-platform-tools-common'], dnf: ['android-udev-rules'] }, ctx.manager)];
  const user = os.userInfo().username;
  if (/^[a-z_][a-z0-9_-]*$/.test(user)) {
    steps.push({
      kind: 'command',
      title: 'Let your account open Android phones',
      explain: 'Adds your account to the plugdev group, which the Android USB rules check.',
      cmd: 'usermod',
      args: ['-aG', 'plugdev', user],
      admin: true,
      safe: true,
    });
  }
  steps.push({ kind: 'manual', title: 'Log out, log back in, then plug the phone in again', explain: 'New groups and rules only apply after you log in again. Then press "Check again".' });
  return plan({
    id: 'android-udev',
    title: 'Let your account use the phone for USB debugging',
    why: 'Linux blocks other users from talking to USB devices directly. Android\'s udev rules and the plugdev group let your account do it.',
    confidence: 0.6,
    steps,
  });
}

/**
 * adb lists a phone as "unauthorized" until the person accepts the USB
 * debugging prompt on the phone. Plug Doctor only reads the state.
 */
async function adbAuthPlan(ctx) {
  const out = await ctx.run('adb', ['devices']);
  if (out.missing) return null;
  // Offline means adb reached the phone and got no answer: reconnecting usually clears it.
  if (/\boffline\b/.test(out.stdout)) {
    return plan({
      id: 'adb-offline',
      title: 'Reconnect the phone to USB debugging',
      why: 'adb lists the phone as offline when it stops answering. Reconnecting usually fixes it.',
      confidence: 0.4,
      steps: [
        {
          kind: 'manual',
          title: 'Unplug the phone and plug it back in',
          explain: 'Then unlock it. If it still shows offline, run adb kill-server in a terminal, then adb devices.',
        },
      ],
    });
  }
  if (!/\bunauthorized\b/.test(out.stdout)) return null;
  return plan({
    id: 'accept-adb-prompt',
    title: 'Accept the USB debugging prompt on the phone',
    why: 'Developer tools need the phone to trust this computer for USB debugging. The prompt is on the phone itself, so only the person can answer it.',
    confidence: 0.7,
    steps: [
      {
        kind: 'manual',
        title: 'Tap Allow on the phone',
        explain: 'When the phone asks "Allow USB debugging?", tick "Always allow from this computer" and tap Allow. If the prompt does not appear, unplug the phone and plug it back in.',
      },
    ],
  });
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
