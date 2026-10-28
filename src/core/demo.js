'use strict';

/**
 * Demo mode (`npm run demo`): a simulated Mac with Apple silicon and a desk
 * full of devices, for screenshots, UI work and trying the app with
 * nothing plugged in. The real sources and families run against a fake
 * system that reacts to fixes. Nothing here touches the real computer.
 */

const { finalize } = require('./usb');
const { createInventory } = require('./sources');
const display = require('./sources/display');
const bluetooth = require('./sources/bluetooth');
const network = require('./sources/network');
const DATA = require('./demo-data.json');

const LPINFO_V = `Device: uri = usb://HP/LaserJet%201020?serial=FN16VR6
        class = direct
        info = HP LaserJet 1020
        make-and-model = HP LaserJet 1020
        device-id = MFG:Hewlett-Packard;MDL:HP LaserJet 1020;CMD:ACL;CLS:PRINTER;DES:HP LaserJet 1020;
        location =
Device: uri = usb://Brother/HL-L2350DW%20series?serial=E78123A9N123456
        class = direct
        info = Brother HL-L2350DW series
        make-and-model = Brother HL-L2350DW series
        device-id = MFG:Brother;CMD:PJL,PCL,PCLXL;MDL:HL-L2350DW series;CLS:PRINTER;
        location =
`;

const LPINFO_M = `drv:///sample.drv/generic.ppd Generic PostScript Printer
drv:///sample.drv/laserjet.ppd HP LaserJet Series PCL 4/5
foomatic-db-compressed-ppds:0/ppd/foomatic-ppd/Generic-PCL_6_PCL_XL_Printer-pxlmono.ppd Generic PCL 6/PCL XL Printer Foomatic/pxlmono (recommended)
`;

/** Split a /bin/sh command line the way shQuote() in fix/elevate.js wrote it. */
function shSplit(line) {
  const out = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      cur += line.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (ch === '\\') {
      cur += line[++i];
      inWord = true;
    } else if (ch === ' ') {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

/** Undo the macOS administrator wrapper so the fake system sees the real command. */
function unwrapOsascript(args) {
  const m = String(args[1] ?? '').match(/^do shell script "(.*)" with administrator privileges$/s);
  if (!m) return null;
  return shSplit(m[1].replace(/\\(["\\])/g, '$1'));
}

function usbDevices(sys) {
  const raw = [
    {
      vendorId: '04f9',
      productId: '0042',
      vendorName: 'Brother',
      productName: 'HL-L2350DW series',
      serial: 'E78123A9N123456',
      deviceClass: '00',
      location: '0x00100000',
      interfaces: [{ number: '0', class: '07', subclass: '01', protocol: '02', name: null, driver: null, nodes: [] }],
      nodes: [],
      driver: { bound: false, names: [], unboundInterfaces: ['0'] },
    },
    {
      vendorId: '03f0',
      productId: '2b17',
      vendorName: 'Hewlett-Packard',
      productName: 'HP LaserJet 1020',
      serial: 'FN16VR6',
      deviceClass: '00',
      location: '0x00200000',
      interfaces: [{ number: '0', class: '07', subclass: '01', protocol: '02', name: null, driver: null, nodes: [] }],
      nodes: [],
      driver: { bound: false, names: [], unboundInterfaces: ['0'] },
    },
    {
      vendorId: '18d1',
      productId: '4ee7',
      vendorName: 'Google',
      productName: 'Pixel 7',
      serial: '28031FDH2000AB',
      deviceClass: '00',
      location: '0x00300000',
      interfaces: [{ number: '0', class: 'ff', subclass: '42', protocol: '01', name: 'ADB Interface', driver: null, nodes: [] }],
      nodes: [],
      driver: { bound: false, names: [], unboundInterfaces: ['0'] },
    },
    {
      vendorId: '046d',
      productId: '082d',
      vendorName: 'Logitech',
      productName: 'HD Pro Webcam C920',
      serial: 'A1B2C3D4',
      deviceClass: 'ef',
      location: '0x00400000',
      interfaces: [
        { number: '0', class: '0e', subclass: '01', protocol: '00', name: null, driver: 'AppleUSBVideoSupport', nodes: [] },
        { number: '1', class: '0e', subclass: '02', protocol: '00', name: null, driver: 'AppleUSBVideoSupport', nodes: [] },
        { number: '2', class: '01', subclass: '01', protocol: '00', name: null, driver: 'AppleUSBAudioDevice', nodes: [] },
        { number: '3', class: '01', subclass: '02', protocol: '00', name: null, driver: 'AppleUSBAudioDevice', nodes: [] },
      ],
      nodes: [],
      driver: { bound: true, names: ['AppleUSBVideoSupport', 'AppleUSBAudioDevice'], unboundInterfaces: [] },
    },
    {
      vendorId: '1a86',
      productId: '7523',
      vendorName: null,
      productName: 'USB2.0-Serial',
      serial: null,
      deviceClass: 'ff',
      location: '0x00500000',
      interfaces: [{ number: '0', class: 'ff', subclass: '01', protocol: '02', name: null, driver: 'AppleUSBCHCOM', nodes: ['cu.usbserial-1420'] }],
      nodes: ['cu.usbserial-1420'],
      driver: { bound: true, names: ['AppleUSBCHCOM'], unboundInterfaces: [] },
    },
    ...(sys.extraUsb ?? []),
  ];
  return raw.map((d) => finalize(d, 'darwin'));
}

function createDemo() {
  const sys = {
    queues: new Map(), // name -> { uri }
    extraUsb: [],
    files: new Set(), // paths that "exist"
  };

  const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '', missing: false });
  const missing = (cmd) => ({ ok: false, code: null, stdout: '', stderr: `${cmd}: not available in demo mode`, missing: true });

  async function run(cmd, args = []) {
    if (cmd === 'osascript') {
      const inner = unwrapOsascript(args);
      if (inner) [cmd, ...args] = inner;
    }
    if (cmd === 'pkexec') [cmd, ...args] = args;
    const line = [cmd, ...args].join(' ');
    if (cmd === 'system_profiler' && args[0] === 'SPDisplaysDataType') return ok(JSON.stringify(DATA.SPDisplaysDataType));
    if (cmd === 'system_profiler' && args[0] === 'SPBluetoothDataType') return ok(JSON.stringify(DATA.SPBluetoothDataType));
    if (line === 'sysctl -n hw.model') return ok(`${DATA.hwModel}\n`);
    if (cmd === 'sh' && /command -v/.test(line)) return args.at(-1) === 'brew' ? ok('/opt/homebrew/bin/brew\n') : { ...ok(), ok: false, code: 1 };
    // Feel like real work for the things people click.
    if (['lpadmin', 'lp', 'lpoptions', 'open', 'cupsenable', 'cupsaccept'].includes(cmd)) await new Promise((r) => setTimeout(r, 400));
    if (line === 'lpstat -v') return ok([...sys.queues].map(([q, v]) => `device for ${q}: ${v.uri}\n`).join(''));
    if (cmd === 'lpstat' && args[0] === '-p') return ok(`printer ${args[1]} is idle.  enabled since Tue 28 Oct 2026\n`);
    if (cmd === 'lpinfo' && args.includes('-v')) return ok(LPINFO_V);
    if (line === 'lpinfo -m') return ok(LPINFO_M);
    if (cmd === 'lpadmin') {
      sys.queues.set(args[args.indexOf('-p') + 1], { uri: args[args.indexOf('-v') + 1] });
      return ok();
    }
    if (cmd === 'lpoptions' || cmd === 'lp') return ok('request id is demo-1 (1 file(s))\n');
    if (cmd === 'open') return ok();
    for (const handler of sys.handlers ?? []) {
      const res = handler(cmd, args, line);
      if (res) return res;
    }
    return missing(cmd);
  }

  const exists = async (p) => sys.files.has(p);
  const ctx = {
    platform: 'darwin',
    arch: 'arm64',
    run,
    env: {},
    exists,
    pathExists: (p) => sys.files.has(p),
    readDir: async () => [],
    mdns: DATA.mdns,
    ssdp: DATA.ssdp,
  };

  const inventory = createInventory({
    ctx,
    sources: [
      { id: 'usb', label: 'USB', intervalMs: 2000, list: async () => usbDevices(sys) },
      { ...display.source, list: (c) => display.source.list(c) },
      { ...bluetooth.source, list: (c) => bluetooth.source.list(c) },
      { ...network.source, background: false, list: (c) => network.source.list(c) },
    ],
  });

  return { list: inventory.list, sources: inventory.sources, run, ctx, sys, platform: 'darwin', arch: 'arm64' };
}

module.exports = { createDemo, shSplit, unwrapOsascript };
