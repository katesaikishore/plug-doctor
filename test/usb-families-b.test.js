'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnose } = require('../src/core/diagnose');
const { familyFor } = require('../src/core/families');
const { finalize } = require('../src/core/usb');
const { validateStep } = require('../src/core/fix/runner');
const audio = require('../src/core/families/audio');
const input = require('../src/core/families/input');
const net = require('../src/core/families/network-adapter');
const storage = require('../src/core/families/storage');
const { fixture, fakeRun } = require('./helpers');

const apt = { id: 'apt', bin: 'apt-get', install: (p) => ['apt-get', ['install', '-y', ...p]] };

/** A USB device as the Linux enumerator returns it, run through finalize(). */
function usb(over, platform = 'linux') {
  const interfaces = over.interfaces ?? [];
  const drivers = [...new Set(interfaces.map((i) => i.driver).filter(Boolean))];
  return finalize(
    {
      serial: null,
      deviceClass: '00',
      nodes: interfaces.flatMap((i) => i.nodes ?? []),
      driver: { bound: interfaces.length ? drivers.length > 0 : null, names: drivers, unboundInterfaces: interfaces.filter((i) => !i.driver).map((i) => i.number) },
      ...over,
      interfaces: interfaces.map((i) => ({ name: null, nodes: [], ...i })),
    },
    platform,
  );
}

const itf = (number, cls, subclass, protocol, driver = null, extra = {}) => ({ number, class: cls, subclass, protocol, driver, ...extra });

/** Every command step must be on the runner's allow-list. */
function assertAllowed(result) {
  for (const p of result.plans) for (const s of p.steps) assert.ok(validateStep(s).ok, `${p.id}: ${s.cmd} is not allowed`);
}

// ---------------------------------------------------------------- devices

const headset = (driver = 'snd-usb-audio', platform = 'linux') =>
  usb(
    {
      vendorId: '0d8c',
      productId: '0014',
      vendorName: 'C-Media Electronics Inc.',
      productName: 'USB Audio Device',
      sysName: '1-2',
      interfaces: [itf('00', '01', '01', '00', driver), itf('01', '01', '02', '00', driver), itf('02', '01', '02', '00', driver), itf('03', '03', '00', '00', 'usbhid', { nodes: ['hidraw2'] })],
    },
    platform,
  );

const nanoKontrol = (platform = 'linux') =>
  usb(
    {
      vendorId: '0944',
      productId: '0117',
      vendorName: 'KORG INC.',
      productName: 'nanoKONTROL2',
      sysName: '1-3',
      interfaces: [itf('00', '01', '01', '00', 'snd-usb-audio'), itf('01', '01', '03', '00', 'snd-usb-audio')],
    },
    platform,
  );

const keyboard = () =>
  usb({
    vendorId: '046d',
    productId: 'c31c',
    vendorName: 'Logitech',
    productName: 'USB Keyboard',
    interfaces: [itf('00', '03', '01', '01', 'usbhid', { nodes: ['hidraw0'] }), itf('01', '03', '00', '00', 'usbhid', { nodes: ['hidraw1'] })],
  });

const xbox360 = (driver = 'xpad', platform = 'linux') =>
  usb({ vendorId: '045e', productId: '028e', vendorName: 'Microsoft', productName: 'Controller', deviceClass: 'ff', interfaces: [itf('00', 'ff', '5d', '01', driver)] }, platform);

const dualshock4 = (platform = 'linux') =>
  usb(
    {
      vendorId: '054c',
      productId: '09cc',
      vendorName: 'Sony Interactive Entertainment',
      productName: 'Wireless Controller',
      interfaces: [itf('00', '01', '01', '00', 'snd-usb-audio'), itf('01', '01', '02', '00', 'snd-usb-audio'), itf('02', '01', '02', '00', 'snd-usb-audio'), itf('03', '03', '00', '00', 'usbhid')],
    },
    platform,
  );

const rtl8153 = (driver = 'r8152') =>
  usb({ vendorId: '0bda', productId: '8153', vendorName: 'Realtek', productName: 'USB 10/100/1000 LAN', sysName: '2-1', interfaces: [itf('00', 'ff', 'ff', '00', driver)] });

const wifiDongle = (driver = null, platform = 'linux') =>
  usb({ vendorId: '0bda', productId: '8179', vendorName: 'Realtek', productName: '802.11n NIC', deviceClass: '00', interfaces: [itf('00', 'ff', 'ff', 'ff', driver)] }, platform);

// ---------------------------------------------------------------- matching

test('families: headset is audio, keyboard is input, controllers beat their audio interface', () => {
  assert.equal(familyFor(headset()).id, 'audio');
  assert.equal(familyFor(nanoKontrol()).id, 'audio');
  assert.equal(familyFor(keyboard()).id, 'input');
  assert.equal(familyFor(xbox360()).id, 'input');
  assert.equal(familyFor(dualshock4()).id, 'input');
  assert.equal(familyFor(rtl8153()).id, 'network-adapter');
  assert.equal(familyFor(wifiDongle()).id, 'network-adapter');
});

test('families: a webcam microphone is left to the camera family', () => {
  const cam = usb({ vendorId: '046d', productId: '0825', productName: 'Webcam C270', interfaces: [itf('00', '0e', '01', '00', 'uvcvideo'), itf('01', '0e', '02', '00', 'uvcvideo'), itf('02', '01', '01', '00', 'snd-usb-audio')] });
  assert.ok(audio.family.match(cam) < 75);
});

test('families: a CDC-ECM adapter beats serial; RNDIS stays below 70; phone vendors are not claimed', () => {
  const ecm = usb({ vendorId: '0bda', productId: '8153', productName: 'USB 10/100/1000 LAN', interfaces: [itf('00', '02', '06', '00', 'cdc_ether'), itf('01', '0a', '00', '00', 'cdc_ether')] });
  assert.equal(familyFor(ecm).id, 'network-adapter');
  const gadget = usb({ vendorId: '1d50', productId: '0000', productName: 'RNDIS gadget', interfaces: [itf('00', 'e0', '01', '03', 'rndis_host'), itf('01', '0a', '00', '00', 'rndis_host')] });
  assert.ok(net.family.match(gadget) > 0 && net.family.match(gadget) < 70);
  const pixel = usb({ vendorId: '18d1', productId: 'abcd', productName: 'Pixel 8', interfaces: [itf('00', 'e0', '01', '03', 'rndis_host'), itf('01', '0a', '00', '00', 'rndis_host')] });
  assert.equal(net.family.match(pixel), 0);
  // A Realtek device that does not say it is Wi-Fi (an SDR tuner, for example) is not claimed.
  const sdr = usb({ vendorId: '0bda', productId: '2838', productName: 'RTL2838UHIDIR', interfaces: [itf('00', 'ff', 'ff', 'ff', null)] });
  assert.equal(net.family.match(sdr), 0);
});

// ---------------------------------------------------------------- audio

test('audio parsers survive junk', () => {
  assert.deepEqual(audio.parseAsoundCards('garbage\n'), []);
  assert.deepEqual(audio.parseAplay(undefined), []);
  assert.equal(audio.parseSpAudio('{not json'), null);
  assert.deepEqual(audio.parseSpAudio('{"SPAudioDataType": 3}'), []);
  assert.deepEqual(audio.parsePactlSinks('nothing here'), []);
  const cards = audio.parseAsoundCards(fixture('usbb-asound-cards.txt'));
  assert.deepEqual(cards.map((c) => [c.index, c.usbPort]), [[0, null], [1, '2'], [2, '3']]);
});

test('USB headset on Linux: card found by USB port, offers to make it the default output', async () => {
  const run = fakeRun([
    ['cat /proc/asound/cards', fixture('usbb-asound-cards.txt')],
    ['aplay -l', fixture('usbb-aplay-l.txt')],
    ['arecord -l', fixture('usbb-arecord-l.txt')],
    ['pactl list short sinks', fixture('usbb-pactl-sinks.txt')],
    ['pactl info', fixture('usbb-pactl-info.txt')],
  ]);
  const r = await diagnose(headset(), { platform: 'linux', run, manager: apt });
  assert.equal(r.category, 'audio');
  assert.equal(r.status, 'ok');
  assert.equal(r.facts.card, 'card 1: USB Audio Device');
  assert.equal(r.facts.sink, 'alsa_output.usb-C-Media_Electronics_Inc._USB_Audio_Device-00.analog-stereo');
  const [p] = r.plans;
  assert.equal(p.id, 'set-default-sink');
  assert.equal(p.auto, false);
  assert.deepEqual([p.steps[0].cmd, ...p.steps[0].args], ['pactl', 'set-default-sink', r.facts.sink]);
  assert.equal(p.steps[0].admin, false);
  assert.equal(r.support.level, 'native');
  assertAllowed(r);
});

test('USB headset already the default output: no plan', async () => {
  const sink = 'alsa_output.usb-C-Media_Electronics_Inc._USB_Audio_Device-00.analog-stereo';
  const run = fakeRun([
    ['cat /proc/asound/cards', fixture('usbb-asound-cards.txt')],
    ['aplay -l', fixture('usbb-aplay-l.txt')],
    ['arecord -l', fixture('usbb-arecord-l.txt')],
    ['pactl list short sinks', fixture('usbb-pactl-sinks.txt')],
    ['pactl info', `Default Sink: ${sink}\n`],
  ]);
  const r = await diagnose(headset(), { platform: 'linux', run, manager: apt });
  assert.equal(r.status, 'ok');
  assert.equal(r.plans.length, 0);
  assert.equal(r.checks.find((c) => c.id === 'default-output').status, 'pass');
});

test('two identical-looking sinks: no default-sink plan rather than a guess', async () => {
  const sinks = fixture('usbb-pactl-sinks.txt') + '62\talsa_output.usb-C-Media_Electronics_Inc._USB_Audio_Device-00.iec958-stereo\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED\n';
  const run = fakeRun([
    ['cat /proc/asound/cards', fixture('usbb-asound-cards.txt')],
    ['aplay -l', fixture('usbb-aplay-l.txt')],
    ['arecord -l', fixture('usbb-arecord-l.txt')],
    ['pactl list short sinks', sinks],
  ]);
  const r = await diagnose(headset(), { platform: 'linux', run, manager: apt });
  assert.equal(r.plans.length, 0);
});

test('USB audio with no driver on Linux: load snd-usb-audio', async () => {
  const r = await diagnose(headset(null), { platform: 'linux', run: fakeRun([]), manager: apt });
  assert.equal(r.status, 'broken');
  assert.deepEqual(r.plans[0].steps[0].args, ['snd-usb-audio']);
  assert.equal(r.plans[0].auto, true);
});

test('MIDI controller on Linux: MIDI port found, aconnect fallback when amidi is missing', async () => {
  const base = [
    ['cat /proc/asound/cards', fixture('usbb-asound-cards.txt')],
    ['aplay -l', fixture('usbb-aplay-l.txt')],
    ['arecord -l', fixture('usbb-arecord-l.txt')],
  ];
  let r = await diagnose(nanoKontrol(), { platform: 'linux', run: fakeRun([...base, ['amidi -l', fixture('usbb-amidi-l.txt')]]), manager: apt });
  assert.equal(r.status, 'ok');
  assert.match(r.checks.find((c) => c.id === 'midi').detail, /hw:2,0,0/);
  r = await diagnose(nanoKontrol(), { platform: 'linux', run: fakeRun([...base, ['aconnect -l', fixture('usbb-aconnect-l.txt')]]), manager: apt });
  assert.match(r.checks.find((c) => c.id === 'midi').detail, /client 24/);
  assert.ok(!r.plans.some((p) => p.id === 'set-default-sink'));
});

test('USB headset on macOS: listed by Core Audio, offer Sound settings', async () => {
  const run = fakeRun([['system_profiler SPAudioDataType -json', fixture('usbb-spaudio.json')]]);
  const r = await diagnose(headset('AppleUSBAudioDevice', 'darwin'), { platform: 'darwin', arch: 'arm64', run, manager: null });
  assert.equal(r.status, 'ok');
  assert.equal(r.facts.outputs, 2);
  const p = r.plans.find((x) => x.id === 'sound-settings');
  assert.deepEqual(p.steps[0].args, ['x-apple.systempreferences:com.apple.Sound-Settings.extension']);
  assertAllowed(r);
});

test('USB headset on macOS that Core Audio does not list is broken', async () => {
  const run = fakeRun([['system_profiler SPAudioDataType -json', '{"SPAudioDataType":[{"_items":[{"_name":"MacBook Air Speakers","coreaudio_device_output":2,"coreaudio_device_transport":"coreaudio_device_type_builtin"}]}]}']]);
  const r = await diagnose(headset('AppleUSBAudioDevice', 'darwin'), { platform: 'darwin', arch: 'arm64', run, manager: null });
  assert.equal(r.status, 'broken');
});

test('MIDI-only device on macOS: open Audio MIDI Setup', async () => {
  const r = await diagnose(nanoKontrol('darwin'), { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.plans[0].steps[0].args, ['-a', 'Audio MIDI Setup']);
});

test('vendor-specific audio interface without driver on macOS needs the maker driver', async () => {
  const d = usb({ vendorId: '07fd', productId: '0001', vendorName: 'MOTU', productName: 'Audio Interface', deviceClass: 'ff', interfaces: [itf('00', 'ff', '00', '00', null)] }, 'darwin');
  assert.equal(familyFor(d).id, 'audio');
  const r = await diagnose(d, { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.support.level, 'vendor-driver');
  assert.match(r.plans[0].steps[0].explain, /lower your Mac's security settings, stop/);
});

test('Windows sound device with an error: re-scan; without: Sound settings', async () => {
  const bad = { ...headset(null, 'win32'), problem: { code: 10, message: 'The device cannot start (Code 10).' } };
  let r = await diagnose(bad, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'broken');
  assert.deepEqual(r.plans[0].steps[0].args, ['/scan-devices']);
  r = await diagnose(headset('usbaudio', 'win32'), { platform: 'win32', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.plans[0].steps[0].args, ['ms-settings:sound']);
});

// ---------------------------------------------------------------- input

test('keyboard with a media-key interface is a working keyboard', async () => {
  const r = await diagnose(keyboard(), { platform: 'linux', run: fakeRun([]), manager: apt });
  assert.equal(r.category, 'input');
  assert.equal(r.status, 'ok');
  assert.equal(r.facts.kind, 'keyboard');
  assert.equal(r.support.level, 'native');
});

test('Xbox 360 controller: unsupported on a Mac with Apple silicon, native on Linux', async () => {
  let r = await diagnose(xbox360(null, 'darwin'), { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'broken');
  assert.equal(r.support.level, 'unsupported');
  assert.match(r.support.label, /Apple silicon/);
  assert.match(r.support.note, /DualSense/);
  assert.equal(r.plans.length, 0);
  r = await diagnose(xbox360(), { platform: 'linux', run: fakeRun([]), manager: apt });
  assert.equal(r.status, 'ok');
  assert.equal(r.support.level, 'native');
  assert.equal(r.recipes[0].id, 'xbox-360-wired-controller');
});

test('Xbox controller with no driver on Linux: load xpad', async () => {
  const r = await diagnose(xbox360(null), { platform: 'linux', run: fakeRun([]), manager: apt });
  assert.equal(r.status, 'broken');
  assert.deepEqual([r.plans[0].steps[0].cmd, ...r.plans[0].steps[0].args], ['modprobe', 'xpad']);
  assert.equal(r.plans[0].auto, true);
});

test('third-party Xbox 360-style pad is unsupported on macOS too', async () => {
  const pad = usb({ vendorId: '0e6f', productId: '0001', productName: 'Wired Controller', interfaces: [itf('00', 'ff', '5d', '01', null)] }, 'darwin');
  assert.equal(familyFor(pad).id, 'input');
  const r = await diagnose(pad, { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.equal(r.support.level, 'unsupported');
});

test('Xbox Wireless Controller over USB on macOS with no driver: pair over Bluetooth', async () => {
  const d = usb({ vendorId: '045e', productId: '0b12', vendorName: 'Microsoft', productName: 'Controller', deviceClass: 'ff', interfaces: [itf('00', 'ff', '47', 'd0', null)] }, 'darwin');
  const r = await diagnose(d, { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.support.level, 'native');
  assert.match(r.plans[0].steps[0].explain, /pair button/);
});

test('DualShock 4: input, native on macOS, Steam note on Windows', async () => {
  let r = await diagnose(dualshock4('darwin'), { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.equal(r.category, 'input');
  assert.equal(r.status, 'ok');
  assert.equal(r.support.level, 'native');
  r = await diagnose(dualshock4('win32'), { platform: 'win32', run: fakeRun([]), manager: null });
  assert.match(r.support.note, /Steam/);
});

test('Wacom tablet: maker driver on macOS, built in on Linux', async () => {
  const tablet = (platform) => usb({ vendorId: '056a', productId: '0374', vendorName: 'Wacom Co.,Ltd.', productName: 'Intuos S', interfaces: [itf('00', '03', '00', '00', 'usbhid')] }, platform);
  let r = await diagnose(tablet('darwin'), { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'ok');
  assert.equal(r.support.level, 'vendor-driver');
  assert.equal(r.plans[0].id, 'maker-driver');
  assert.equal(r.plans[0].steps[0].kind, 'open-url');
  r = await diagnose(tablet('linux'), { platform: 'linux', run: fakeRun([]), manager: apt });
  assert.equal(r.support.level, 'native');
  assert.equal(r.plans.length, 0);
});

// ---------------------------------------------------------------- network adapters

test('network parsers', () => {
  const links = net.parseIpLink(fixture('usbb-ip-link.txt'));
  assert.deepEqual(links.map((l) => [l.name, l.state]), [['lo', 'UNKNOWN'], ['wlp0s20f3', 'UP'], ['enx00e04c680a1b', 'DOWN']]);
  assert.deepEqual(net.parseHardwarePorts(fixture('usbb-networksetup.txt')).map((p) => p.device), ['en0', 'bridge0', 'en7']);
  assert.deepEqual(net.parseIfconfig(fixture('usbb-ifconfig-en7.txt')), { status: 'active', ipv4: '192.168.1.42' });
  assert.deepEqual(net.parseSysClassNet(''), []);
});

test('RTL8153 on Linux: interface tied to the USB device, cable unplugged', async () => {
  const run = fakeRun([
    ['ls -l /sys/class/net', fixture('usbb-ls-sys-class-net.txt')],
    ['ip -o link show', fixture('usbb-ip-link.txt')],
  ]);
  const r = await diagnose(rtl8153(), { platform: 'linux', run, manager: apt });
  assert.equal(r.category, 'network-adapter');
  assert.deepEqual(r.facts.interfaces, ['enx00e04c680a1b']);
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.checks.find((c) => c.id === 'link').status, 'warn');
  assert.equal(r.recipes[0].id, 'realtek-rtl8152-rtl8153');
});

test('RTL8153 with no driver on Linux: load r8152', async () => {
  const r = await diagnose(rtl8153(null), { platform: 'linux', run: fakeRun([]), manager: apt });
  assert.equal(r.status, 'broken');
  assert.deepEqual(r.plans[0].steps[0].args, ['r8152']);
});

test('USB Ethernet on macOS: interface found by name, link active', async () => {
  const d = usb({ vendorId: '0bda', productId: '8153', productName: 'USB 10/100/1000 LAN', interfaces: [itf('00', '02', '06', '00', 'AppleUserECM'), itf('01', '0a', '00', '00', null)] }, 'darwin');
  const run = fakeRun([
    ['networksetup -listallhardwareports', fixture('usbb-networksetup.txt')],
    ['ifconfig en7', fixture('usbb-ifconfig-en7.txt')],
  ]);
  const r = await diagnose(d, { platform: 'darwin', arch: 'arm64', run, manager: null });
  assert.equal(r.status, 'ok');
  assert.match(r.headline, /en7/);
});

test('USB Wi-Fi dongle: unsupported on Apple silicon, no automatic fix on Linux, re-scan on Windows', async () => {
  let r = await diagnose(wifiDongle(null, 'darwin'), { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'broken');
  assert.equal(r.support.level, 'unsupported');
  assert.match(r.support.note, /built-in Wi-Fi/);
  r = await diagnose(wifiDongle(null), { platform: 'linux', run: fakeRun([]), manager: apt });
  assert.equal(r.status, 'broken');
  assert.equal(r.plans.length, 0);
  assert.match(r.checks.find((c) => c.id === 'chipset').detail, /0bda:8179/);
  const win = { ...wifiDongle(null, 'win32'), problem: { code: 28, message: 'No driver is installed for this device (Code 28).' } };
  r = await diagnose(win, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.deepEqual(r.plans[0].steps[0].args, ['/scan-devices']);
});

// ---------------------------------------------------------------- macOS drives

/** Plist XML from a JS value, for the scenarios that do not have a recorded fixture. */
function toPlist(v) {
  const enc = (x) => {
    if (Array.isArray(x)) return `<array>${x.map(enc).join('')}</array>`;
    if (x === true) return '<true/>';
    if (x === false) return '<false/>';
    if (typeof x === 'number') return `<integer>${x}</integer>`;
    if (x && typeof x === 'object') return `<dict>${Object.entries(x).map(([k, val]) => `<key>${k}</key>${enc(val)}`).join('')}</dict>`;
    return `<string>${String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">${enc(v)}</plist>\n`;
}

const wd = (nodes = ['disk4', 'disk4s1']) =>
  usb({ vendorId: '1058', productId: '25a2', vendorName: 'Western Digital', productName: 'Elements 25A2', interfaces: [itf('00', '08', '06', '50', 'IOUSBMassStorageDriverNub')], nodes }, 'darwin');

test('plist reader: values, entities, and junk', () => {
  const p = storage.parsePlist(fixture('usbb-diskutil-info-disk4s1-ntfs.plist'));
  assert.equal(p.FilesystemType, 'ntfs');
  assert.equal(p.WritableVolume, false);
  assert.equal(p.Size, 1000202043392);
  assert.equal(p.MediaName, '');
  assert.deepEqual(storage.parsePlist('<plist><dict><key>a</key><string>x &amp; &lt;y&gt; &#65;</string><key>b</key><array><real>1.5</real><true/><data> AQI= </data></array></dict></plist>'), { a: 'x & <y> A', b: [1.5, true, 'AQI='] });
  for (const junk of ['', 'not xml', '<plist><dict><key>a</key>', '<plist><dict><string>no key</string></dict></plist>', null, '<plist><array><integer>12</array></plist>']) {
    assert.equal(storage.parsePlist(junk), null, String(junk));
  }
});

test('NTFS drive on macOS: read-only, manual erase step with a warning, never automatic', async () => {
  const run = fakeRun([
    ['diskutil list -plist external physical', fixture('usbb-diskutil-list-ntfs.plist')],
    ['diskutil info -plist disk4', fixture('usbb-diskutil-info-disk4.plist')],
    ['diskutil info -plist disk4s1', fixture('usbb-diskutil-info-disk4s1-ntfs.plist')],
  ]);
  const r = await diagnose(wd(), { platform: 'darwin', arch: 'arm64', run, manager: null });
  assert.equal(r.category, 'storage');
  assert.equal(r.status, 'needs-fix');
  assert.match(r.headline, /cannot write to NTFS/);
  assert.deepEqual(r.facts.volumes[0], { id: 'disk4s1', name: 'BACKUP', type: 'ntfs', filesystem: 'NTFS', content: 'Windows_NTFS', mounted: true, mountPoint: '/Volumes/BACKUP', writable: false, size: '1.0 TB' });
  const p = r.plans.find((x) => x.id === 'ntfs');
  assert.equal(p.auto, false);
  assert.ok(p.steps.every((s) => s.kind === 'manual' || (s.cmd === 'open' && s.args[0] === '-a')));
  assert.match(p.steps.at(-1).title, /erases everything/);
  assertAllowed(r);
});

test('unmounted exFAT volume on macOS: Disk Utility mount plan, no diskutil command', async () => {
  const list = { AllDisksAndPartitions: [{ DeviceIdentifier: 'disk4', Content: 'GUID_partition_scheme', Size: 64023257088, Partitions: [{ DeviceIdentifier: 'disk4s1', Content: 'EFI', VolumeName: 'EFI', Size: 209715200 }, { DeviceIdentifier: 'disk4s2', Content: 'Microsoft Basic Data', VolumeName: 'STICK', Size: 63811354624 }] }] };
  const run = fakeRun([
    ['diskutil list -plist external physical', toPlist(list)],
    ['diskutil info -plist disk4', toPlist({ DeviceIdentifier: 'disk4', MediaName: 'SanDisk Ultra Fit', Size: 64023257088 })],
    ['diskutil info -plist disk4s2', toPlist({ DeviceIdentifier: 'disk4s2', FilesystemType: 'exfat', FilesystemName: 'ExFAT', MountPoint: '', VolumeName: 'STICK', WritableVolume: false, Size: 63811354624 })],
  ]);
  const d = usb({ vendorId: '0781', productId: '5583', productName: 'Ultra Fit', interfaces: [itf('00', '08', '06', '50', 'IOUSBMassStorageDriverNub')] }, 'darwin');
  const r = await diagnose(d, { platform: 'darwin', arch: 'arm64', run, manager: null });
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.facts.volumes.length, 1, 'the EFI partition is not reported');
  const p = r.plans.find((x) => x.id === 'mount');
  assert.deepEqual([p.steps[0].cmd, ...p.steps[0].args], ['open', '-a', 'Disk Utility']);
  assert.equal(p.steps[1].kind, 'manual');
  assert.ok(!run.calls.some((c) => c.startsWith('diskutil mount')));
  assertAllowed(r);
});

test('ext4 drive on macOS: works only through apps, no plan', async () => {
  const list = { AllDisksAndPartitions: [{ DeviceIdentifier: 'disk4', Content: 'GUID_partition_scheme', Partitions: [{ DeviceIdentifier: 'disk4s1', Content: 'Linux Filesystem', Size: 500107862016 }] }] };
  const run = fakeRun([
    ['diskutil list -plist external physical', toPlist(list)],
    ['diskutil info -plist disk4s1', toPlist({ DeviceIdentifier: 'disk4s1', Content: 'Linux Filesystem', MountPoint: '', Size: 500107862016 })],
  ]);
  const r = await diagnose(wd(), { platform: 'darwin', arch: 'arm64', run, manager: null });
  assert.equal(r.support.level, 'app');
  assert.equal(r.plans.length, 0);
  assert.match(r.headline, /Linux/);
});

test('blank drive on macOS: manual format step with an erase warning', async () => {
  const run = fakeRun([
    ['diskutil list -plist external physical', toPlist({ AllDisksAndPartitions: [{ DeviceIdentifier: 'disk4', Content: '', Size: 1000204886016 }] })],
    ['diskutil info -plist disk4', toPlist({ DeviceIdentifier: 'disk4', Content: '', MediaName: 'WD Elements 25A2' })],
  ]);
  const r = await diagnose(wd(['disk4']), { platform: 'darwin', arch: 'arm64', run, manager: null });
  assert.equal(r.status, 'needs-fix');
  const p = r.plans.find((x) => x.id === 'format');
  assert.match(p.steps[1].explain, /^Warning: erasing deletes everything/);
  assert.equal(p.auto, false);
});

test('APFS drive on macOS: volumes read from the container, system volumes skipped', async () => {
  const physical = { AllDisksAndPartitions: [{ DeviceIdentifier: 'disk4', Content: 'GUID_partition_scheme', Partitions: [{ DeviceIdentifier: 'disk4s1', Content: 'EFI' }, { DeviceIdentifier: 'disk4s2', Content: 'Apple_APFS' }] }] };
  const all = {
    AllDisksAndPartitions: [
      physical.AllDisksAndPartitions[0],
      { DeviceIdentifier: 'disk5', Content: 'Apple_APFS_Container', APFSPhysicalStores: [{ DeviceIdentifier: 'disk4s2' }], APFSVolumes: [{ DeviceIdentifier: 'disk5s1', VolumeName: 'Backups', MountPoint: '/Volumes/Backups' }, { DeviceIdentifier: 'disk5s2', VolumeName: 'Preboot' }] },
    ],
  };
  const run = fakeRun([
    ['diskutil list -plist external physical', toPlist(physical)],
    ['diskutil list -plist external', toPlist(all)],
    ['diskutil info -plist disk5s1', toPlist({ FilesystemType: 'apfs', FilesystemName: 'APFS', MountPoint: '/Volumes/Backups', VolumeName: 'Backups', WritableVolume: true, Size: 2000000000000 })],
  ]);
  const r = await diagnose(wd(), { platform: 'darwin', arch: 'arm64', run, manager: null });
  assert.equal(r.status, 'ok');
  assert.equal(r.headline, 'Ready at /Volumes/Backups.');
  assert.deepEqual(r.facts.volumes.map((v) => v.id), ['disk5s1']);
});

test('macOS without readable diskutil output falls back to the mount table', async () => {
  const run = fakeRun([['mount', '/dev/disk4s1 on /Volumes/STICK (exfat, local, nodev, nosuid, noowners)\n']]);
  const r = await diagnose(wd(), { platform: 'darwin', arch: 'arm64', run, manager: null });
  assert.equal(r.status, 'ok');
  assert.equal(r.headline, 'The drive is mounted.');
});
