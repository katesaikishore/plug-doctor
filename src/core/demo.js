'use strict';

/**
 * Demo mode (PLUG_DOCTOR_DEMO=1): four simulated USB devices and a fake
 * system that reacts to fixes. For screenshots, UI work and trying the app
 * on a machine with nothing plugged in. Nothing here touches the real system.
 */

const { finalize } = require('./usb');

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

function createDemo() {
  const sys = {
    queues: new Map(), // name -> { uri, state }
    brlttyActive: true,
    mounted: false,
  };

  const printer = (vendorId, productId, vendorName, productName, serial) => ({
    vendorId,
    productId,
    vendorName,
    productName,
    serial,
    deviceClass: '00',
    interfaces: [{ number: '00', class: '07', subclass: '01', protocol: '02', driver: 'usblp', nodes: ['lp0'] }],
    nodes: ['lp0'],
    driver: { bound: true, names: ['usblp'], unboundInterfaces: [] },
    location: `bus 1 port 1-${productId.slice(-1)}`,
  });

  function list() {
    const ch340Ok = !sys.brlttyActive;
    const raw = [
      printer('04f9', '0042', 'Brother', 'HL-L2350DW series', 'E78123A9N123456'),
      printer('03f0', '2b17', 'Hewlett-Packard', 'HP LaserJet 1020', 'FN16VR6'),
      {
        vendorId: '1a86',
        productId: '7523',
        vendorName: null,
        productName: 'USB2.0-Serial',
        serial: null,
        location: 'bus 1 port 1-3',
        deviceClass: 'ff',
        interfaces: [{ number: '00', class: 'ff', subclass: '01', protocol: '02', driver: ch340Ok ? 'ch341' : null, nodes: ch340Ok ? ['ttyUSB0'] : [] }],
        nodes: ch340Ok ? ['ttyUSB0'] : [],
        driver: { bound: ch340Ok, names: ch340Ok ? ['ch341'] : [], unboundInterfaces: ch340Ok ? [] : ['00'] },
      },
      {
        vendorId: '0781',
        productId: '5583',
        vendorName: 'SanDisk',
        productName: 'Ultra Fit',
        serial: '4C530001230925111234',
        location: 'bus 2 port 2-1',
        deviceClass: '00',
        interfaces: [{ number: '00', class: '08', subclass: '06', protocol: '50', driver: 'usb-storage', nodes: [] }],
        nodes: [],
        driver: { bound: true, names: ['usb-storage'], unboundInterfaces: [] },
      },
    ];
    return Promise.resolve(raw.map((d) => finalize(d, 'linux')));
  }

  const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '', missing: false });
  const fail = (stderr) => ({ ok: false, code: 1, stdout: '', stderr, missing: false });

  async function run(cmd, args = []) {
    if (cmd === 'pkexec') [cmd, ...args] = args;
    await new Promise((r) => setTimeout(r, 350)); // feel like real work
    const line = [cmd, ...args].join(' ');
    if (cmd === 'sh' && /command -v/.test(line)) return args.at(-1) === 'apt-get' ? ok('/usr/bin/apt-get\n') : fail('');
    if (line === 'lpstat -v') return ok([...sys.queues].map(([q, v]) => `device for ${q}: ${v.uri}\n`).join(''));
    if (cmd === 'lpstat' && args[0] === '-p') return ok(`printer ${args[1]} is idle.  enabled since Tue 28 Oct 2026\n`);
    if (cmd === 'lpinfo' && args.includes('-v')) return ok(LPINFO_V);
    if (line === 'lpinfo -m') return ok(LPINFO_M);
    if (cmd === 'lpadmin') {
      sys.queues.set(args[args.indexOf('-p') + 1], { uri: args[args.indexOf('-v') + 1] });
      return ok();
    }
    if (cmd === 'lpoptions' || cmd === 'lp') return ok('request id is demo-1 (1 file(s))\n');
    if (line === 'systemctl is-active brltty-udev.service') return sys.brlttyActive ? ok('active\n') : ok('inactive\n');
    if (cmd === 'systemctl' && args[0] === 'mask') {
      sys.brlttyActive = false;
      return ok();
    }
    if (cmd === 'systemctl') return ok();
    if (line.startsWith('stat -c %G')) return ok('dialout\n');
    if (line === 'id -nG') return ok('demo dialout sudo\n');
    if (cmd === 'lsblk') {
      return ok(
        JSON.stringify({
          blockdevices: [{ name: 'sda', tran: 'usb', size: '29.3G', serial: '4C530001230925111234', model: 'Ultra Fit', children: [{ name: 'sda1', fstype: 'exfat', label: 'STICK', mountpoint: sys.mounted ? '/media/demo/STICK' : null }] }],
        }),
      );
    }
    if (cmd === 'udisksctl') {
      sys.mounted = true;
      return ok('Mounted /dev/sda1 at /media/demo/STICK\n');
    }
    if (cmd === 'apt-get') return ok('Setting up hplip ...\n');
    if (cmd === 'lsusb') return ok(`Bus 001 Device 004: ID ${args.at(-1)} (demo)\n  bLength 18\n  bDescriptorType 1\n  bcdUSB 2.00\n`);
    return { ok: false, code: null, stdout: '', stderr: `${cmd}: not available in demo mode`, missing: true };
  }

  return { list, run, platform: 'linux' };
}

module.exports = { createDemo };
