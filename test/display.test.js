'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEdid, pnpFromCode, largestCtaMode } = require('../src/core/edid');
const display = require('../src/core/sources/display');
const { family, ONE_EXTERNAL_MACS, DISPLAYLINK_URLS } = require('../src/core/families/display');
const { familyFor } = require('../src/core/families');
const { diagnose } = require('../src/core/diagnose');
const { finalize } = require('../src/core/usb');
const { validateStep } = require('../src/core/fix/runner');
const { fixture, fakeRun } = require('./helpers');

const MAC_PANE = 'x-apple.systempreferences:com.apple.Displays-Settings.extension';

// ---------------------------------------------------------------- synthetic EDID

/** 18-byte detailed timing: pixel clock in 10 kHz units. */
function dtd(clock10k, w, hblank, h, vblank, mm = [1600, 900]) {
  const b = Buffer.alloc(18);
  b[0] = clock10k & 0xff;
  b[1] = clock10k >> 8;
  b[2] = w & 0xff;
  b[3] = hblank & 0xff;
  b[4] = ((w >> 8) << 4) | (hblank >> 8);
  b[5] = h & 0xff;
  b[6] = vblank & 0xff;
  b[7] = ((h >> 8) << 4) | (vblank >> 8);
  b[12] = mm[0] & 0xff;
  b[13] = mm[1] & 0xff;
  b[14] = ((mm[0] >> 8) << 4) | (mm[1] >> 8);
  return b;
}

function textDescriptor(tag, text) {
  const b = Buffer.alloc(18, 0x20);
  b.fill(0, 0, 5);
  b[3] = tag;
  const t = Buffer.from(`${text}\n`, 'ascii').subarray(0, 13);
  t.copy(b, 5);
  return b;
}

const checksum = (block) => {
  let sum = 0;
  for (let i = 0; i < 127; i++) sum += block[i];
  block[127] = (256 - (sum % 256)) % 256;
};

/**
 * A 256-byte EDID: base block plus a CTA-861 extension.
 * Defaults describe a Samsung 4K TV whose HDMI input reports HDMI 1.4 speed.
 */
function makeEdid({ pnp = 'SAM', product = 0x7279, serial = 0x01000e00, name = 'SAMSUNG', serialString = null, sizeCm = [160, 90], preferred = dtd(29700, 3840, 560, 2160, 90), tvModes = true, hdmiForum = false } = {}) {
  const base = Buffer.alloc(128);
  Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]).copy(base, 0);
  const code = ((pnp.charCodeAt(0) - 64) << 10) | ((pnp.charCodeAt(1) - 64) << 5) | (pnp.charCodeAt(2) - 64);
  base[8] = code >> 8;
  base[9] = code & 0xff;
  base.writeUInt16LE(product, 10);
  base.writeUInt32LE(serial, 12);
  base[16] = 12;
  base[17] = 2021 - 1990;
  base[18] = 1;
  base[19] = 3;
  base[20] = 0x80;
  base[21] = sizeCm[0];
  base[22] = sizeCm[1];
  preferred.copy(base, 54);
  textDescriptor(0xfc, name).copy(base, 72);
  (serialString ? textDescriptor(0xff, serialString) : Buffer.from([0, 0, 0, 0x10, ...Array(14).fill(0)])).copy(base, 90);
  Buffer.from([0, 0, 0, 0xfd, 0, 24, 75, 15, 135, 60, 0, 10, 32, 32, 32, 32, 32, 32]).copy(base, 108);
  base[126] = 1;
  checksum(base);

  const cta = Buffer.alloc(128);
  cta[0] = 0x02;
  cta[1] = 0x03;
  cta[3] = 0x80 | 0x40 | 0x01;
  const vics = tvModes ? [0x80 | 16, 97, 95, 93, 32, 5, 6, 21] : [0x80 | 16, 4, 3];
  const blocks = [
    Buffer.from([(2 << 5) | vics.length, ...vics]),
    // HDMI 1.4 VSDB: OUI 00-0C-03, physical address 1.0.0.0, flags, max TMDS 300 MHz.
    Buffer.from([(3 << 5) | 7, 0x03, 0x0c, 0x00, 0x10, 0x00, 0x80, 60]),
    // HDR static metadata: SDR + SMPTE ST 2084.
    Buffer.from([(7 << 5) | 3, 0x06, 0x05, 0x01]),
  ];
  // HDMI Forum VSDB: OUI C4-5D-D8, version 1, max TMDS 600 MHz.
  if (hdmiForum) blocks.push(Buffer.from([(3 << 5) | 6, 0xd8, 0x5d, 0xc4, 0x01, 120, 0x00]));
  let off = 4;
  for (const b of blocks) {
    b.copy(cta, off);
    off += b.length;
  }
  cta[2] = off;
  dtd(14850, 1920, 280, 1080, 45).copy(cta, off);
  checksum(cta);
  return Buffer.concat([base, cta]);
}

test('edid: parses identity, preferred timing and the CTA extension', () => {
  const e = parseEdid(makeEdid({ serialString: 'HCJW600123' }));
  assert.equal(e.manufacturer, 'SAM');
  assert.equal(e.productCode, 0x7279);
  assert.equal(e.serialNumber, 0x01000e00);
  assert.equal(e.week, 12);
  assert.equal(e.year, 2021);
  assert.equal(e.name, 'SAMSUNG');
  assert.equal(e.serialString, 'HCJW600123');
  assert.equal(e.checksumOk, true);
  assert.deepEqual(e.sizeCm, { width: 160, height: 90 });
  assert.deepEqual([e.preferred.width, e.preferred.height, e.preferred.refresh, e.preferred.pixelClockMHz], [3840, 2160, 30, 297]);
  assert.equal(e.rangeLimits.maxVHz, 75);
  assert.equal(e.hdmi, true);
  assert.equal(e.cta.physicalAddress, '1.0.0.0');
  assert.equal(e.cta.maxTmdsMhz, 300);
  assert.equal(e.cta.hdmiForum, false);
  assert.deepEqual(e.cta.hdr, { pq: true, hlg: false });
  assert.deepEqual(e.cta.vics[0], { vic: 16, native: true });
  assert.equal(e.cta.dtds[0].width, 1920);
  assert.equal(e.cta.dtds[0].refresh, 60);
  assert.equal(e.tvLike, true);
  assert.deepEqual(largestCtaMode(e.cta), { width: 3840, height: 2160, refresh: 60 });
});

test('edid: HDMI 2.x screens, monitors and hex input', () => {
  const e = parseEdid(makeEdid({ hdmiForum: true, tvModes: false, name: 'U2720Q', pnp: 'DEL' }).toString('hex'));
  assert.equal(e.manufacturer, 'DEL');
  assert.equal(e.cta.hdmiForum, true);
  assert.equal(e.cta.maxTmdsMhz, 600);
  assert.equal(e.tvLike, false);
  assert.equal(pnpFromCode(0x4c2d), 'SAM');
  assert.equal(pnpFromCode(0x0610), 'APP');
  assert.equal(pnpFromCode(0x1e6d), 'GSM');
  assert.equal(pnpFromCode(0), null);
});

test('edid: never throws on short or garbage input', () => {
  for (const junk of [null, undefined, '', 'zz', 'abc', 42, {}, [], Buffer.alloc(10), Buffer.alloc(128), Buffer.alloc(300, 0xff)]) {
    assert.equal(parseEdid(junk), null);
  }
  const bad = makeEdid();
  bad[127] ^= 0xff;
  assert.equal(parseEdid(bad).checksumOk, false);
  // Claims three extensions but carries none.
  const truncated = Buffer.from(makeEdid().subarray(0, 128));
  truncated[126] = 3;
  assert.equal(parseEdid(truncated).cta, null);
  // Random bytes after a valid header.
  const noise = Buffer.alloc(256);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 151 + 7) & 0xff;
  Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]).copy(noise, 0);
  noise[128] = 0x02;
  assert.doesNotThrow(() => parseEdid(noise));
});

// ---------------------------------------------------------------- macOS

const macRun = (json = fixture('display-spdisplays.json'), model = 'MacBookAir10,1\n') =>
  fakeRun([
    ['system_profiler SPDisplaysDataType -json', json],
    ['sysctl -n hw.model', model],
  ]);

test('macOS: built-in panel and a 4K TV over HDMI from system_profiler', async () => {
  const devices = await display.source.list({ platform: 'darwin', run: macRun() });
  assert.equal(devices.length, 2);
  const [panel, tv] = devices;
  assert.equal(panel.details.builtIn, true);
  assert.equal(panel.id, 'display:APP-A045-fd626d62');
  assert.equal(panel.displayName, 'Built-in screen');
  assert.deepEqual(panel.details.native, { width: 2560, height: 1600 });
  assert.equal(tv.id, 'display:SAM-7279-1000e00');
  assert.equal(tv.source, 'display');
  assert.equal(tv.displayName, 'Samsung TV');
  assert.deepEqual(tv.categories, ['display', 'tv']);
  assert.deepEqual(tv.details.current, { width: 3840, height: 2160, refresh: 30 });
  assert.deepEqual(tv.details.native, { width: 3840, height: 2160 });
  assert.equal(tv.details.isTV, true);
  assert.equal(tv.details.externalCount, 1);
  assert.equal(tv.details.chip, 'Apple M1');
  assert.equal(tv.details.hwModel, 'MacBookAir10,1');
  assert.deepEqual(tv.driver, { bound: null, names: [], unboundInterfaces: [] });
});

test('macOS: parser survives missing keys and junk', () => {
  assert.deepEqual(display.parseSystemProfiler(''), []);
  assert.deepEqual(display.parseSystemProfiler('not json'), []);
  assert.deepEqual(display.parseSystemProfiler('{"SPDisplaysDataType": "nope"}'), []);
  const odd = display.parseSystemProfiler('{"SPDisplaysDataType": [null, 3, {"spdisplays_ndrvs": [1, null, {"_name": "spdisplays_display"}, {"_name": "DELL U2720Q", "spdisplays_resolution": "1920 x 1080 @ 60 Hz"}]}]}');
  assert.equal(odd.length, 2);
  assert.equal(odd[0].name, null);
  assert.deepEqual(odd[1].current, { width: 1920, height: 1080, refresh: 60 });
  assert.equal(display.connectionName('spdisplays_displayport_dongletype_hdmi'), 'HDMI');
  assert.equal(display.connectionName('spdisplays_internal'), 'Built-in');
});

test('macOS: 4K TV at 30 Hz on an M1 MacBook Air', async () => {
  const [, tv] = await display.source.list({ platform: 'darwin', run: macRun() });
  assert.equal(familyFor(tv).id, 'display');
  const r = await diagnose(tv, { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.equal(r.category, 'display');
  assert.equal(r.icon, 'display');
  assert.equal(r.status, 'needs-fix');
  assert.match(r.headline, /30 Hz/);
  assert.equal(r.support.level, 'native');
  const ids = r.checks.map((c) => c.id);
  for (const id of ['connected', 'refresh', 'resolution', 'mac-screens', 'tv-overscan', 'tv-pc-mode', 'tv-hdr', 'tv-cec']) assert.ok(ids.includes(id), id);
  assert.equal(r.checks.find((c) => c.id === 'refresh').status, 'warn');
  assert.equal(r.checks.find((c) => c.id === 'resolution').status, 'pass');
  assert.equal(r.checks.find((c) => c.id === 'mac-screens').status, 'info');
  assert.match(r.checks.find((c) => c.id === 'mac-screens').detail, /MacBook Air \(M1\)/);
  assert.match(r.checks.find((c) => c.id === 'tv-cec').detail, /Macs do not support HDMI-CEC/);
  assert.match(r.checks.find((c) => c.id === 'tv-overscan').detail, /Underscan/);
  const fix = r.plans[0];
  assert.equal(fix.id, 'fix-refresh');
  assert.deepEqual([fix.steps[0].cmd, ...fix.steps[0].args], ['open', MAC_PANE]);
  assert.ok(fix.steps.some((s) => /Input Signal Plus/.test(s.explain)), 'TV-specific HDMI setting');
  assert.ok(r.plans.some((p) => p.id === 'tv-fit'));
  for (const p of r.plans) {
    assert.equal(p.auto, false);
    for (const s of p.steps) assert.ok(validateStep(s).ok, `${p.id}: ${s.title}`);
  }
});

test('macOS: built-in panel is fine and gets no TV or limit checks', async () => {
  const [panel] = await display.source.list({ platform: 'darwin', run: macRun() });
  const r = await diagnose(panel, { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'ok');
  assert.equal(r.headline, 'Your built-in screen is working.');
  assert.ok(!r.checks.some((c) => /^(tv-|mac-|refresh)/.test(c.id)));
});

test('macOS: two external screens on an M2 MacBook Air explains DisplayLink', async () => {
  const data = JSON.parse(fixture('display-spdisplays.json'));
  const drvs = data.SPDisplaysDataType[0].spdisplays_ndrvs;
  drvs.push({ _name: 'DELL U2720Q', '_spdisplays_display-vendor-id': '10ac', '_spdisplays_display-product-id': 'a0a5', _spdisplays_pixels: '3840 x 2160', _spdisplays_resolution: '1920 x 1080 @ 60.00Hz' });
  data.SPDisplaysDataType[0].sppci_model = 'Apple M2';
  const devices = await display.source.list({ platform: 'darwin', run: macRun(JSON.stringify(data), 'Mac14,2\n') });
  const dell = devices.find((d) => d.vendorName === 'Dell');
  assert.equal(dell.displayName, 'DELL U2720Q');
  assert.equal(dell.details.externalCount, 2);
  assert.equal(dell.details.isTV, false);
  const r = await diagnose(dell, { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.checks.find((c) => c.id === 'mac-screens').status, 'warn');
  const dl = r.plans.find((p) => p.id === 'displaylink-mac');
  assert.equal(dl.steps.find((s) => s.kind === 'open-url').url, DISPLAYLINK_URLS.darwin);
  assert.ok(!r.checks.some((c) => c.id.startsWith('tv-')));
  assert.equal(ONE_EXTERNAL_MACS['Mac14,2'], 'MacBook Air (M2)');
});

test('macOS: Pro chips and Mac minis get no one-screen warning', async () => {
  const data = JSON.parse(fixture('display-spdisplays.json'));
  data.SPDisplaysDataType[0].sppci_model = 'Apple M1 Pro';
  const [, tv] = await display.source.list({ platform: 'darwin', run: macRun(JSON.stringify(data), 'MacBookPro18,3\n') });
  const r = await diagnose(tv, { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.ok(!r.checks.some((c) => c.id === 'mac-screens'));
  const [, tv2] = await display.source.list({ platform: 'darwin', run: macRun(fixture('display-spdisplays.json'), 'Macmini9,1\n') });
  const r2 = await diagnose(tv2, { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.ok(!r2.checks.some((c) => c.id === 'mac-screens'));
});

// ---------------------------------------------------------------- Linux

function makeDrm(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-doctor-drm-'));
  for (const [name, attrs] of Object.entries(layout)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(attrs)) fs.writeFileSync(path.join(dir, k), v);
  }
  return root;
}

const linuxDrm = (hdmiEnabled = 'enabled') =>
  makeDrm({
    card0: {},
    'card0-eDP-1': { status: 'connected\n', enabled: 'enabled\n', modes: '1920x1080\n1680x1050\n', edid: Buffer.alloc(0) },
    'card0-HDMI-A-1': { status: 'connected\n', enabled: `${hdmiEnabled}\n`, modes: '3840x2160\n4096x2160\n1920x1080\n', edid: makeEdid({ name: 'Q80T' }) },
    'card0-DP-1': { status: 'disconnected\n', enabled: 'disabled\n', modes: '', edid: Buffer.alloc(0) },
  });

test('linux: screens from /sys/class/drm with the current mode from xrandr', async () => {
  const drmRoot = linuxDrm();
  const run = fakeRun([['xrandr --query', fixture('display-xrandr.txt')]]);
  const devices = await display.source.list({ platform: 'linux', run, drmRoot });
  assert.equal(devices.length, 2);
  const [panel, tv] = devices;
  assert.equal(panel.details.builtIn, true);
  assert.equal(panel.id, 'display:card0-eDP-1');
  assert.deepEqual(panel.details.current, { width: 1920, height: 1080, refresh: 60.02 });
  assert.equal(tv.id, 'display:SAM-7279-1000e00');
  assert.equal(tv.details.output, 'HDMI-1');
  assert.equal(tv.details.connection, 'HDMI');
  assert.deepEqual(tv.details.current, { width: 3840, height: 2160, refresh: 30 });
  assert.deepEqual(tv.details.native, { width: 3840, height: 2160, refresh: 30 });
  assert.ok(tv.details.availableRates.includes(60));
  assert.equal(tv.details.isTV, true, 'Samsung + TV broadcast modes in the EDID');
  assert.equal(tv.details.edid.maxTmdsMhz, 300);
  assert.equal(tv.details.externalCount, 1);

  const r = await diagnose(tv, { platform: 'linux', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'needs-fix');
  const p = r.plans.find((x) => x.id === 'set-60hz');
  assert.deepEqual([p.steps[0].cmd, ...p.steps[0].args], ['xrandr', '--output', 'HDMI-1', '--mode', '3840x2160', '--rate', '60.00']);
  assert.ok(!r.checks.some((c) => c.id === 'tv-cec' && /Macs/.test(c.detail)));
  fs.rmSync(drmRoot, { recursive: true, force: true });
});

test('linux: no xrandr (Wayland) still lists screens; a switched-off screen gets a plan', async () => {
  const drmRoot = linuxDrm('disabled');
  const devices = await display.source.list({ platform: 'linux', run: fakeRun([]), drmRoot });
  assert.equal(devices.length, 2);
  const tv = devices[1];
  assert.equal(tv.details.current, null);
  assert.equal(tv.details.enabled, false);
  const r = await diagnose(tv, { platform: 'linux', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'needs-fix');
  assert.match(r.headline, /switched off/);
  assert.equal(r.plans.find((p) => p.id === 'enable-screen').steps[0].kind, 'manual');
  fs.rmSync(drmRoot, { recursive: true, force: true });
  assert.deepEqual(await display.source.list({ platform: 'linux', run: fakeRun([]), drmRoot: '/nonexistent/drm' }), []);
});

test('linux: xrandr parser', () => {
  const outs = display.parseXrandr(fixture('display-xrandr.txt'));
  assert.deepEqual(outs.map((o) => [o.name, o.connected, o.primary]), [['eDP-1', true, true], ['HDMI-1', true, false], ['DP-1', false, false], ['DP-2', false, false]]);
  assert.equal(outs[1].modes.find((m) => m.interlaced).height, 1080);
  assert.deepEqual(outs[1].modes[0].rates.slice(0, 2), [30, 60]);
  assert.equal(outs[1].modes[0].preferred, true);
  const spaced = display.parseXrandr('HDMI-1 connected 1920x1080+0+0 (normal)\n   1920x1080     60.00 +  59.94*\n');
  assert.deepEqual(spaced[0].current, { width: 1920, height: 1080, refresh: 59.94 });
  assert.deepEqual(display.parseXrandr('garbage\n\n   12x'), []);
});

// ---------------------------------------------------------------- Windows

test('windows: monitors from WMI, decoded from UInt16 arrays', async () => {
  const run = fakeRun([[/^powershell\.exe /, fixture('display-windows.json')]]);
  const devices = await display.source.list({ platform: 'win32', run });
  assert.equal(devices.length, 2);
  const [panel, tv] = devices;
  assert.equal(panel.details.builtIn, true);
  assert.equal(panel.vendorName, 'LG Display');
  assert.equal(panel.serial, null, 'serial "0" means none');
  assert.equal(tv.id, 'display:GSM-7750-109NTAB78901');
  assert.equal(tv.productName, 'LG TV SSCR2');
  assert.equal(tv.displayName, 'LG TV SSCR2');
  assert.equal(tv.details.connection, 'HDMI');
  assert.equal(tv.details.isTV, true);
  assert.deepEqual(tv.details.native, { width: 3840, height: 2160 });
  assert.equal(tv.details.current, null, 'one controller, two screens: mode unknown');
  assert.equal(tv.details.chip, 'Intel(R) UHD Graphics 620');
  assert.match(run.calls[0], /WmiMonitorID/);

  const r = await diagnose(tv, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'ok');
  assert.equal(r.headline, 'Your TV is working as a computer screen.');
  assert.match(r.checks.find((c) => c.id === 'tv-cec').detail, /Most computers/);
  assert.match(r.checks.find((c) => c.id === 'tv-hdr').detail, /Use HDR/);
});

test('windows: a 4K monitor running at 1080p is blurry', async () => {
  const devices = await display.source.list({ platform: 'win32', run: fakeRun([[/^powershell\.exe /, fixture('display-windows-single.json')]]) });
  assert.equal(devices.length, 1);
  const [dell] = devices;
  assert.equal(dell.displayName, 'DELL U2720Q');
  assert.equal(dell.details.connection, 'DisplayPort');
  assert.deepEqual(dell.details.current, { width: 1920, height: 1080, refresh: 60 });
  const r = await diagnose(dell, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.equal(r.status, 'needs-fix');
  assert.match(r.headline, /blurry/);
  const p = r.plans.find((x) => x.id === 'native-resolution');
  assert.deepEqual([p.steps[0].cmd, ...p.steps[0].args], ['explorer.exe', 'ms-settings:display']);
  assert.match(p.steps[1].explain, /Recommended/);
});

test('windows: parser survives junk', async () => {
  assert.deepEqual(display.parseWindows(''), []);
  assert.deepEqual(display.parseWindows('null'), []);
  assert.deepEqual(display.parseWindows('{"Monitors": [null, 5]}'), []);
  assert.equal(display.wmiString([72, 105, 0, 0]), 'Hi');
  assert.equal(display.wmiString(null), null);
  assert.deepEqual(await display.source.list({ platform: 'win32', run: fakeRun([]) }), []);
});

test('tv guess', () => {
  const g = (name, vendorName, extra = {}) => display.guessTv({ name, vendorName, ...extra }).isTV;
  assert.equal(g('DELL U2720Q', 'Dell'), false);
  assert.equal(g('LG TV SSCR2', 'LG'), true);
  assert.equal(g('LG HDR 4K', 'LG'), false);
  assert.equal(g('SAMSUNG', 'Samsung'), true);
  assert.equal(g('LU28R55', 'Samsung'), false);
  assert.equal(g('SONY TV  *00', 'Sony'), true);
  assert.equal(g('KD-55X85J', 'Sony'), true);
  assert.equal(g('Color LCD', 'Apple', { builtIn: true }), false);
});

// ---------------------------------------------------------------- USB

const usbDev = (over) =>
  finalize({ vendorId: '17e9', productId: '6000', vendorName: 'DisplayLink', productName: 'USB3.0 Dock', serial: 'ABC123', deviceClass: 'ef', interfaces: [{ number: '00', class: 'ff', subclass: '00', protocol: '00', driver: null }], nodes: [], driver: { bound: false, names: [], unboundInterfaces: ['00'] }, ...over }, 'darwin');

test('DisplayLink on a Mac without DisplayLink Manager', async () => {
  const d = usbDev();
  assert.equal(familyFor(d).id, 'display');
  const r = await diagnose(d, { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null, pathExists: () => false });
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.support.level, 'vendor-driver');
  assert.equal(r.checks.find((c) => c.id === 'driver-bound').status, 'info', 'no kernel driver is normal');
  const p = r.plans[0];
  assert.equal(p.steps[0].url, DISPLAYLINK_URLS.darwin);
  assert.ok(p.steps.some((s) => /Screen Recording/.test(s.explain)));
  const ok = await diagnose(d, { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null, pathExists: (p2) => p2 === '/Applications/DisplayLink Manager.app' });
  assert.equal(ok.status, 'ok');
});

test('DisplayLink on Linux and Windows', async () => {
  const linuxNo = await diagnose(usbDev(), { platform: 'linux', run: fakeRun([]), manager: null, pathExists: () => false });
  assert.equal(linuxNo.status, 'needs-fix');
  assert.equal(linuxNo.plans[0].steps[0].url, DISPLAYLINK_URLS.linux);
  const linuxOk = await diagnose(usbDev(), { platform: 'linux', run: fakeRun([]), manager: null, pathExists: (p) => p === '/sys/module/evdi' });
  assert.equal(linuxOk.status, 'ok');
  const win = await diagnose(usbDev({ problem: { code: 28, message: 'No driver is installed for this device (Code 28).' } }), { platform: 'win32', run: fakeRun([]), manager: null });
  assert.equal(win.status, 'broken');
  assert.deepEqual(win.plans[0].steps.map((s) => s.cmd ?? s.url), ['pnputil', DISPLAYLINK_URLS.win32, undefined]);
  for (const r of [linuxNo, win]) for (const p of r.plans) for (const s of p.steps) assert.ok(validateStep(s).ok);
});

test('USB-C Billboard devices are claimed; other USB devices are not', async () => {
  const bb = usbDev({ vendorId: '2109', productId: '0102', interfaces: [{ number: '00', class: '11', subclass: '00', protocol: '00', driver: null }], deviceClass: '11' });
  assert.equal(family.match(bb), 55);
  assert.equal(family.match(usbDev({ vendorId: 'abcd', interfaces: [{ class: '03' }] })), 0);
  const r = await diagnose(bb, { platform: 'darwin', arch: 'arm64', run: fakeRun([]), manager: null });
  assert.equal(r.category, 'display');
  assert.equal(r.support.level, 'native');
});
