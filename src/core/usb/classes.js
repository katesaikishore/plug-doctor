'use strict';

/**
 * USB base class codes (usb.org "Defined Class Codes"), mapped to the
 * everyday categories the rest of the app reasons about.
 */
const CLASS_NAMES = {
  '00': 'Defined per interface',
  '01': 'Audio',
  '02': 'Communications (CDC)',
  '03': 'Human Interface Device',
  '05': 'Physical',
  '06': 'Still Imaging (camera / scanner)',
  '07': 'Printer',
  '08': 'Mass Storage',
  '09': 'Hub',
  '0a': 'CDC Data',
  '0b': 'Smart Card',
  '0d': 'Content Security',
  '0e': 'Video',
  '0f': 'Personal Healthcare',
  '10': 'Audio/Video',
  '11': 'Billboard',
  '12': 'USB Type-C Bridge',
  'dc': 'Diagnostic',
  'e0': 'Wireless Controller (Bluetooth)',
  'ef': 'Miscellaneous',
  'fe': 'Application Specific (DFU / IrDA / test)',
  'ff': 'Vendor Specific',
};

const CATEGORY_BY_CLASS = {
  '01': 'audio',
  '02': 'serial',
  '03': 'input',
  '06': 'camera',
  '07': 'printer',
  '08': 'storage',
  '09': 'hub',
  '0a': 'serial',
  '0b': 'smartcard',
  '0e': 'camera',
  'e0': 'wireless',
};

/** Printer interface protocols (USB Printer Class 1.1 + IPP-USB). */
const PRINTER_PROTOCOLS = {
  '01': 'unidirectional',
  '02': 'bidirectional',
  '03': 'IEEE 1284.4',
  '04': 'IPP over USB',
};

function hex2(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : parseInt(String(value).replace(/^0x/i, ''), 16);
  if (Number.isNaN(n)) return null;
  return n.toString(16).padStart(2, '0').toLowerCase();
}

function className(code) {
  return CLASS_NAMES[hex2(code)] ?? 'Unknown';
}

/**
 * Categories for a device, from its device class and every interface class.
 * CDC-ACM (class 02 subclass 02) is a serial port; other CDC subclasses are
 * network adapters.
 * @param {{ deviceClass?: string|null, interfaces?: Array<{ class: string|null, subclass?: string|null }> }} device
 * @returns {string[]}
 */
function categoriesFor(device) {
  const out = new Set();
  const consider = (cls, subclass) => {
    const c = hex2(cls);
    if (!c) return;
    if (c === '02' && subclass && hex2(subclass) !== '02') {
      out.add('network');
      return;
    }
    const cat = CATEGORY_BY_CLASS[c];
    if (cat) out.add(cat);
  };
  consider(device.deviceClass);
  for (const itf of device.interfaces ?? []) consider(itf.class, itf.subclass);
  return [...out];
}

module.exports = { CLASS_NAMES, PRINTER_PROTOCOLS, hex2, className, categoriesFor };
