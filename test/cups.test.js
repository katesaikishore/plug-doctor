'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cups = require('../src/core/printer/cups');
const { fixture } = require('./helpers');

test('parses lpinfo -l -v blocks', () => {
  const devs = cups.parseLpinfoDevices(fixture('lpinfo-v.txt'));
  assert.equal(devs.length, 2);
  assert.equal(devs[0].uri, 'usb://HP/LaserJet%201020?serial=FN16VR6');
  assert.equal(devs[0].makeAndModel, 'HP LaserJet 1020');
  assert.match(devs[0].deviceId, /CMD:ACL/);
  assert.equal(devs[1].class, 'direct');
});

test('parses lpstat -v and -p', () => {
  const q = cups.parseLpstatDevices('device for HP_LaserJet_1020: usb://HP/LaserJet%201020?serial=FN16VR6\ndevice for Office: ipp://10.0.0.5/ipp/print\n');
  assert.deepEqual(q[0], { queue: 'HP_LaserJet_1020', uri: 'usb://HP/LaserJet%201020?serial=FN16VR6' });
  const p = cups.parseLpstatPrinters('printer HP_LaserJet_1020 disabled since Tue 28 Oct 2026 -\n\tUnplugged or turned off\nprinter Office is idle.  enabled since x\n');
  assert.equal(p[0].state, 'disabled');
  assert.equal(p[1].state, 'idle');
});

test('parses lpinfo -m', () => {
  const m = cups.parseLpinfoModels(fixture('lpinfo-m.txt'));
  assert.equal(m[0].name, 'drv:///sample.drv/generic.ppd');
  assert.equal(m[0].makeAndModel, 'Generic PostScript Printer');
});

test('compares USB URIs across encodings', () => {
  assert.ok(cups.sameUsbPrinter('usb://HP/LaserJet%201020?serial=FN16VR6', 'usb://HP/LaserJet 1020?serial=FN16VR6'));
  assert.ok(!cups.sameUsbPrinter('usb://HP/LaserJet%201020?serial=A', 'usb://HP/LaserJet%201020?serial=B'));
});

test('makes safe queue names', () => {
  assert.equal(cups.queueNameFor('HP LaserJet 1020'), 'HP_LaserJet_1020');
  assert.equal(cups.queueNameFor('Brother HL-L2350DW series'), 'Brother_HL-L2350DW_series');
  assert.equal(cups.queueNameFor('/// '), 'USB_Printer');
});
