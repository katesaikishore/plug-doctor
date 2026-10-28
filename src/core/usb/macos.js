'use strict';

const { hex2 } = require('./classes');

/**
 * Parse `ioreg -l -w0` text output into a flat list of registry entries.
 * Each entry is `{ name, className, props, depth }`. Values are decoded for the
 * shapes we need (numbers, strings, Yes/No); everything else stays raw text.
 * @param {string} text
 */
function parseIoreg(text) {
  const entries = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const head = rawLine.match(/\+-o (.+?)\s+<class ([\w.]+)/);
    if (head) {
      // The column of "+-o" is the entry's depth in the registry tree.
      current = { name: head[1].replace(/@[0-9a-f]+$/i, ''), className: head[2], props: {}, depth: rawLine.indexOf('+-o') };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const prop = rawLine.replace(/^[\s|]*/, '').match(/^"([^"]+)" = (.*)$/);
    if (!prop) continue;
    current.props[prop[1]] = decodeValue(prop[2].trim());
  }
  return entries;
}

function decodeValue(v) {
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^".*"$/.test(v)) return v.slice(1, -1);
  if (v === 'Yes') return true;
  if (v === 'No') return false;
  return v;
}

/** Registry entries below `entries[index]` in the tree (its subtree). */
function subtree(entries, index) {
  const out = [];
  for (let i = index + 1; i < entries.length && entries[i].depth > entries[index].depth; i++) out.push(entries[i]);
  return out;
}

/**
 * The driver attached to an interface, from its children in the registry:
 * the first child that is not a user client or a USB plumbing object. Serial
 * drivers publish their /dev/cu.* path on an IOSerialBSDClient below them.
 */
function interfaceDriver(entries, index) {
  const below = subtree(entries, index);
  const directDepth = below.length ? Math.min(...below.map((e) => e.depth)) : 0;
  const driver = below.find((e) => e.depth === directDepth && !/UserClient$|^IOUSBHost/.test(e.className));
  const nodes = below.map((e) => e.props.IOCalloutDevice).filter((v) => typeof v === 'string').map((v) => v.replace(/^\/dev\//, ''));
  const bsd = below.map((e) => e.props['BSD Name']).filter((v) => typeof v === 'string');
  return { driver: driver?.className ?? null, nodes: [...nodes, ...bsd] };
}

function vidHex(n) {
  if (n == null) return null;
  return Number(n).toString(16).padStart(4, '0');
}

/**
 * Build normalized devices from two ioreg dumps:
 *   devicesText:    `ioreg -p IOUSB -l -w0`
 *   interfacesText: `ioreg -r -c IOUSBHostInterface -l -w0`
 * @param {string} devicesText
 * @param {string} [interfacesText]
 */
function devicesFromIoreg(devicesText, interfacesText = '') {
  const devs = parseIoreg(devicesText).filter(
    (e) => /IOUSB(Host)?Device/.test(e.className) && e.props.idVendor != null,
  );
  const all = parseIoreg(interfacesText);
  const itfs = all
    .map((e, index) => ({ ...e, ...(/IOUSB(Host)?Interface/.test(e.className) ? interfaceDriver(all, index) : {}) }))
    .filter((e) => /IOUSB(Host)?Interface/.test(e.className));

  return devs.map((e) => {
    const p = e.props;
    const vendorId = vidHex(p.idVendor);
    const productId = vidHex(p.idProduct);
    const location = p.locationID != null ? `0x${Number(p.locationID).toString(16).padStart(8, '0')}` : null;
    const mine = itfs.filter(
      (i) =>
        vidHex(i.props.idVendor) === vendorId &&
        vidHex(i.props.idProduct) === productId &&
        (i.props.locationID == null || p.locationID == null || i.props.locationID === p.locationID),
    );
    return {
      id: null,
      vendorId,
      productId,
      vendorName: p['USB Vendor Name'] ?? p['kUSBVendorString'] ?? null,
      productName: p['USB Product Name'] ?? p['kUSBProductString'] ?? e.name,
      serial: p['USB Serial Number'] ?? p['kUSBSerialNumberString'] ?? null,
      deviceClass: hex2(p.bDeviceClass),
      speed: p.Speed != null ? String(p.Speed) : null,
      location,
      interfaces: mine.map((i) => ({
        number: i.props.bInterfaceNumber != null ? String(i.props.bInterfaceNumber) : null,
        class: hex2(i.props.bInterfaceClass),
        subclass: hex2(i.props.bInterfaceSubClass),
        protocol: hex2(i.props.bInterfaceProtocol),
        driver: i.driver ?? null,
        nodes: i.nodes ?? [],
      })),
      nodes: mine.flatMap((i) => i.nodes ?? []),
      driver: {
        // Without the interface dump we cannot tell, so say so rather than guess.
        bound: mine.length === 0 ? null : mine.some((i) => i.driver),
        names: [...new Set(mine.map((i) => i.driver).filter(Boolean))],
        unboundInterfaces: mine.filter((i) => !i.driver).map((i) => (i.props.bInterfaceNumber != null ? String(i.props.bInterfaceNumber) : null)),
      },
      raw: { ioreg: p },
    };
  });
}

/** List USB devices on macOS. `run` is injectable for tests. */
async function listDevices({ run }) {
  const devices = await run('ioreg', ['-p', 'IOUSB', '-l', '-w0']);
  if (!devices.ok) return [];
  const interfaces = await run('ioreg', ['-r', '-c', 'IOUSBHostInterface', '-l', '-w0']);
  const list = devicesFromIoreg(devices.stdout, interfaces.ok ? interfaces.stdout : '');
  // Skip the root hubs and the T2/Apple internal controllers.
  return list.filter((d) => d.deviceClass !== '09');
}

module.exports = { parseIoreg, devicesFromIoreg, listDevices };
