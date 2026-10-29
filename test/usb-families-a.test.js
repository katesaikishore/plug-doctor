'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnose } = require('../src/core/diagnose');
const { finalize } = require('../src/core/usb');
const { familyFor } = require('../src/core/families');
const { validateStep } = require('../src/core/fix/runner');
const { parseScanimageList } = require('../src/core/families/scanner');
const { fixture, fakeRun } = require('./helpers');

const apt = { id: 'apt', bin: 'apt-get', install: (p) => ['apt-get', ['install', '-y', ...p]] };
const dnf = { id: 'dnf', bin: 'dnf', install: (p) => ['dnf', ['install', '-y', ...p]] };
const pacman = { id: 'pacman', bin: 'pacman', install: (p) => ['pacman', ['-S', '--needed', '--noconfirm', ...p]] };

/** Build a finalized USB device; drivers default to whatever the interfaces carry. */
function usb(raw, platform = 'linux') {
  const interfaces = raw.interfaces ?? [];
  const drivers = [...new Set(interfaces.map((i) => i.driver).filter(Boolean))];
  return finalize(
    {
      deviceClass: '00',
      serial: null,
      busnum: '1',
      devnum: '7',
      nodes: interfaces.flatMap((i) => i.nodes ?? []),
      driver: { bound: interfaces.length ? drivers.length > 0 : null, names: drivers, unboundInterfaces: interfaces.filter((i) => !i.driver).map((i) => i.number) },
      ...raw,
    },
    platform,
  );
}

const itf = (number, cls, subclass, protocol, extra = {}) => ({ number, class: cls, subclass, protocol, name: null, driver: null, nodes: [], ...extra });

const pixel = (interfaces, productId = '4ee2') => usb({ vendorId: '18d1', productId, vendorName: 'Google', productName: 'Pixel 7', serial: '28031FDH2000AB', interfaces });
const MTP = itf('00', 'ff', 'ff', '00', { name: 'MTP' });
const ADB = itf('01', 'ff', '42', '01', { name: 'ADB Interface' });

const noGvfs = { exists: async () => false, env: {} };
const gvfs = { exists: async (p) => p === '/usr/libexec/gvfsd-mtp' || p === '/usr/lib/gvfsd-gphoto2', env: {} };

/** Every command step a family proposes must be runnable by the fix runner. */
function assertRunnable(r) {
  for (const p of r.plans) for (const s of p.steps) assert.ok(validateStep(s).ok, `${p.id}: ${s.cmd} is not allowed`);
}

// ---------------------------------------------------------------- phones

test('Android in file transfer mode on Linux with gvfs: ready', async () => {
  const r = await diagnose(pixel([MTP, ADB]), { platform: 'linux', run: fakeRun([]), manager: apt, ...gvfs });
  assert.equal(r.category, 'phone');
  assert.equal(r.icon, 'phone');
  assert.equal(r.status, 'ok');
  assert.equal(r.facts.mode, 'file-transfer');
  assert.equal(r.facts.usbDebugging, true);
  // MTP needs no kernel driver: not reported as a failure.
  assert.equal(r.checks.find((c) => c.id === 'driver-bound').status, 'info');
});

test('Android in charge-only mode (ADB only) on Linux: choose File transfer, install gvfs MTP', async () => {
  const r = await diagnose(pixel([itf('00', 'ff', '42', '01', { name: 'ADB Interface' })], '4ee7'), { platform: 'linux', run: fakeRun([]), manager: apt, ...noGvfs });
  assert.equal(r.category, 'phone');
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.facts.mode, 'charge-only');
  assert.equal(r.plans[0].id, 'choose-file-transfer');
  assert.match(r.plans[0].steps[0].explain, /notification shade.*File transfer/);
  const install = r.plans.find((p) => p.id === 'install-gvfs-mtp');
  assert.deepEqual(install.steps[0].args, ['install', '-y', 'gvfs-backends']);
  assert.equal(install.auto, true);
  assert.match(install.why, /jmtpfs/);
  assertRunnable(r);
});

test('gvfs MTP package names follow the package manager', async () => {
  const d = pixel([MTP]);
  const fedora = await diagnose(d, { platform: 'linux', run: fakeRun([]), manager: dnf, ...noGvfs });
  assert.deepEqual(fedora.plans.find((p) => p.id === 'install-gvfs-mtp').steps[0].args, ['install', '-y', 'gvfs-mtp']);
  const arch = await diagnose(d, { platform: 'linux', run: fakeRun([]), manager: pacman, ...noGvfs });
  assert.deepEqual(arch.plans.find((p) => p.id === 'install-gvfs-mtp').steps[0].args.slice(-1), ['gvfs-mtp']);
});

test('KDE uses kio-extras, so no gvfs install is offered', async () => {
  const r = await diagnose(pixel([MTP]), { platform: 'linux', run: fakeRun([]), manager: apt, exists: async () => false, env: { XDG_CURRENT_DESKTOP: 'KDE' } });
  assert.equal(r.status, 'ok');
  assert.ok(!r.plans.some((p) => p.id.startsWith('install-gvfs')));
});

test('Android on macOS without an MTP app: support is "app", plan points to OpenMTP', async () => {
  const d = { ...pixel([MTP]), platform: 'darwin' };
  const r = await diagnose(d, { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null, exists: async () => false });
  assert.equal(r.category, 'phone');
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.support.level, 'app');
  assert.match(r.support.note, /discontinued/);
  const [p] = r.plans;
  assert.equal(p.id, 'install-openmtp');
  assert.equal(p.steps[0].kind, 'open-url');
  assert.equal(p.steps[0].url, 'https://openmtp.ganeshrvel.com/');
  assert.ok(p.steps.some((s) => s.kind === 'manual' && /File transfer/.test(s.explain)));
});

test('Android charge-only on macOS: the phone-side step comes first', async () => {
  const d = { ...pixel([], '4ee7'), platform: 'darwin' };
  const r = await diagnose(d, { platform: 'darwin', run: fakeRun([]), manager: null, exists: async () => false });
  assert.equal(r.category, 'phone');
  assert.equal(r.plans[0].id, 'choose-file-transfer');
  assert.ok(r.plans.some((p) => p.id === 'install-openmtp'));
});

test('Android on macOS with OpenMTP installed: ready', async () => {
  const d = { ...pixel([MTP]), platform: 'darwin' };
  const r = await diagnose(d, { platform: 'darwin', run: fakeRun([]), manager: null, exists: async (p) => p === '/Applications/OpenMTP.app' });
  assert.equal(r.status, 'ok');
  assert.match(r.headline, /OpenMTP/);
});

test('Samsung phone with MTP on a still-image interface is a phone, not a camera', async () => {
  const d = usb({ vendorId: '04e8', productId: '6860', productName: 'SAMSUNG_Android', interfaces: [itf('00', '06', '01', '01', { name: 'MTP' })] });
  assert.equal(familyFor(d).id, 'phone');
  const r = await diagnose(d, { platform: 'linux', run: fakeRun([]), manager: apt, ...gvfs });
  assert.equal(r.facts.mode, 'file-transfer');
});

test('Samsung drives and Huawei LTE sticks are not phones', () => {
  const ssd = usb({ vendorId: '04e8', productId: '4001', productName: 'PSSD T7', interfaces: [itf('00', '08', '06', '50', { driver: 'uas' })] });
  assert.equal(familyFor(ssd).id, 'storage');
  const stick = usb({ vendorId: '12d1', productId: '14dc', productName: 'HUAWEI_MOBILE', interfaces: [itf('00', 'e0', '01', '03'), itf('01', '0a', '00', '00'), itf('02', '08', '06', '50')] });
  assert.notEqual(familyFor(stick).id, 'phone');
  const cam = usb({ vendorId: '04e8', productId: '1234', productName: 'NX300', interfaces: [itf('00', '06', '01', '01')] });
  assert.equal(familyFor(cam).id, 'camera');
});

test('Android on Windows with Code 28: re-scan devices', async () => {
  const d = { ...pixel([{ ...MTP, windowsClass: 'WPD', problem: 28 }]), platform: 'win32', problem: { code: 28, message: 'No driver is installed for this device (Code 28).' } };
  const r = await diagnose(d, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.equal(r.category, 'phone');
  assert.equal(r.status, 'broken');
  assert.deepEqual(r.plans[0].steps[0], { kind: 'command', title: 'Re-scan devices', explain: 'Asks Windows to re-detect hardware and fetch a driver.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true });
});

test('Android on Windows where only ADB lacks a driver: files still work', async () => {
  const d = {
    ...pixel([{ ...MTP, windowsClass: 'WPD', driver: 'WUDFRd', problem: 0 }, { ...ADB, problem: 28 }]),
    platform: 'win32',
    problem: { code: 28, message: 'No driver is installed for this device (Code 28).' },
  };
  const r = await diagnose(d, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'ok');
  assert.equal(r.plans[0].id, 'google-usb-driver');
});

test('Android on Windows with Code 28: a manual MTP driver plan follows the rescan', async () => {
  const d = { ...pixel([{ ...MTP, windowsClass: 'WPD', problem: 28 }]), platform: 'win32', problem: { code: 28, message: 'No driver is installed for this device (Code 28).' } };
  const r = await diagnose(d, { platform: 'win32', run: fakeRun([]), manager: null });
  const mtp = r.plans.find((p) => p.id === 'mtp-driver');
  assert.ok(mtp, 'the driver plan is offered');
  assert.ok(mtp.steps.some((s) => /MTP USB Device/.test(`${s.title} ${s.explain}`)), 'it names the built-in driver');
  assert.ok(mtp.steps.some((s) => s.kind === 'open-url' && s.url === 'https://developer.android.com/studio/run/oem-usb'), 'it links the maker driver table');
  assert.ok(!mtp.steps.some((s) => s.kind === 'command'), 'every driver step is the person\'s to take');
  assertRunnable(r);
});

test('Samsung on Windows with Code 28 also asks for Allow access to phone data', async () => {
  const d = {
    ...usb({ vendorId: '04e8', productId: '6860', vendorName: 'Samsung', productName: 'SM-G991B', serial: 'R58N', interfaces: [{ ...MTP, windowsClass: 'WPD', problem: 28 }] }),
    platform: 'win32',
    problem: { code: 28, message: 'No driver is installed for this device (Code 28).' },
  };
  const r = await diagnose(d, { platform: 'win32', run: fakeRun([]), manager: null });
  const mtp = r.plans.find((p) => p.id === 'mtp-driver');
  assert.ok(mtp.steps.some((s) => /Allow access to phone data/.test(s.title)));
  assertRunnable(r);
});

test('USB debugging waiting for the phone: the person is asked to accept the prompt', async () => {
  const run = fakeRun([['adb devices', 'List of devices attached\n28031FDH2000AB\tunauthorized\n']]);
  const r = await diagnose(pixel([MTP, ADB]), { platform: 'linux', run, manager: apt, ...gvfs });
  const prompt = r.plans.find((p) => p.id === 'accept-adb-prompt');
  assert.ok(prompt, 'the prompt step is offered');
  assert.equal(prompt.steps[0].kind, 'manual');
  assertRunnable(r);
});

test('adb says no permissions on Linux: install the Android USB rules and join plugdev', async () => {
  const run = fakeRun([['adb devices', 'List of devices attached\n28031FDH2000AB\tno permissions (user in plugdev group; are your udev rules wrong?)\n']]);
  const r = await diagnose(pixel([MTP, ADB]), { platform: 'linux', run, manager: apt, ...gvfs });
  const udev = r.plans.find((p) => p.id === 'android-udev');
  assert.ok(udev, 'the permissions plan is offered');
  assert.equal(udev.steps[0].cmd, 'apt-get', 'the rules come from the package manager');
  const group = udev.steps.find((s) => s.cmd === 'usermod');
  if (/^[a-z_][a-z0-9_-]*$/.test(require('node:os').userInfo().username)) {
    assert.deepEqual(group.args.slice(0, 2), ['-aG', 'plugdev']);
  }
  assertRunnable(r);
});

test('USB tethering on: the person is asked to check tethering and mobile data', async () => {
  const tethering = itf('02', 'e0', '01', '03', { name: 'RNDIS' });
  const r = await diagnose(pixel([tethering]), { platform: 'linux', run: fakeRun([]), manager: apt, ...gvfs });
  assert.equal(r.facts.mode, 'tethering');
  assert.ok(r.plans.some((p) => p.id === 'usb-tethering'));
  assertRunnable(r);
});

test('USB debugging already allowed: no prompt step', async () => {
  const run = fakeRun([['adb devices', 'List of devices attached\n28031FDH2000AB\tdevice\n']]);
  const r = await diagnose(pixel([MTP, ADB]), { platform: 'linux', run, manager: apt, ...gvfs });
  assert.ok(!r.plans.some((p) => p.id === 'accept-adb-prompt'));
});

test('Android that only charges on Linux is offered a different cable and port', async () => {
  const r = await diagnose(pixel([]), { platform: 'linux', run: fakeRun([]), manager: apt, ...noGvfs });
  assert.equal(r.facts.mode, 'charge-only');
  assert.ok(r.plans.some((p) => p.id === 'choose-file-transfer'));
  assert.ok(r.plans.some((p) => p.id === 'swap-cable'));
  assertRunnable(r);
});

test('Android that only charges on Windows is offered a different cable and port', async () => {
  const r = await diagnose(pixel([]), { platform: 'win32', run: fakeRun([]), manager: null });
  assert.equal(r.facts.mode, 'charge-only');
  assert.ok(r.plans.some((p) => p.id === 'swap-cable'));
});

const iphone = (over = {}) =>
  usb({
    vendorId: '05ac',
    productId: '12a8',
    vendorName: 'Apple Inc.',
    productName: 'iPhone',
    serial: '00008030001A2B3C4D5E802E',
    interfaces: [itf('00', '06', '01', '01'), itf('01', 'ff', 'fe', '02')],
    ...over,
  });

test('iPhone on Linux without usbmuxd: install it (per package manager)', async () => {
  const d = iphone();
  assert.equal(familyFor(d).id, 'phone');
  const r = await diagnose(d, { platform: 'linux', run: fakeRun([]), manager: apt });
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.facts.kind, 'iPhone');
  assert.deepEqual(r.plans[0].steps[0].args, ['install', '-y', 'usbmuxd', 'libimobiledevice-utils', 'ifuse']);
  const arch = await diagnose(d, { platform: 'linux', run: fakeRun([]), manager: pacman });
  assert.deepEqual(arch.plans[0].steps[0].args.slice(3), ['usbmuxd', 'libimobiledevice', 'ifuse']);
});

test('iPhone on Linux that has not trusted the computer', async () => {
  const run = fakeRun([
    ['idevice_id -l', '00008030-001A2B3C4D5E802E\n'],
    ['idevicepair validate', { ok: false, code: 255, stdout: 'ERROR: Please accept the trust dialog on the screen of device 00008030-001A2B3C4D5E802E, then attempt to pair again.\n' }],
  ]);
  const r = await diagnose(iphone(), { platform: 'linux', run, manager: apt });
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.plans[0].id, 'trust');
  assert.equal(r.plans[0].steps[0].kind, 'manual');
  // When the prompt never shows up, the person can reset location and privacy, which removes no photos or apps.
  const reset = r.plans[0].steps.find((s) => /reset location and privacy/i.test(s.title));
  assert.ok(reset, 'the reset step is offered');
  assert.equal(reset.kind, 'manual');
  assert.match(reset.explain, /Reset Location & Privacy/);
});

test('iPhone on Linux that will not pair: restart usbmuxd after the trust steps', async () => {
  const run = fakeRun([
    ['idevice_id -l', '00008030-001A2B3C4D5E802E\n'],
    ['idevicepair validate', { ok: false, code: 255, stdout: 'ERROR: Invalid HostID -21\n' }],
  ]);
  const r = await diagnose(iphone(), { platform: 'linux', run, manager: apt });
  const restart = r.plans.find((p) => p.id === 'restart-usbmuxd-pairing');
  assert.ok(restart, 'the restart plan is offered');
  assert.deepEqual(restart.steps[0], { kind: 'command', title: 'Restart usbmuxd', explain: 'Restarts the iPhone connection service.', cmd: 'systemctl', args: ['restart', 'usbmuxd'], admin: true, safe: true, optional: true });
  assert.ok(r.plans.findIndex((p) => p.id === 'trust') < r.plans.indexOf(restart), 'the trust steps come first');
  assertRunnable(r);
});

test('iPhone on Linux, paired: ready', async () => {
  const run = fakeRun([
    ['idevice_id -l', '00008030-001A2B3C4D5E802E\n'],
    ['idevicepair validate', 'SUCCESS: Validated pairing with device 00008030-001A2B3C4D5E802E\n'],
  ]);
  const r = await diagnose(iphone(), { platform: 'linux', run, manager: apt });
  assert.equal(r.status, 'ok');
});

test('iPhone on macOS is native; on Windows with a problem, Apple Devices is offered', async () => {
  const mac = await diagnose({ ...iphone(), platform: 'darwin' }, { platform: 'darwin', run: fakeRun([]), manager: null });
  assert.equal(mac.status, 'ok');
  assert.equal(mac.support.level, 'native');
  const win = await diagnose({ ...iphone(), platform: 'win32', problem: { code: 28, message: 'No driver (Code 28).' } }, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.equal(win.status, 'broken');
  assert.equal(win.plans[0].steps[0].url, 'https://apps.microsoft.com/detail/9np83lwlpz9k');
  assertRunnable(win);
});

test('iPhone on Windows that Apple Devices cannot use: offer to start the Apple service', async () => {
  const d = { ...iphone(), platform: 'win32' };
  const r = await diagnose(d, { platform: 'win32', run: fakeRun([]), manager: null });
  const start = r.plans.find((p) => p.id === 'start-apple-service');
  assert.ok(start, 'the service plan is offered');
  assert.equal(start.steps[0].cmd, 'powershell.exe');
  assert.equal(start.steps[0].admin, true);
  assertRunnable(r);
});

test('iPhone on Windows that is ready: the photo format and hotspot steps are offered', async () => {
  const d = { ...iphone(), platform: 'win32' };
  const r = await diagnose(d, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.ok(r.plans.some((p) => p.id === 'photo-format'));
  assert.ok(r.plans.some((p) => p.id === 'iphone-hotspot'));
  assertRunnable(r);
});

test('iPhone on a Mac: the photo format step is offered', async () => {
  const r = await diagnose(iphone(), { platform: 'darwin', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'ok');
  assert.ok(r.plans.some((p) => p.id === 'photo-format'));
});

test('iPhone trusted on Linux with a doubled file-manager entry: unmount the copy that does not open', async () => {
  const run = fakeRun([
    ['idevice_id -l', '00008030-001A2B3C4D5E802E\n'],
    ['idevicepair validate', { ok: true, code: 0, stdout: 'SUCCESS: Validated pairing with device 00008030-001A2B3C4D5E802E\n' }],
  ]);
  const r = await diagnose(iphone(), { platform: 'linux', run, manager: apt });
  assert.equal(r.status, 'ok');
  assert.ok(r.plans.some((p) => p.id === 'iphone-duplicate-entry'));
});

test('a Mac with a phone in USB tethering mode is offered the Wi-Fi hotspot, not USB tethering', async () => {
  const tethering = itf('02', 'e0', '01', '03', { name: 'RNDIS' });
  const r = await diagnose(pixel([tethering]), { platform: 'darwin', run: fakeRun([]), manager: null, ...noGvfs });
  assert.ok(r.plans.some((p) => p.id === 'wifi-hotspot'));
  assert.ok(!r.plans.some((p) => p.id === 'usb-tethering'), 'a Mac cannot use USB tethering');
  assert.match(r.headline, /Mac cannot use/);
  assertRunnable(r);
});

test('a Windows phone with a device error also gets the wireless route', async () => {
  const d = { ...pixel([{ ...MTP, windowsClass: 'WPD', problem: 28 }]), platform: 'win32', problem: { code: 28, message: 'No driver is installed for this device (Code 28).' } };
  const r = await diagnose(d, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.ok(r.plans.some((p) => p.id === 'windows-wireless'));
  assertRunnable(r);
});

test('adb says offline: reconnect the phone, then restart adb if it stays offline', async () => {
  const run = fakeRun([['adb devices', 'List of devices attached\n28031FDH2000AB\toffline\n']]);
  const r = await diagnose(pixel([MTP, ADB]), { platform: 'linux', run, manager: apt, ...gvfs });
  const offline = r.plans.find((p) => p.id === 'adb-offline');
  assert.ok(offline, 'the reconnect plan is offered');
  assert.match(offline.steps[0].explain, /adb kill-server/);
});

test('iPhone trusted on Linux but the account is not in the fuse group: offer to join it', async () => {
  const run = fakeRun([
    ['idevice_id -l', '00008030-001A2B3C4D5E802E\n'],
    ['idevicepair validate', { ok: true, code: 0, stdout: 'SUCCESS: Validated pairing\n' }],
    ['id -nG', 'user adm dialout cdrom\n'],
  ]);
  const r = await diagnose(iphone(), { platform: 'linux', run, manager: apt });
  assert.ok(r.plans.some((p) => p.id === 'ifuse-fuse-group'));
  assertRunnable(r);
});

test('a phone that only charges offers the no-notification route as its second step', async () => {
  const r = await diagnose(pixel([]), { platform: 'linux', run: fakeRun([]), manager: apt, ...noGvfs });
  const transfer = r.plans.find((p) => p.id === 'choose-file-transfer');
  assert.equal(transfer.steps[1].title, 'If no USB notification appears');
});

test('other Apple devices are not phones', () => {
  const kb = usb({ vendorId: '05ac', productId: '024f', productName: 'Aluminium Keyboard (ANSI)', interfaces: [itf('00', '03', '01', '01', { driver: 'usbhid' })] });
  assert.notEqual(familyFor(kb).id, 'phone');
});

// ---------------------------------------------------------------- cameras

const c920 = (over = {}) =>
  usb({
    vendorId: '046d',
    productId: '082d',
    vendorName: 'Logitech',
    productName: 'HD Pro Webcam C920',
    serial: 'A1B2C3D4',
    deviceClass: 'ef',
    interfaces: [
      itf('00', '0e', '01', '00', { driver: 'uvcvideo', nodes: ['video0', 'video1'] }),
      itf('01', '0e', '02', '00', { driver: 'uvcvideo' }),
      itf('02', '01', '01', '00', { driver: 'snd-usb-audio' }),
      itf('03', '01', '02', '00', { driver: 'snd-usb-audio' }),
    ],
    ...over,
  });

test('webcam on Linux whose user is not in the video group', async () => {
  const run = fakeRun([
    ['stat -c %G /dev/video0', 'video\n'],
    ['id -nG', 'alice sudo\n'],
    ['test -w /dev/video0', { ok: false, code: 1 }],
  ]);
  const r = await diagnose(c920(), { platform: 'linux', run, manager: apt });
  assert.equal(r.category, 'camera');
  assert.equal(r.icon, 'camera');
  assert.equal(r.status, 'needs-fix');
  assert.deepEqual(r.plans[0].steps[0].args.slice(0, 2), ['-aG', 'video']);
  assert.equal(r.plans[0].steps[1].kind, 'manual');
});

test('webcam on Linux with session access and another app using it', async () => {
  const run = fakeRun([
    ['stat -c %G /dev/video0', 'video\n'],
    ['id -nG', 'alice sudo\n'],
    ['test -w /dev/video0', ''],
    ['fuser /dev/video0', ' 4242'],
  ]);
  const r = await diagnose(c920(), { platform: 'linux', run, manager: apt });
  assert.equal(r.status, 'ok');
  assert.equal(r.checks.find((c) => c.id === 'permission').status, 'pass');
  const inUse = r.checks.find((c) => c.id === 'in-use');
  assert.equal(inUse.status, 'info');
  assert.match(inUse.detail, /4242/);
});

test('webcam on Linux with no driver: load uvcvideo', async () => {
  const d = c920({ interfaces: [itf('00', '0e', '01', '00'), itf('01', '0e', '02', '00')] });
  const r = await diagnose(d, { platform: 'linux', run: fakeRun([]), manager: apt });
  assert.equal(r.status, 'broken');
  assert.deepEqual(r.plans[0].steps[0].args, ['uvcvideo']);
  assert.equal(r.checks.find((c) => c.id === 'driver-bound').status, 'fail');
});

test('webcam on macOS and Windows: open the camera privacy settings', async () => {
  const mac = await diagnose({ ...c920({ interfaces: [itf('00', '0e', '01', '00'), itf('02', '01', '01', '00')] }), platform: 'darwin' }, { platform: 'darwin', run: fakeRun([]), manager: null });
  assert.equal(mac.status, 'ok');
  assert.equal(mac.support.level, 'native');
  assert.deepEqual(mac.plans[0].steps[0].args, ['x-apple.systempreferences:com.apple.preference.security?Privacy_Camera']);
  assert.notEqual(mac.checks.find((c) => c.id === 'driver-bound')?.status, 'fail');
  const win = await diagnose({ ...c920(), platform: 'win32' }, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.equal(win.plans[0].steps[0].cmd, 'explorer.exe');
  assert.deepEqual(win.plans[0].steps[0].args, ['ms-settings:privacy-webcam']);
  assertRunnable(mac);
  assertRunnable(win);
});

const eos = () => usb({ vendorId: '04a9', productId: '3218', vendorName: 'Canon Inc.', productName: 'Canon Digital Camera', interfaces: [itf('00', '06', '01', '01')] });

test('still camera on Linux: gphoto2 sees it, gvfs present', async () => {
  const run = fakeRun([['gphoto2 --auto-detect', fixture('usba-gphoto2-auto-detect.txt')]]);
  const r = await diagnose(eos(), { platform: 'linux', run, manager: apt, ...gvfs });
  assert.equal(r.category, 'camera');
  assert.equal(r.status, 'ok');
  assert.equal(r.facts.gphoto2, 'Canon EOS 600D usb:001,007');
  assert.equal(r.checks.find((c) => c.id === 'driver-bound').status, 'info');
  assert.ok(r.checks.some((c) => c.id === 'busy' && c.status === 'info'));
});

test('still camera on Linux without the gvfs camera plug-in', async () => {
  const r = await diagnose(eos(), { platform: 'linux', run: fakeRun([]), manager: dnf, ...noGvfs });
  assert.equal(r.status, 'needs-fix');
  assert.deepEqual(r.plans.find((p) => p.id === 'install-gvfs-gphoto2').steps[0].args, ['install', '-y', 'gvfs-gphoto2']);
});

test('still camera on macOS: open Image Capture', async () => {
  const r = await diagnose({ ...eos(), platform: 'darwin' }, { platform: 'darwin', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.plans[0].steps[0].args, ['-a', 'Image Capture']);
});

test('vendor-specific camera with no driver needs the maker\'s software', async () => {
  const d = usb({ vendorId: '1234', productId: '5678', productName: 'Action Camera', interfaces: [itf('00', 'ff', 'ff', 'ff')] });
  const r = await diagnose(d, { platform: 'linux', run: fakeRun([]), manager: apt });
  assert.equal(r.category, 'camera');
  assert.equal(r.support.level, 'vendor-driver');
});

// ---------------------------------------------------------------- scanners

const lide220 = (over = {}) => usb({ vendorId: '04a9', productId: '190f', vendorName: 'Canon', productName: 'CanoScan', devnum: '4', interfaces: [itf('00', 'ff', 'ff', 'ff')], ...over });

test('Canon LiDE 220 is matched by its recipe', async () => {
  const d = lide220({ productName: 'Unknown' });
  assert.equal(familyFor(d).id, 'scanner');
  const run = fakeRun([['scanimage -L', fixture('usba-scanimage-L.txt')]]);
  const r = await diagnose(d, { platform: 'linux', run, manager: apt });
  assert.equal(r.category, 'scanner');
  assert.equal(r.icon, 'scanner');
  assert.equal(r.status, 'ok');
  assert.equal(r.facts.saneDevice, 'genesys:libusb:001:004');
  assert.equal(r.recipes[0].id, 'canon-lide-genesys');
  assert.equal(r.support.level, 'app');
  assert.equal(r.checks.find((c) => c.id === 'driver-bound').status, 'info');
});

test('scanner on Linux without SANE: install it', async () => {
  const r = await diagnose(lide220(), { platform: 'linux', run: fakeRun([]), manager: dnf });
  assert.equal(r.status, 'broken');
  assert.deepEqual(r.plans[0].steps[0].args, ['install', '-y', 'sane-backends']);
  assert.equal(r.plans[0].auto, true);
});

test('scanner SANE does not know: low-confidence driverless plan', async () => {
  const d = usb({ vendorId: '04c5', productId: '159f', vendorName: 'Fujitsu', productName: 'ScanSnap iX1500', interfaces: [itf('00', 'ff', 'ff', 'ff')] });
  assert.equal(familyFor(d).id, 'scanner');
  const run = fakeRun([['scanimage -L', fixture('usba-scanimage-none.txt')]]);
  const r = await diagnose(d, { platform: 'linux', run, manager: apt });
  assert.equal(r.status, 'needs-fix');
  const p = r.plans.find((x) => x.id === 'install-airscan');
  assert.deepEqual(p.steps[0].args, ['install', '-y', 'sane-airscan']);
  assert.ok(p.confidence < 0.5);
  assert.equal(p.auto, false);
});

test('scanner on macOS and Windows', async () => {
  const mac = await diagnose({ ...lide220(), platform: 'darwin' }, { platform: 'darwin', run: fakeRun([]), manager: null });
  assert.equal(mac.support.level, 'vendor-driver');
  assert.deepEqual(mac.plans[0].steps[0].args, ['-a', 'Image Capture']);
  const win = await diagnose({ ...lide220(), platform: 'win32', problem: { code: 28, message: 'No driver (Code 28).' } }, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.equal(win.status, 'broken');
  assert.deepEqual(win.plans[0].steps[0].args, ['/scan-devices']);
});

test('all-in-one printers stay printers; barcode scanners are not scanners', () => {
  const aio = usb({ vendorId: '03f0', productId: '1234', productName: 'Officejet Pro Scan', interfaces: [itf('00', '07', '01', '02'), itf('01', 'ff', 'ff', 'ff')] });
  assert.equal(familyFor(aio).id, 'printer');
  const barcode = usb({ vendorId: '1234', productId: '0001', productName: 'Barcode Scanner', interfaces: [itf('00', '03', '01', '01', { driver: 'usbhid' })] });
  assert.notEqual(familyFor(barcode).id, 'scanner');
});

test('scanimage parser survives junk', () => {
  assert.deepEqual(parseScanimageList(''), []);
  assert.deepEqual(parseScanimageList(null), []);
  assert.deepEqual(parseScanimageList('garbage\n\ndevice without quotes'), []);
  assert.equal(parseScanimageList(fixture('usba-scanimage-L.txt')).length, 3);
});

test('a lone SANE entry that names another USB device is not this scanner', async () => {
  const run = fakeRun([['scanimage -L', "device `pixma:04A9176D_3EBCC9' is a CANON Canon PIXMA MG2500 multi-function peripheral\n"]]);
  const r = await diagnose(lide220(), { platform: 'linux', run, manager: apt });
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.plans[0].id, 'reconnect');
});
