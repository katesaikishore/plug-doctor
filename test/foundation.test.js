'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listDevices, finalize } = require('../src/core/usb');
const { supportFor } = require('../src/core/support');
const { familyFor, register, FAMILIES } = require('../src/core/families');
const { diagnose } = require('../src/core/diagnose');
const { createInventory } = require('../src/core/sources');
const { fixture, fakeRun } = require('./helpers');

const usbDev = (over) =>
  finalize({ vendorId: 'abcd', productId: '0001', productName: 'Thing', deviceClass: '00', interfaces: [], nodes: [], driver: { bound: null, names: [], unboundInterfaces: [] }, ...over }, 'darwin');

test('macos: interface drivers and serial ports come from the ioreg tree', async () => {
  const run = fakeRun([
    ['ioreg -p IOUSB -l -w0', fixture('ioreg-devices.txt')],
    ['ioreg -r -c IOUSBHostInterface -l -w0', fixture('ioreg-interfaces-drivers.txt')],
  ]);
  const devices = await listDevices({ platform: 'darwin', run });
  const ch340 = devices.find((d) => d.vendorId === '1a86');
  assert.deepEqual(ch340.driver.names, ['AppleUSBCHCOM']);
  assert.equal(ch340.driver.bound, true);
  assert.deepEqual(ch340.nodes, ['cu.usbserial-1420']);
  const hp = devices.find((d) => d.vendorId === '03f0');
  assert.equal(hp.driver.bound, null, 'no interface dump for it, so unknown');
});

test('a Mac printer with no kernel driver is normal, not a failure', async () => {
  const d = usbDev({ vendorId: '03f0', productId: '2b17', interfaces: [{ number: '0', class: '07', subclass: '01', protocol: '02', driver: null }], driver: { bound: false, names: [], unboundInterfaces: ['0'] } });
  const r = await diagnose(d, { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  const drv = r.checks.find((c) => c.id === 'driver-bound');
  assert.equal(drv.status, 'info');
  assert.equal(r.support.level, 'app');
});

test('support verdicts', () => {
  const ctx = { platform: 'darwin', arch: 'arm64' };
  assert.equal(supportFor(usbDev({ interfaces: [{ class: '03' }] }), ctx).level, 'native');
  assert.equal(supportFor(usbDev({ interfaces: [{ class: '08' }, { class: '03' }] }), ctx).level, 'native');
  assert.equal(supportFor(usbDev({ interfaces: [{ class: 'ff' }], driver: { bound: false } }), ctx).level, 'vendor-driver');
  assert.equal(supportFor(usbDev({ interfaces: [{ class: 'ff' }], driver: { bound: true } }), ctx).level, 'native');
  assert.equal(supportFor(usbDev({ interfaces: [{ class: 'e0' }] }), ctx).level, 'unsupported');
  assert.match(supportFor(usbDev({ interfaces: [{ class: 'e0' }] }), ctx).label, /Apple silicon/);
  const recipe = { support: { 'darwin-arm64': 'unsupported', darwin: 'vendor-driver' } };
  assert.equal(supportFor(usbDev({ interfaces: [{ class: 'ff' }] }), { ...ctx, recipes: [recipe] }).level, 'unsupported');
  assert.equal(supportFor(usbDev({ interfaces: [{ class: 'ff' }] }), { platform: 'darwin', arch: 'x64', recipes: [recipe] }).level, 'vendor-driver');
});

test('families: highest match wins, generic catches the rest, sources are respected', () => {
  assert.equal(familyFor(usbDev({ interfaces: [{ class: '07' }] })).id, 'printer');
  assert.equal(familyFor(usbDev({ vendorId: '1a86' })).id, 'serial');
  assert.equal(familyFor(usbDev({})).id, 'generic');
  register({ id: 'test-fam', label: 'T', icon: 'unknown', sources: ['network'], match: () => 99, diagnose: async () => ({ status: 'ok', headline: 'hi', checks: [], plans: [], facts: {} }) });
  assert.equal(familyFor(usbDev({})).id, 'generic', 'a network family never claims a USB device');
  assert.equal(familyFor({ ...usbDev({}), source: 'network' }).id, 'test-fam');
  FAMILIES.splice(FAMILIES.findIndex((f) => f.id === 'test-fam'), 1);
});

test('a crashing family falls back to generic checks', async () => {
  register({ id: 'boom', label: 'B', icon: 'unknown', sources: ['usb'], match: (d) => (d.productName === 'Boom' ? 100 : 0), diagnose: async () => { throw new Error('kaboom'); } });
  const r = await diagnose(usbDev({ productName: 'Boom' }), { platform: 'linux', run: fakeRun([]), manager: null });
  assert.ok(r.checks.some((c) => c.id === 'internal' && /kaboom/.test(c.detail)));
  FAMILIES.splice(FAMILIES.findIndex((f) => f.id === 'boom'), 1);
});

test('inventory: per-source pacing, background sources, failures keep the last list', async () => {
  let t = 0;
  let netCalls = 0;
  let usbFails = false;
  let release;
  const gate = new Promise((r) => (release = r));
  const inv = createInventory({
    now: () => t,
    sources: [
      { id: 'usb', intervalMs: 2000, list: async () => { if (usbFails) throw new Error('x'); return [{ id: 'u1' }]; } },
      { id: 'network', intervalMs: 30000, background: true, list: async () => {
        netCalls++;
        if (netCalls === 2) await gate; // a slow scan
        return [{ id: `n${netCalls}` }];
      } },
    ],
  });
  assert.deepEqual((await inv.list()).map((d) => `${d.source}:${d.id}`), ['usb:u1', 'network:n1']);
  t = 2500;
  usbFails = true;
  assert.deepEqual((await inv.list()).map((d) => d.id), ['u1', 'n1'], 'network not due; usb failure keeps last list');
  assert.equal(inv.errors().usb, 'x');
  t = 40000;
  const before = (await inv.list()).map((d) => d.id);
  assert.deepEqual(before, ['u1', 'n1'], 'background refresh does not block');
  release();
  await new Promise((r) => setImmediate(r));
  t = 40001;
  assert.deepEqual((await inv.list()).map((d) => d.id), ['u1', 'n2']);
});

test('disabled sources disappear', async () => {
  const inv = createInventory({ isEnabled: (id) => id !== 'network', sources: [{ id: 'usb', intervalMs: 0, list: async () => [{ id: 'a' }] }, { id: 'network', intervalMs: 0, list: async () => [{ id: 'b' }] }] });
  assert.deepEqual((await inv.list()).map((d) => d.id), ['a']);
});
