'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bt = require('../src/core/sources/bluetooth');
const { family } = require('../src/core/families/bluetooth');
const { diagnose } = require('../src/core/diagnose');
const { familyFor } = require('../src/core/families');
const { validateStep } = require('../src/core/fix/runner');
const { fixture, fakeRun } = require('./helpers');

const apt = { id: 'apt', bin: 'apt-get', install: (p) => ['apt-get', ['install', '-y', ...p]] };
const byId = (devices, id) => devices.find((d) => d.id === id);

/** Every command step must be one the fix runner accepts. */
function assertRunnable(result) {
  for (const p of result.plans) {
    for (const s of p.steps) {
      assert.ok(validateStep(s).ok, `${p.id}: ${s.cmd} is not allowed`);
      if (s.kind === 'command') assert.ok(Array.isArray(s.args), `${p.id}: args`);
    }
  }
}

async function check(device, platform, run = fakeRun([])) {
  const r = await diagnose(device, { platform, arch: 'arm64', run, manager: platform === 'linux' ? apt : null });
  assertRunnable(r);
  return r;
}

// ---------------------------------------------------------------- macOS

const macRun = (file = 'bluetooth-macos.json') => fakeRun([['system_profiler SPBluetoothDataType -json', fixture(file)]]);

test('macos: controller plus paired devices, with batteries, kinds and IDs', async () => {
  const devices = await bt.source.list({ platform: 'darwin', run: macRun() });
  assert.deepEqual(devices.map((d) => d.id), ['bluetooth:controller', 'bluetooth:AC:90:85:4D:5E:6F', 'bluetooth:3C:22:FB:98:76:54', 'bluetooth:F4:6A:DD:01:23:45']);
  const ctl = devices[0];
  assert.equal(ctl.displayName, 'Bluetooth (this computer)');
  assert.equal(ctl.source, 'bluetooth');
  assert.deepEqual(
    { present: ctl.details.present, powered: ctl.details.powered, chipset: ctl.details.chipset, address: ctl.details.address, connected: ctl.details.connectedCount, paired: ctl.details.pairedCount },
    { present: true, powered: true, chipset: 'BCM_4387', address: 'F0:B3:EC:1A:2B:3C', connected: 1, paired: 3 },
  );
  const pods = devices[1];
  assert.equal(pods.displayName, 'AirPods Pro');
  assert.deepEqual(pods.categories, ['bluetooth', 'headphones']);
  assert.deepEqual(pods.details.battery, { left: 100, right: 98, case: 45 });
  assert.equal(pods.details.connected, true);
  assert.equal(pods.details.vendorId, '004c');
  assert.equal(pods.details.productId, '2014');
  assert.equal(pods.details.controller.powered, true);
  const kb = byId(devices, 'bluetooth:F4:6A:DD:01:23:45');
  assert.equal(kb.details.kind, 'keyboard');
  assert.equal(kb.details.connected, false);
  assert.equal(kb.details.paired, true);
  assert.equal(byId(devices, 'bluetooth:3C:22:FB:98:76:54').details.kind, 'phone', 'kind from the name when there is no type');
});

test('macos: parsers survive junk and older shapes', () => {
  for (const junk of ['', 'not json', '{}', '[]', 'null', '{"SPBluetoothDataType":"x"}', '{"SPBluetoothDataType":[{"device_connected":[1,null,"x",{"A":5}]}]}']) {
    const r = bt.parseSystemProfiler(junk);
    assert.ok(Array.isArray(r.devices), junk);
  }
  assert.equal(bt.parseSystemProfiler('{"SPBluetoothDataType":[{}]}').controller.present, false);
  const old = bt.parseSystemProfiler(
    JSON.stringify({
      SPBluetoothDataType: [
        {
          local_device_title: { general_address: '8c-85-90-aa-bb-cc', general_power: 'attrib_On' },
          device_title: [{ 'Magic Mouse': { device_addr: '04-4b-ed-11-22-33', device_isconnected: 'attrib_Yes', device_minorType: 'Mouse' } }],
        },
      ],
    }),
  );
  assert.equal(old.controller.powered, true);
  assert.equal(old.controller.address, '8C:85:90:AA:BB:CC');
  assert.deepEqual([old.devices[0].address, old.devices[0].connected, old.devices[0].kind], ['04:4B:ED:11:22:33', true, 'mouse']);
});

test('macos: a failed system_profiler still lists the controller as unknown', async () => {
  const devices = await bt.source.list({ platform: 'darwin', run: fakeRun([]) });
  assert.equal(devices.length, 1);
  assert.equal(devices[0].details.present, null);
  const r = await check(devices[0], 'darwin');
  assert.equal(r.status, 'unknown');
});

test('macos: working controller and connected AirPods', async () => {
  const devices = await bt.source.list({ platform: 'darwin', run: macRun() });
  const ctl = await check(devices[0], 'darwin');
  assert.equal(ctl.category, 'bluetooth');
  assert.equal(ctl.status, 'ok');
  assert.match(ctl.headline, /1 device connected/);
  assert.equal(ctl.support.level, 'native');

  const pods = await check(devices[1], 'darwin');
  assert.equal(pods.status, 'ok');
  assert.match(pods.headline, /headphones are connected/);
  assert.equal(pods.checks.find((c) => c.id === 'battery').status, 'pass');
  const sound = pods.plans.find((p) => p.id === 'audio-output');
  assert.deepEqual(sound.steps[0].args, ['x-apple.systempreferences:com.apple.preference.sound']);
  assert.ok(!pods.checks.some((c) => c.id === 'driver-bound' && c.status === 'fail'));
});

test('macos: paired keyboard not connected gets reconnect and pair-again plans', async () => {
  const devices = await bt.source.list({ platform: 'darwin', run: macRun() });
  const r = await check(byId(devices, 'bluetooth:F4:6A:DD:01:23:45'), 'darwin');
  assert.equal(r.status, 'idle');
  assert.match(r.headline, /Magic Keyboard is paired but not connected/);
  assert.deepEqual(r.plans.map((p) => p.id), ['reconnect', 'pair-again']);
  const open = r.plans[0].steps.find((s) => s.kind === 'command');
  assert.deepEqual([open.cmd, ...open.args], ['open', 'x-apple.systempreferences:com.apple.BluetoothSettings']);
  assert.ok(r.plans.every((p) => !p.auto));
});

test('macos: Bluetooth switched off', async () => {
  const devices = await bt.source.list({ platform: 'darwin', run: macRun('bluetooth-macos-off.json') });
  const ctl = await check(devices[0], 'darwin');
  assert.equal(ctl.status, 'needs-fix');
  assert.equal(ctl.plans[0].id, 'turn-on');
  assert.deepEqual(ctl.plans[0].steps.map((s) => s.kind), ['command', 'manual']);
  assert.equal(ctl.plans[0].auto, false);
  const pods = await check(devices[1], 'darwin');
  assert.equal(pods.status, 'needs-fix');
  assert.match(pods.headline, /switched off on this computer/);
  assert.equal(pods.plans[0].id, 'turn-on');
});

// ---------------------------------------------------------------- Linux

function linuxRun(over = []) {
  return fakeRun([
    ...over,
    ['systemctl is-active bluetooth', 'active\n'],
    ['rfkill list bluetooth', fixture('bluetooth-linux-rfkill.txt')],
    ['bluetoothctl --version', 'bluetoothctl: 5.72\n'],
    ['bluetoothctl show', fixture('bluetooth-linux-show.txt')],
    ['bluetoothctl devices Paired', fixture('bluetooth-linux-devices.txt')],
    ['bluetoothctl info AC:90:85:4D:5E:6F', fixture('bluetooth-linux-info-headphones.txt')],
    ['bluetoothctl info C8:3F:26:11:22:33', fixture('bluetooth-linux-info-mouse.txt')],
    ['bluetoothctl info E4:17:D8:AA:BB:CC', fixture('bluetooth-linux-info-stranger.txt')],
    ['pactl list short sinks', fixture('bluetooth-linux-pactl-sinks.txt')],
    ['pactl info', fixture('bluetooth-linux-pactl-info.txt')],
  ]);
}

test('linux parsers', () => {
  assert.deepEqual(bt.parseBluetoothctlShow(fixture('bluetooth-linux-show.txt')), { present: true, address: '00:1A:7D:DA:71:13', name: 'thinkpad', powered: true, powerState: 'on' });
  assert.equal(bt.parseBluetoothctlShow('No default controller available\n').present, false);
  assert.equal(bt.parseBluetoothctlShow('').present, null);
  const info = bt.parseBluetoothctlInfo(fixture('bluetooth-linux-info-headphones.txt'));
  assert.deepEqual(
    [info.name, info.icon, info.paired, info.connected, info.trusted, info.blocked, info.battery, info.vendorId, info.productId, info.uuids.length],
    ['WH-1000XM4', 'audio-headset', true, true, true, false, 70, '054c', '0d58', 5],
  );
  assert.equal(bt.parseBluetoothctlInfo('Device AA:BB:CC:DD:EE:FF not available\n'), null);
  assert.deepEqual(bt.parseBluetoothctlDevices('\x1b[0;94m[bluetooth]\x1b[0m# junk\r\nDevice AA:BB:CC:DD:EE:01 Thing\r\nDevice AA:BB:CC:DD:EE:02\n'), [
    { address: 'AA:BB:CC:DD:EE:01', name: 'Thing' },
    { address: 'AA:BB:CC:DD:EE:02', name: null },
  ]);
  const rf = bt.parseRfkill('0: hci0: Bluetooth\n\tSoft blocked: no\n\tHard blocked: no\n1: phy0: Wireless LAN\n\tSoft blocked: yes\n\tHard blocked: no\n2: tpacpi_bluetooth_sw: Bluetooth\n\tSoft blocked: no\n\tHard blocked: yes\n');
  assert.deepEqual([rf.entries.length, rf.softBlocked, rf.hardBlocked], [2, false, true]);
  assert.deepEqual(bt.parseRfkill(''), { entries: [], softBlocked: null, hardBlocked: null });
});

test('linux: controller and paired devices; strangers nearby are left out', async () => {
  const run = linuxRun();
  const devices = await bt.source.list({ platform: 'linux', run });
  assert.deepEqual(devices.map((d) => d.id), ['bluetooth:controller', 'bluetooth:AC:90:85:4D:5E:6F', 'bluetooth:C8:3F:26:11:22:33']);
  const [ctl, phones, mouse] = devices;
  assert.deepEqual([ctl.details.powered, ctl.details.serviceActive, ctl.details.softBlocked, ctl.details.address], [true, true, false, '00:1A:7D:DA:71:13']);
  assert.deepEqual([phones.details.kind, phones.details.connected, phones.details.battery], ['headset', true, { main: 70 }]);
  assert.deepEqual([mouse.details.kind, mouse.details.connected, mouse.details.trusted, mouse.details.battery], ['mouse', false, false, { main: 10 }]);
  assert.equal(mouse.details.vendorId, '046d');
});

test('linux: connected headset whose sound goes elsewhere gets a pactl fix', async () => {
  const run = linuxRun();
  const devices = await bt.source.list({ platform: 'linux', run });
  const r = await check(devices[1], 'linux', run);
  assert.equal(r.status, 'ok');
  assert.equal(r.checks.find((c) => c.id === 'audio-output').status, 'warn');
  const p = r.plans.find((x) => x.id === 'audio-output');
  assert.deepEqual([p.steps[0].cmd, ...p.steps[0].args], ['pactl', 'set-default-sink', 'bluez_output.AC_90_85_4D_5E_6F.1']);
});

test('linux: headset that already plays sound needs nothing', async () => {
  const run = linuxRun([['pactl info', 'Default Sink: bluez_output.AC_90_85_4D_5E_6F.1\n']]);
  const devices = await bt.source.list({ platform: 'linux', run });
  const r = await check(devices[1], 'linux', run);
  assert.equal(r.checks.find((c) => c.id === 'audio-output').status, 'pass');
  assert.equal(r.plans.length, 0);
});

test('linux: paired mouse, not connected, low battery: trust and connect', async () => {
  const run = linuxRun();
  const devices = await bt.source.list({ platform: 'linux', run });
  const r = await check(devices[2], 'linux', run);
  assert.equal(r.status, 'idle');
  const reconnect = r.plans.find((p) => p.id === 'reconnect');
  assert.deepEqual(reconnect.steps.filter((s) => s.kind === 'command').map((s) => [s.cmd, ...s.args].join(' ')), ['bluetoothctl trust C8:3F:26:11:22:33', 'bluetoothctl connect C8:3F:26:11:22:33']);
  assert.ok(r.plans.find((p) => p.id === 'pair-again').steps.every((s) => s.kind === 'manual'), 'removing a pairing is never automatic');
});

test('linux: low battery on a connected device warns', async () => {
  const run = linuxRun([['bluetoothctl info C8:3F:26:11:22:33', fixture('bluetooth-linux-info-mouse.txt').replace('Connected: no', 'Connected: yes')]]);
  const devices = await bt.source.list({ platform: 'linux', run });
  const r = await check(devices.find((d) => d.details.kind === 'mouse'), 'linux', run);
  assert.equal(r.status, 'ok');
  assert.equal(r.checks.find((c) => c.id === 'battery').status, 'warn');
  assert.match(r.headline, /battery is low \(Battery 10%\)/);
});

test('linux: soft-blocked radio is unblocked, then powered on', async () => {
  const run = linuxRun([
    ['rfkill list bluetooth', fixture('bluetooth-linux-rfkill-soft.txt')],
    ['bluetoothctl show', fixture('bluetooth-linux-show-off.txt')],
  ]);
  const devices = await bt.source.list({ platform: 'linux', run });
  assert.equal(devices[0].details.powered, false);
  const r = await check(devices[0], 'linux', run);
  assert.equal(r.status, 'needs-fix');
  const steps = r.plans[0].steps;
  assert.deepEqual(steps.map((s) => [s.cmd, ...s.args].join(' ')), ['rfkill unblock bluetooth', 'bluetoothctl power on']);
  assert.equal(steps[0].admin, true);
  const mouse = await check(devices.find((d) => d.details.kind === 'mouse'), 'linux', run);
  assert.equal(mouse.plans[0].id, 'turn-on');
});

test('linux: hard block asks for the switch first', async () => {
  const run = linuxRun([['rfkill list bluetooth', '0: hci0: Bluetooth\n\tSoft blocked: no\n\tHard blocked: yes\n']]);
  const devices = await bt.source.list({ platform: 'linux', run });
  const r = await check(devices[0], 'linux', run);
  assert.equal(r.checks.find((c) => c.id === 'rfkill').status, 'fail');
  assert.deepEqual(r.plans[0].steps.map((s) => s.kind), ['manual', 'command', 'command']);
});

test('linux: stopped service is started, and bluetoothctl is not asked (it would hang)', async () => {
  const run = linuxRun([['systemctl is-active bluetooth', { ok: false, code: 3, stdout: 'inactive\n' }]]);
  const devices = await bt.source.list({ platform: 'linux', run });
  assert.ok(!run.calls.includes('bluetoothctl show'));
  assert.equal(devices.length, 1);
  const r = await check(devices[0], 'linux', run);
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.checks.find((c) => c.id === 'service').status, 'fail');
  assert.deepEqual(r.plans[0].steps.map((s) => [s.cmd, ...s.args].join(' ')), ['systemctl start bluetooth', 'systemctl enable bluetooth', 'bluetoothctl power on']);
});

test('linux: BlueZ not installed', async () => {
  const run = fakeRun([
    ['systemctl is-active bluetooth', { ok: false, code: 3, stdout: 'inactive\n' }],
    ['rfkill list bluetooth', fixture('bluetooth-linux-rfkill.txt')],
  ]);
  const devices = await bt.source.list({ platform: 'linux', run });
  const r = await check(devices[0], 'linux', run);
  assert.equal(r.status, 'broken');
  assert.equal(r.plans[0].id, 'install-bluez');
  assert.deepEqual(r.plans[0].steps[0].args, ['install', '-y', 'bluez']);
});

test('linux: a computer with no Bluetooth adapter shows nothing, rather than a fix to install BlueZ', async () => {
  const run = linuxRun([
    ['rfkill list bluetooth', ''],
    ['bluetoothctl show', { ok: false, code: 1, stdout: 'No default controller available\n' }],
  ]);
  assert.deepEqual(await bt.source.list({ platform: 'linux', run, bluetoothSysfs: '/nonexistent' }), []);
});

test('linux: the kernel sees an adapter but no tools are installed', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-bt-'));
  fs.mkdirSync(path.join(root, 'hci0'));
  const run = fakeRun([['systemctl is-active bluetooth', { ok: false, code: 3, stdout: 'inactive\n' }]]);
  const [controller] = await bt.source.list({ platform: 'linux', run, bluetoothSysfs: root });
  assert.equal(controller.details.present, true);
  const r = await check(controller, 'linux', run);
  assert.ok(r.plans.some((p) => p.id === 'install-bluez'));
});

test('linux: at most MAX_INFO info calls; old BlueZ without the Paired filter', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `Device AA:BB:CC:DD:EE:${String(i).padStart(2, '0')} Thing ${i}`).join('\n');
  const run = linuxRun([
    ['bluetoothctl devices Paired', { ok: false, code: 1, stdout: 'Too many arguments: 1 > 0\n' }],
    ['bluetoothctl devices', many],
    [/^bluetoothctl info /, (line) => `Device ${line.split(' ')[2]} (public)\n\tName: x\n\tPaired: yes\n\tConnected: no\n`],
  ]);
  const devices = await bt.source.list({ platform: 'linux', run });
  assert.equal(run.calls.filter((c) => c.startsWith('bluetoothctl info')).length, bt.MAX_INFO);
  assert.equal(devices.length, 1 + bt.MAX_INFO);
});

// ---------------------------------------------------------------- Windows

const winRun = (json) => fakeRun([[/^powershell\.exe /, json]]);

test('windows: radio and paired devices; plumbing is left out', async () => {
  const { controller, devices, radios } = bt.parsePnpBluetooth(fixture('bluetooth-windows.json'));
  assert.equal(radios.length, 1);
  assert.equal(controller.chipset, 'Intel(R) Wireless Bluetooth(R)');
  assert.deepEqual(devices.map((d) => [d.name, d.address, d.vendorId, d.productId]), [
    ['WH-1000XM4', 'AC:90:85:4D:5E:6F', '054c', '0d58'],
    ['MX Master 3', 'C8:3F:26:11:22:33', '046d', 'b023'],
  ]);
  assert.equal(devices[1].problem.code, 10, 'a failing service counts against its device');
  assert.deepEqual(bt.parsePnpBluetooth('garbage').devices, []);
  assert.equal(bt.parsePnpBluetooth('').controller.present, false);
});

test('windows: working radio, a device with a problem', async () => {
  const devices = await bt.source.list({ platform: 'win32', run: winRun(fixture('bluetooth-windows.json')) });
  const ctl = await check(devices[0], 'win32');
  assert.equal(ctl.status, 'ok');
  assert.equal(ctl.checks.find((c) => c.id === 'powered').status, 'info');
  const mx = await check(byId(devices, 'bluetooth:C8:3F:26:11:22:33'), 'win32');
  assert.equal(mx.status, 'broken');
  assert.deepEqual(mx.plans[0].steps[0].args, ['/scan-devices']);
  const phones = await check(byId(devices, 'bluetooth:AC:90:85:4D:5E:6F'), 'win32');
  assert.equal(phones.status, 'ok');
  assert.ok(phones.plans.every((p) => p.confidence <= 0.3), 'connection state unknown: plans are only offered');
});

test('windows: disabled radio (Code 22) is enabled again or rescanned', async () => {
  const devices = await bt.source.list({ platform: 'win32', run: winRun(fixture('bluetooth-windows-radio-error.json')) });
  assert.equal(devices.length, 1);
  const r = await check(devices[0], 'win32');
  assert.equal(r.status, 'broken');
  assert.equal(r.checks.find((c) => c.id === 'radio').status, 'fail');
  assert.deepEqual(r.plans.map((p) => p.id), ['windows-enable-radio', 'windows-rescan']);
  assert.match(r.plans[0].steps[0].args[2], /^Enable-PnpDevice -InstanceId 'USB\\VID_0BDA&PID_B00C\\00E04C000001' -Confirm:\$false$/);
  assert.equal(r.plans[1].steps[0].admin, true);
});

test('windows: no radio at all', async () => {
  const devices = await bt.source.list({ platform: 'win32', run: winRun('[]') });
  const r = await check(devices[0], 'win32');
  assert.equal(r.status, 'broken');
  assert.equal(r.support.level, 'unknown');
  assert.ok(r.plans.some((p) => p.id === 'windows-rescan'));
});

// ---------------------------------------------------------------- family

test('family: claims Bluetooth devices only', async () => {
  const [ctl] = await bt.source.list({ platform: 'darwin', run: macRun() });
  assert.equal(family.match(ctl), 80);
  assert.equal(family.match({ source: 'usb', categories: [] }), 0);
  assert.equal(familyFor(ctl).id, 'bluetooth');
});

test('kind from type hints', () => {
  assert.equal(bt.kindOf('Headphones'), 'headphones');
  assert.equal(bt.kindOf('audio-headset'), 'headset');
  assert.equal(bt.kindOf('audio-card'), 'speaker');
  assert.equal(bt.kindOf('input-gaming'), 'controller');
  assert.equal(bt.kindOf('OpenRun Pro'), 'other');
  assert.equal(bt.kindOf(null), 'other');
  assert.equal(bt.normalizeAddress('not an address 12'), null);
  assert.equal(bt.percent('0x5a (90)'), 90);
  assert.equal(bt.percent('120%'), null);
});

test('unknown platforms list nothing', async () => {
  assert.deepEqual(await bt.source.list({ platform: 'freebsd', run: fakeRun([]) }), []);
});
