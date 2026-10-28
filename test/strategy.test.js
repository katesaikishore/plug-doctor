'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseDriver, findExactModel } = require('../src/core/printer/strategy');
const { parseLpinfoModels } = require('../src/core/printer/cups');
const { parseDeviceId } = require('../src/core/printer/ieee1284');
const { fixture } = require('./helpers');

const models = parseLpinfoModels(fixture('lpinfo-m.txt'));

test('exact model match never confuses 1020 with 10200', () => {
  assert.equal(findExactModel('HP LaserJet 1020', models), null);
  assert.equal(findExactModel('HP LaserJet 10200', models).name, 'drv:///hpcups.drv/hp-laserjet_10200.ppd');
});

test('falls back to the generic driver for the language the printer speaks', () => {
  const deviceId = parseDeviceId('MFG:Brother;CMD:PJL,PCL,PCLXL;MDL:HL-L2350DW series;');
  const [best, next] = chooseDriver({ deviceId, models, platform: 'linux' });
  assert.equal(best.id, 'generic-pclxl');
  assert.match(best.model, /pxlmono/);
  assert.equal(next.id, 'generic-pcl');
});

test('PostScript printers get the generic PostScript driver', () => {
  const deviceId = parseDeviceId('MFG:Lexmark;CMD:POSTSCRIPT,PCL;MDL:MS310;');
  assert.equal(chooseDriver({ deviceId, models, platform: 'darwin' })[0].model, 'drv:///sample.drv/generic.ppd');
});

test('IPP-over-USB beats generic drivers', () => {
  const deviceId = parseDeviceId('MFG:Brother;CMD:PJL,PCL,PCLXL,URF;MDL:HL-L2350DW series;');
  const interfaces = [{ class: '07', subclass: '01', protocol: '02' }, { class: '07', subclass: '01', protocol: '04' }];
  const [best] = chooseDriver({ deviceId, models, interfaces, platform: 'linux' });
  assert.equal(best.id, 'ipp-usb');
  assert.deepEqual(best.packages.apt, ['ipp-usb']);
});

test('host-based printers are reported honestly', () => {
  const deviceId = parseDeviceId('MFG:Hewlett-Packard;MDL:HP LaserJet 1020;CMD:ACL;');
  const [only] = chooseDriver({ deviceId, models, platform: 'darwin' });
  assert.equal(only.id, 'hostbased');
  assert.ok(only.confidence < 0.5);
});

test('a software-only recipe is skipped once the exact driver is installed', () => {
  const recipe = { name: 'HPLIP', summary: 's', confidence: 0.9, platforms: { linux: { packages: { apt: ['hplip'] } } } };
  const deviceId = parseDeviceId('MFG:HP;MDL:HP LaserJet 1020;CMD:ACL;');
  const withDriver = [...models, { name: 'drv:///hpcups.drv/hp-laserjet_1020.ppd', makeAndModel: 'HP LaserJet 1020, hpcups 3.22.10' }];
  assert.equal(chooseDriver({ deviceId, models, recipes: [recipe], platform: 'linux' })[0].id, 'recipe');
  assert.equal(chooseDriver({ deviceId, models: withDriver, recipes: [recipe], platform: 'linux' })[0].id, 'exact');
});
