'use strict';

const { run: defaultRun } = require('../exec');
const { categoriesFor, className } = require('./classes');
const { vendorName } = require('./vendors');
const linux = require('./linux');
const macos = require('./macos');
const windows = require('./windows');

/**
 * Stable ID for a device across polls: VID:PID plus serial when it has one,
 * otherwise plus where it is plugged in.
 */
function deviceKey(d) {
  const tail = d.serial || d.location || d.sysName || 'noserial';
  return `${d.vendorId}:${d.productId}:${tail}`.replace(/\s+/g, '_');
}

/**
 * "HP LaserJet 1020", not "Hewlett-Packard HP LaserJet 1020": drop the
 * vendor when the product name already starts with it or its initials.
 */
function displayName(vendor, product) {
  if (!vendor) return product;
  if (!product) return vendor;
  const first = product.split(/\s+/)[0].toLowerCase();
  const words = vendor.split(/[\s-]+/).filter(Boolean);
  const initials = words.map((w) => w[0]).join('').toLowerCase();
  if (first === words[0].toLowerCase() || (words.length > 1 && first === initials)) return product;
  return `${vendor} ${product}`;
}

function finalize(d, platform) {
  const categories = categoriesFor(d);
  const vendor = d.vendorName || vendorName(d.vendorId);
  const product = d.productName || `${className(d.deviceClass)} device`;
  return {
    ...d,
    id: deviceKey(d),
    platform,
    vendorName: vendor,
    productName: product,
    displayName: displayName(vendor, product),
    categories: categories.length ? categories : ['unknown'],
    problem: d.problem ?? null,
  };
}

/**
 * List the USB devices on this machine in one normalized shape.
 * @param {{ platform?: NodeJS.Platform, run?: typeof defaultRun, sysfsRoot?: string }} [ctx]
 */
async function listDevices(ctx = {}) {
  const platform = ctx.platform ?? process.platform;
  const run = ctx.run ?? defaultRun;
  let list;
  if (platform === 'linux') list = await linux.listDevices({ sysfsRoot: ctx.sysfsRoot });
  else if (platform === 'darwin') list = await macos.listDevices({ run });
  else if (platform === 'win32') list = await windows.listDevices({ run });
  else list = [];
  return list
    .map((d) => finalize(d, platform))
    .filter((d) => !d.categories.includes('hub') && d.vendorId !== '1d6b');
}

module.exports = { listDevices, deviceKey, finalize, displayName };
