'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDeviceId, languagesOf } = require('../src/core/printer/ieee1284');

test('parses short and long keys', () => {
  const id = parseDeviceId('MANUFACTURER:Brother;COMMAND SET:PJL,PCL,PCLXL,URF;MODEL:HL-L2350DW series;CLASS:PRINTER;');
  assert.equal(id.manufacturer, 'Brother');
  assert.equal(id.model, 'HL-L2350DW series');
  assert.deepEqual(id.commandSet, ['PJL', 'PCL', 'PCLXL', 'URF']);
  assert.equal(id.class, 'PRINTER');
});

test('orders languages most capable first and ignores PJL', () => {
  assert.deepEqual(languagesOf(['PJL', 'PCL', 'PCLXL', 'URF']), ['driverless', 'pclxl', 'pcl']);
  assert.deepEqual(languagesOf(['PJL']), []);
  assert.deepEqual(languagesOf(['POSTSCRIPT', 'PCL5E']), ['postscript', 'pcl']);
});

test('recognizes host-based printers', () => {
  const id = parseDeviceId('MFG:Hewlett-Packard;MDL:HP LaserJet 1020;CMD:ACL;CLS:PRINTER;');
  assert.deepEqual(id.languages, ['hostbased']);
});

test('tolerates junk', () => {
  assert.deepEqual(parseDeviceId('').commandSet, []);
  assert.equal(parseDeviceId(null).model, null);
  assert.equal(parseDeviceId('nonsense;;MDL:X').model, 'X');
});
