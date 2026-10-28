'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const report = require('../src/core/report');
const { finalize } = require('../src/core/usb');

test('USB report has IDs, interfaces and a capture guide', () => {
  const d = finalize({ vendorId: '1a86', productId: '7523', productName: 'USB2.0-Serial', interfaces: [{ number: '00', class: 'ff', subclass: '01', protocol: '02', driver: null }], nodes: [], driver: { bound: false, names: [] } }, 'linux');
  const md = report.buildMarkdown(d, { status: 'broken', headline: 'x', checks: [], facts: {}, support: { label: 'Needs a driver' } }, { tool: 'lsusb -v', text: 'desc' });
  assert.match(md, /USB ID: `1a86:7523`/);
  assert.match(md, /class ff Vendor Specific/);
  assert.match(md, /capture its USB traffic/);
  assert.match(md, /Support: Needs a driver/);
  assert.match(report.issueUrl(d), /1a86%3A7523/);
});

test('non-USB report skips USB-only sections', async () => {
  const d = { id: 'display:x', source: 'display', displayName: 'LG TV', vendorName: 'LG', productName: 'TV', categories: ['display'], interfaces: [], details: { refreshHz: 30 } };
  const raw = await report.rawDescriptors(d, { platform: 'darwin' });
  assert.match(raw.text, /refreshHz/);
  const md = report.buildMarkdown(d, { status: 'needs-fix', headline: 'y', checks: [], facts: {} }, raw);
  assert.match(md, /Found via: display/);
  assert.doesNotMatch(md, /Interfaces|USB traffic/);
  assert.match(report.issueUrl(d), /LG\+TV\+%28display%29/);
});
