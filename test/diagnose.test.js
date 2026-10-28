'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnose } = require('../src/core/diagnose');
const { finalize } = require('../src/core/usb');
const { fixture, fakeRun } = require('./helpers');

const apt = { id: 'apt', bin: 'apt-get', install: (p) => ['apt-get', ['install', '-y', ...p]] };

function device(over) {
  return finalize(
    {
      vendorId: '03f0',
      productId: '2b17',
      vendorName: 'Hewlett-Packard',
      productName: 'HP LaserJet 1020',
      serial: 'FN16VR6',
      deviceClass: '00',
      interfaces: [{ number: '00', class: '07', subclass: '01', protocol: '02', driver: 'usblp', nodes: ['lp0'] }],
      nodes: ['lp0'],
      driver: { bound: true, names: ['usblp'], unboundInterfaces: [] },
      ...over,
    },
    'linux',
  );
}

const brother = () =>
  device({
    vendorId: '04f9',
    productId: '0042',
    vendorName: 'Brother',
    productName: 'HL-L2350DW series',
    serial: 'E78123A9N123456',
  });

test('host-based HP LaserJet 1020 on Linux: install HPLIP + firmware plugin', async () => {
  const run = fakeRun([
    ['lpstat -v', ''],
    ['lpinfo --include-schemes usb -l -v', fixture('lpinfo-v.txt')],
    ['lpinfo -m', fixture('lpinfo-m.txt')],
  ]);
  const r = await diagnose(device(), { platform: 'linux', run, manager: apt });
  assert.equal(r.category, 'printer');
  assert.equal(r.status, 'needs-fix');
  assert.deepEqual(r.facts.languages, ['hostbased']);
  const [p] = r.plans;
  assert.match(p.title, /Install the driver/);
  assert.deepEqual(p.steps.map((s) => s.kind), ['command', 'manual', 'manual']);
  assert.deepEqual(p.steps[0].args, ['install', '-y', 'hplip']);
  assert.match(p.steps[1].explain, /hp-plugin -i/);
});

test('host-based printer with no recipe for this OS is reported as broken, with notes', async () => {
  const run = fakeRun([
    ['lpstat -v', ''],
    ['lpinfo --include-schemes usb -l -v', fixture('lpinfo-v.txt')],
    ['lpinfo -m', fixture('lpinfo-m.txt')],
  ]);
  const r = await diagnose({ ...device(), platform: 'darwin' }, { platform: 'darwin', run, manager: null });
  assert.equal(r.status, 'broken');
  assert.equal(r.plans.length, 0);
  assert.match(r.recipes[0].notes, /assistant/);
});

test('a PCL 6 printer with no vendor driver gets the generic PCL 6 driver', async () => {
  const run = fakeRun([
    ['lpstat -v', ''],
    ['lpinfo --include-schemes usb -l -v', fixture('lpinfo-v.txt')],
    ['lpinfo -m', fixture('lpinfo-m.txt')],
  ]);
  const r = await diagnose(brother(), { platform: 'linux', run, manager: apt });
  assert.equal(r.status, 'needs-fix');
  const [best] = r.plans;
  assert.equal(best.id, 'setup-generic-pclxl');
  assert.equal(best.auto, true);
  const add = best.steps.find((s) => s.cmd === 'lpadmin');
  assert.deepEqual(add.args.slice(0, 5), ['-p', 'HL-L2350DW_series', '-E', '-v', 'usb://Brother/HL-L2350DW%20series?serial=E78123A9N123456']);
  assert.match(add.args[6], /pxlmono/);
  assert.equal(add.admin, true);
});

test('an existing, paused queue is resumed rather than re-created', async () => {
  const run = fakeRun([
    ['lpstat -v', 'device for HP_LaserJet_1020: usb://HP/LaserJet%201020?serial=FN16VR6\n'],
    ['lpinfo --include-schemes usb -l -v', fixture('lpinfo-v.txt')],
    ['lpstat -p HP_LaserJet_1020', 'printer HP_LaserJet_1020 disabled since Tue -\n\tPaused\n'],
  ]);
  const r = await diagnose(device(), { platform: 'linux', run, manager: apt });
  assert.equal(r.status, 'needs-fix');
  assert.deepEqual(r.plans[0].steps.map((s) => s.cmd), ['cupsenable', 'cupsaccept']);
  assert.ok(!run.calls.includes('lpinfo -m'), 'no slow driver scan when the queue exists');
});

test('a working queue is reported ready', async () => {
  const run = fakeRun([
    ['lpstat -v', 'device for HP_LaserJet_1020: usb://HP/LaserJet%201020?serial=FN16VR6\n'],
    ['lpinfo --include-schemes usb -l -v', fixture('lpinfo-v.txt')],
    ['lpstat -p HP_LaserJet_1020', 'printer HP_LaserJet_1020 is idle.  enabled since Tue\n'],
  ]);
  const r = await diagnose(device(), { platform: 'linux', run, manager: apt });
  assert.equal(r.status, 'ok');
  assert.match(r.headline, /HP_LaserJet_1020/);
});

test('no CUPS on Linux: offer to install it', async () => {
  const r = await diagnose(device(), { platform: 'linux', run: fakeRun([]), manager: apt });
  assert.equal(r.status, 'broken');
  assert.deepEqual(r.plans[0].steps[0].args, ['install', '-y', 'cups']);
});

test('Windows printer with Code 28 gets driver plans', async () => {
  const d = { ...device({ driver: { bound: false, names: [], unboundInterfaces: [] }, problem: { code: 28, message: 'No driver is installed for this device (Code 28).' } }), platform: 'win32' };
  const r = await diagnose(d, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'broken');
  assert.deepEqual(r.plans.map((p) => p.id), ['windows-update', 'windows-class-driver']);
});

const ch340 = (over = {}) =>
  finalize(
    {
      vendorId: '1a86',
      productId: '7523',
      productName: 'USB2.0-Serial',
      deviceClass: 'ff',
      interfaces: [{ number: '00', class: 'ff', subclass: '01', protocol: '02', driver: null, nodes: [] }],
      nodes: [],
      driver: { bound: false, names: [], unboundInterfaces: ['00'] },
      ...over,
    },
    'linux',
  );

test('CH340 stolen by brltty on Ubuntu', async () => {
  const run = fakeRun([['systemctl list-unit-files brltty-udev.service --no-legend', 'brltty-udev.service static      -\n']]);
  const r = await diagnose(ch340(), { platform: 'linux', run, manager: apt });
  assert.equal(r.category, 'serial');
  assert.equal(r.plans[0].id, 'disable-brltty-udev');
  assert.match(r.recipes[0].notes, /brltty/);
});

test('CH340 with brltty installed but masked is not blamed', async () => {
  const run = fakeRun([['systemctl list-unit-files brltty-udev.service --no-legend', 'brltty-udev.service masked      -\n']]);
  const r = await diagnose(ch340(), { platform: 'linux', run, manager: apt });
  assert.ok(!r.plans.some((p) => p.id === 'disable-brltty-udev'));
});

test('CH340 with a port the user cannot open', async () => {
  const run = fakeRun([
    ['stat -c %G /dev/ttyUSB0', 'dialout\n'],
    ['id -nG', 'alice sudo\n'],
  ]);
  const d = ch340({ nodes: ['ttyUSB0'], driver: { bound: true, names: ['ch341'], unboundInterfaces: [] } });
  const r = await diagnose(d, { platform: 'linux', run, manager: apt });
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.plans[0].steps[0].cmd, 'usermod');
  assert.deepEqual(r.plans[0].steps[0].args.slice(0, 2), ['-aG', 'dialout']);
});

test('USB stick that is not mounted', async () => {
  const lsblk = JSON.stringify({
    blockdevices: [
      { name: 'nvme0n1', tran: 'nvme', fstype: null, children: [{ name: 'nvme0n1p1', fstype: 'ext4', mountpoint: '/' }] },
      { name: 'sdb', tran: 'usb', size: '29.3G', serial: '4C530001230925111234', fstype: null, children: [{ name: 'sdb1', fstype: 'exfat', mountpoint: null, label: 'STICK' }] },
    ],
  });
  const run = fakeRun([[/^lsblk /, lsblk]]);
  const d = finalize(
    { vendorId: '0781', productId: '5583', productName: 'Ultra Fit', serial: '4C530001230925111234', deviceClass: '00', interfaces: [{ class: '08', subclass: '06', protocol: '50', driver: 'usb-storage' }], nodes: [], driver: { bound: true, names: ['usb-storage'], unboundInterfaces: [] } },
    'linux',
  );
  const r = await diagnose(d, { platform: 'linux', run, manager: apt });
  assert.equal(r.category, 'storage');
  assert.equal(r.status, 'needs-fix');
  assert.deepEqual(r.plans[0].steps[0].args, ['mount', '-b', '/dev/sdb1']);
});

test('vendor-specific device with no driver points to reverse engineering', async () => {
  const d = finalize(
    { vendorId: 'abcd', productId: '1234', productName: 'Mystery Gadget', deviceClass: 'ff', interfaces: [{ number: '00', class: 'ff', driver: null }], nodes: [], driver: { bound: false, names: [], unboundInterfaces: ['00'] } },
    'linux',
  );
  const r = await diagnose(d, { platform: 'linux', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'broken');
  assert.match(r.headline, /Under the hood/);
});
