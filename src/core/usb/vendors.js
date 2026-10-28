'use strict';

/**
 * Vendor IDs people actually plug in. The full list lives in the usb.ids
 * database (http://www.linux-usb.org/usb.ids); this subset keeps the app
 * small and is only used when the device itself does not report a vendor
 * string.
 */
const VENDORS = {
  '03f0': 'HP',
  '04a9': 'Canon',
  '04b8': 'Epson',
  '04f9': 'Brother',
  '043d': 'Lexmark',
  '04e8': 'Samsung',
  '0924': 'Xerox',
  '0482': 'Kyocera',
  '04da': 'Panasonic',
  '0a5f': 'Zebra',
  '0dd4': 'Custom Engineering',
  '0416': 'Winbond (generic thermal printers)',
  '0fe6': 'ICS Advent (generic receipt printers)',
  '05ac': 'Apple',
  '045e': 'Microsoft',
  '046d': 'Logitech',
  '0781': 'SanDisk',
  '0951': 'Kingston',
  '090c': 'Silicon Motion',
  '058f': 'Alcor Micro',
  '0bda': 'Realtek',
  '152d': 'JMicron',
  '174c': 'ASMedia',
  '1058': 'Western Digital',
  '0bc2': 'Seagate',
  '0403': 'FTDI',
  '1a86': 'QinHeng (WCH)',
  '10c4': 'Silicon Labs',
  '067b': 'Prolific',
  '2341': 'Arduino',
  '2e8a': 'Raspberry Pi',
  '303a': 'Espressif',
  '0483': 'STMicroelectronics',
  '1366': 'SEGGER',
  '0525': 'Netchip (Linux gadget)',
  '18d1': 'Google',
  '22b8': 'Motorola',
  '2717': 'Xiaomi',
  '0fce': 'Sony Mobile',
  '054c': 'Sony',
  '0b05': 'ASUS',
  '8087': 'Intel',
  '0a12': 'Cambridge Silicon Radio (Bluetooth)',
  '0cf3': 'Qualcomm Atheros',
  '148f': 'Ralink / MediaTek',
  '0e8d': 'MediaTek',
  '2357': 'TP-Link',
  '0846': 'NETGEAR',
  '1d6b': 'Linux Foundation (root hub)',
};

function vendorName(vendorId) {
  if (!vendorId) return null;
  return VENDORS[String(vendorId).toLowerCase()] ?? null;
}

module.exports = { VENDORS, vendorName };
