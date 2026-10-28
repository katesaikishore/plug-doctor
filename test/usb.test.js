'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listDevices } = require('../src/core/usb');
const macos = require('../src/core/usb/macos');
const windows = require('../src/core/usb/windows');
const { categoriesFor } = require('../src/core/usb/classes');
const { UsbWatcher } = require('../src/core/usb/watcher');
const { fixture, makeSysfs, fakeRun } = require('./helpers');

test('linux: reads devices, interfaces, drivers and device nodes from sysfs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sysfs-'));
  const sysfsRoot = makeSysfs(tmp, {
    usb1: { idVendor: '1d6b', idProduct: '0002', bDeviceClass: '09' },
    '1-1': { idVendor: '03f0', idProduct: '2b17', manufacturer: 'Hewlett-Packard', product: 'HP LaserJet 1020', serial: 'FN16VR6', bDeviceClass: '00', busnum: '1', devnum: '4' },
    '1-1:1.0': { bInterfaceNumber: '00', bInterfaceClass: '07', bInterfaceSubClass: '01', bInterfaceProtocol: '02', driver: 'usblp', nodes: ['usbmisc/lp0'] },
    '1-2': { idVendor: '1a86', idProduct: '7523', product: 'USB2.0-Serial', bDeviceClass: 'ff', busnum: '1', devnum: '5' },
    '1-2:1.0': { bInterfaceNumber: '00', bInterfaceClass: 'ff', bInterfaceSubClass: '01', bInterfaceProtocol: '02' },
  });
  const devices = await listDevices({ platform: 'linux', sysfsRoot });
  assert.equal(devices.length, 2, 'root hub is hidden');
  const printer = devices.find((d) => d.productId === '2b17');
  assert.equal(printer.id, '03f0:2b17:FN16VR6');
  assert.deepEqual(printer.categories, ['printer']);
  assert.equal(printer.driver.bound, true);
  assert.deepEqual(printer.driver.names, ['usblp']);
  assert.deepEqual(printer.nodes, ['lp0']);
  const serial = devices.find((d) => d.vendorId === '1a86');
  assert.equal(serial.driver.bound, false);
  assert.equal(serial.vendorName, 'QinHeng (WCH)', 'falls back to the vendor table');
});

test('macos: parses ioreg devices and matches interfaces by location', async () => {
  const run = fakeRun([
    ['ioreg -p IOUSB -l -w0', fixture('ioreg-devices.txt')],
    ['ioreg -r -c IOUSBHostInterface -l -w0', fixture('ioreg-interfaces.txt')],
  ]);
  const devices = await listDevices({ platform: 'darwin', run });
  assert.equal(devices.length, 2);
  const [hp, ch340] = devices;
  assert.equal(hp.vendorId, '03f0');
  assert.equal(hp.productId, '2b17');
  assert.equal(hp.serial, 'FN16VR6');
  assert.equal(hp.location, '0x00100000');
  assert.deepEqual(hp.interfaces.map((i) => i.class), ['07']);
  assert.deepEqual(hp.categories, ['printer']);
  assert.equal(ch340.vendorId, '1a86');
  assert.deepEqual(ch340.interfaces.map((i) => i.class), ['ff']);
  assert.equal(macos.parseIoreg('').length, 0);
});

test('windows: folds composite interfaces, keeps problem codes, hides hubs', async () => {
  const run = fakeRun([[/^powershell\.exe /, fixture('pnp.json')]]);
  const devices = await listDevices({ platform: 'win32', run });
  assert.deepEqual(devices.map((d) => d.productName), ['HP LaserJet 1020', 'USB Composite Device']);
  const [hp, mouse] = devices;
  assert.equal(hp.problem.code, 28);
  assert.match(hp.problem.message, /No driver/);
  assert.equal(hp.driver.bound, false);
  assert.deepEqual(hp.categories, ['printer']);
  assert.equal(mouse.interfaces.length, 2);
  assert.deepEqual(mouse.categories, ['input']);
  assert.equal(mouse.serial, null, 'synthetic Windows instance IDs are not serials');
  assert.deepEqual(windows.devicesFromPnp('not json'), []);
});

test('CDC-ACM is serial, other CDC subclasses are network', () => {
  assert.deepEqual(categoriesFor({ deviceClass: '02', interfaces: [{ class: '02', subclass: '02' }, { class: '0a' }] }), ['serial']);
  assert.deepEqual(categoriesFor({ deviceClass: '00', interfaces: [{ class: '02', subclass: '06' }] }), ['network']);
});

test('watcher emits attach and detach', async () => {
  let list = [{ id: 'a', driver: {} }];
  const w = new UsbWatcher({ list: async () => list, intervalMs: 10_000 });
  const events = [];
  w.on('attach', (d) => events.push(`+${d.id}`));
  w.on('detach', (d) => events.push(`-${d.id}`));
  await w.start({ silentInitial: true });
  list = [{ id: 'b', driver: {} }];
  await w.poll();
  w.stop();
  assert.deepEqual(events, ['+b', '-a']);
});

test('display names do not repeat the vendor', () => {
  const { displayName } = require('../src/core/usb');
  assert.equal(displayName('Hewlett-Packard', 'HP LaserJet 1020'), 'HP LaserJet 1020');
  assert.equal(displayName('Brother', 'Brother HL-L2350DW'), 'Brother HL-L2350DW');
  assert.equal(displayName('Brother', 'HL-L2350DW series'), 'Brother HL-L2350DW series');
  assert.equal(displayName(null, 'USB2.0-Serial'), 'USB2.0-Serial');
});

test('watcher emits update when a device changes state', async () => {
  let list = [{ id: 'hp', driver: { bound: false }, details: { connected: false } }];
  const w = new UsbWatcher({ list: async () => list, intervalMs: 10_000 });
  const updates = [];
  w.on('update', (d) => updates.push(d.details.connected));
  await w.start({ silentInitial: true });
  list = [{ id: 'hp', driver: { bound: false }, details: { connected: true } }];
  await w.poll();
  await w.poll();
  w.stop();
  assert.deepEqual(updates, [true]);
});
