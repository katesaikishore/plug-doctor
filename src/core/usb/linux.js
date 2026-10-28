'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { hex2 } = require('./classes');

const DEFAULT_SYSFS = '/sys/bus/usb/devices';

async function readAttr(dir, name) {
  try {
    return (await fs.readFile(path.join(dir, name), 'utf8')).trim();
  } catch {
    return null;
  }
}

async function driverOf(dir) {
  try {
    return path.basename(await fs.readlink(path.join(dir, 'driver')));
  } catch {
    return null;
  }
}

/**
 * Device nodes an interface created (ttyUSB0, ttyACM0, lp0, hidraw3, ...),
 * found by walking a couple of levels below the interface directory.
 */
async function deviceNodesOf(dir, depth = 3) {
  const found = [];
  const pattern = /^(tty(USB|ACM)\d+|lp\d+|hidraw\d+|video\d+|sd[a-z]+|sg\d+)$/;
  async function walk(d, left) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (pattern.test(e.name)) found.push(e.name);
      // Only follow real directories; sysfs symlinks loop back up the tree.
      if (left > 0 && e.isDirectory() && !e.isSymbolicLink()) await walk(path.join(d, e.name), left - 1);
    }
  }
  await walk(dir, depth);
  return [...new Set(found)].sort();
}

/**
 * Read USB devices straight from sysfs. No root, no libusb, no lsusb.
 * @param {{ sysfsRoot?: string }} [opts]
 */
async function listDevices(opts = {}) {
  const root = opts.sysfsRoot ?? DEFAULT_SYSFS;
  let names;
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }

  const devices = new Map();
  const interfaces = [];
  for (const name of names) {
    const dir = path.join(root, name);
    if (name.includes(':')) {
      interfaces.push({ name, dir });
      continue;
    }
    const vendorId = await readAttr(dir, 'idVendor');
    if (!vendorId) continue;
    devices.set(name, {
      id: null,
      sysName: name,
      vendorId: vendorId.toLowerCase(),
      productId: ((await readAttr(dir, 'idProduct')) ?? '').toLowerCase(),
      vendorName: await readAttr(dir, 'manufacturer'),
      productName: await readAttr(dir, 'product'),
      serial: await readAttr(dir, 'serial'),
      deviceClass: hex2(await readAttr(dir, 'bDeviceClass')),
      speed: await readAttr(dir, 'speed'),
      busnum: await readAttr(dir, 'busnum'),
      devnum: await readAttr(dir, 'devnum'),
      interfaces: [],
      nodes: [],
      raw: { sysfs: dir },
    });
  }

  for (const { name, dir } of interfaces) {
    const parent = devices.get(name.split(':')[0]);
    if (!parent) continue;
    const driver = await driverOf(dir);
    const nodes = await deviceNodesOf(dir);
    parent.interfaces.push({
      number: await readAttr(dir, 'bInterfaceNumber'),
      class: hex2(await readAttr(dir, 'bInterfaceClass')),
      subclass: hex2(await readAttr(dir, 'bInterfaceSubClass')),
      protocol: hex2(await readAttr(dir, 'bInterfaceProtocol')),
      // The interface string, when the device has one ("MTP", "ADB Interface").
      name: await readAttr(dir, 'interface'),
      driver,
      nodes,
    });
    parent.nodes.push(...nodes);
  }

  const out = [];
  for (const dev of devices.values()) {
    dev.interfaces.sort((a, b) => String(a.number).localeCompare(String(b.number)));
    const drivers = [...new Set(dev.interfaces.map((i) => i.driver).filter(Boolean))];
    dev.driver = {
      // An interface without a driver is not always a problem (e.g. an unused
      // DFU interface), so "bound" means at least one interface has one.
      bound: dev.interfaces.length === 0 ? null : drivers.length > 0,
      names: drivers,
      unboundInterfaces: dev.interfaces.filter((i) => !i.driver).map((i) => i.number),
    };
    dev.nodes = [...new Set(dev.nodes)].sort();
    dev.location = `bus ${dev.busnum} port ${dev.sysName}`;
    out.push(dev);
  }
  return out;
}

module.exports = { listDevices, deviceNodesOf };
