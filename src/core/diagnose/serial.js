'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const { check, plan } = require('./helpers');

/**
 * USB-to-serial adapters and dev boards (Arduino, ESP32, 3D printers, CNC,
 * GPS, ham radio). The classic failures: no driver, the port is grabbed by
 * another service, or the user is not allowed to open it.
 */

const SERIAL_GROUPS = ['dialout', 'uucp', 'tty', 'plugdev'];

async function linuxSerial(device, ctx) {
  const { run } = ctx;
  const checks = [];
  const plans = [];
  const nodes = device.nodes.filter((n) => /^tty(USB|ACM)\d+$/.test(n));
  const facts = { ports: nodes.map((n) => `/dev/${n}`) };

  if (nodes.length === 0) {
    checks.push(check('port', 'Serial port created', 'fail', 'No /dev/ttyUSB* or /dev/ttyACM* appeared for this device.'));
    // Ubuntu 22.04+ ships brltty, whose udev rule grabs CH340/CP210x/FTDI
    // adapters because some braille displays reuse those chips.
    const brltty = await run('systemctl', ['is-active', 'brltty-udev.service']);
    const brlttyInstalled = !brltty.missing && /^(active|inactive|activating)/.test(brltty.stdout.trim());
    if (brlttyInstalled) {
      checks.push(check('brltty', 'Port not taken by a braille-display service', 'fail', 'brltty is installed and claims USB serial chips like this one, so the port disappears right after you plug it in.'));
      plans.push(
        plan({
          id: 'disable-brltty-udev',
          title: 'Stop the braille service from grabbing serial adapters',
          why: 'This is a well-known Ubuntu problem. It only turns off brltty\'s USB auto-start; if you use a braille display, skip this.',
          confidence: 0.85,
          steps: [
            { kind: 'command', title: 'Stop brltty-udev', explain: 'Stops the service now.', cmd: 'systemctl', args: ['stop', 'brltty-udev.service'], admin: true, safe: true, optional: true },
            { kind: 'command', title: 'Keep it off', explain: 'Prevents it from starting again.', cmd: 'systemctl', args: ['mask', 'brltty-udev.service'], admin: true, safe: true },
            { kind: 'manual', title: 'Unplug and replug the device', explain: 'Then press "Check again".' },
          ],
        }),
      );
      return { status: 'broken', headline: 'A braille-display service is stealing this serial port.', checks, plans, facts };
    }
    if (!device.driver.bound) {
      checks.push(check('driver', 'Kernel driver loaded', 'fail', 'No driver claimed the device.'));
      const module = { '0403': 'ftdi_sio', '1a86': 'ch341', '10c4': 'cp210x', '067b': 'pl2303' }[device.vendorId];
      if (module) {
        plans.push(
          plan({
            id: 'load-module',
            title: `Load the ${module} driver`,
            why: `Linux has a built-in driver (${module}) for this chip; it just was not loaded.`,
            confidence: 0.7,
            auto: true,
            steps: [{ kind: 'command', title: `Load ${module}`, explain: 'Loads the kernel driver for this USB-serial chip.', cmd: 'modprobe', args: [module], admin: true, safe: true }],
          }),
        );
      }
    }
    return { status: 'broken', headline: 'The device is connected but no serial port appeared.', checks, plans, facts };
  }
  checks.push(check('port', 'Serial port created', 'pass', facts.ports.join(', ')));

  const groupRes = await run('stat', ['-c', '%G', facts.ports[0]]);
  const group = groupRes.ok ? groupRes.stdout.trim() : null;
  const mine = (await run('id', ['-nG'])).stdout.trim().split(/\s+/);
  facts.portGroup = group;
  if (group && SERIAL_GROUPS.includes(group) && !mine.includes(group) && !mine.includes('root')) {
    const user = os.userInfo().username;
    checks.push(check('permission', 'You are allowed to open the port', 'fail', `${facts.ports[0]} belongs to the "${group}" group and your account is not in it.`));
    plans.push(
      plan({
        id: 'join-group',
        title: `Give your account access to serial ports`,
        why: `Adds "${user}" to the "${group}" group, the standard way to allow serial port access on Linux.`,
        confidence: 0.9,
        auto: false,
        steps: [
          { kind: 'command', title: `Add ${user} to ${group}`, explain: 'One-time permission change.', cmd: 'usermod', args: ['-aG', group, user], admin: true, safe: true },
          { kind: 'manual', title: 'Log out and back in', explain: 'Group changes apply after you sign in again.' },
        ],
      }),
    );
    return { status: 'needs-fix', headline: 'The port exists but your account is not allowed to use it.', checks, plans, facts };
  }
  checks.push(check('permission', 'You are allowed to open the port', 'pass'));
  return { status: 'ok', headline: `Ready on ${facts.ports.join(', ')}.`, checks, plans, facts };
}

async function macSerial(device, ctx) {
  const checks = [];
  const plans = [];
  let entries = [];
  try {
    entries = await (ctx.readDir ?? fs.readdir)('/dev');
  } catch {
    entries = [];
  }
  const ports = entries.filter((n) => /^cu\.(usbserial|usbmodem|wchusbserial|SLAB_USBtoUART)/.test(n)).map((n) => `/dev/${n}`);
  const facts = { ports };
  if (ports.length) {
    checks.push(check('port', 'Serial port created', 'pass', ports.join(', ')));
    return { status: 'ok', headline: `Ready on ${ports.join(', ')}.`, checks, plans, facts };
  }
  checks.push(check('port', 'Serial port created', 'fail', 'No /dev/cu.* port appeared.'));
  const vendorPage = {
    '10c4': 'https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers',
    '1a86': 'https://www.wch-ic.com/downloads/CH34XSER_MAC_ZIP.html',
    '0403': 'https://ftdichip.com/drivers/vcp-drivers/',
    '067b': 'https://www.prolific.com.tw/US/ShowProduct.aspx?p_id=229&pcid=41',
  }[device.vendorId];
  if (vendorPage) {
    plans.push(
      plan({
        id: 'vendor-driver',
        title: 'Install the chip maker\'s driver',
        why: 'macOS has no built-in driver that matched this chip. Its maker publishes a free one.',
        confidence: 0.6,
        steps: [
          { kind: 'open-url', title: 'Open the driver download page', explain: 'Download and install the macOS driver, then allow it in System Settings > Privacy & Security.', url: vendorPage },
          { kind: 'manual', title: 'Unplug and replug the device', explain: 'Then press "Check again".' },
        ],
      }),
    );
  }
  return { status: 'broken', headline: 'No serial port appeared for this device.', checks, plans, facts };
}

async function windowsSerial(device) {
  if (!device.problem) {
    return { status: 'ok', headline: 'Windows has a driver for this serial device.', checks: [check('driver', 'Windows has a driver', 'pass', device.driver.names.join(', '))], plans: [], facts: {} };
  }
  return {
    status: 'broken',
    headline: 'Windows has no working driver for this serial device.',
    checks: [check('driver', 'Windows has a driver', 'fail', device.problem.message)],
    plans: [
      plan({
        id: 'windows-update',
        title: 'Ask Windows to look for a driver',
        why: 'Windows Update carries drivers for FTDI, CH340, CP210x and Prolific chips.',
        confidence: 0.6,
        auto: true,
        steps: [{ kind: 'command', title: 'Re-scan devices', explain: 'Asks Windows to re-detect hardware and fetch a driver.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true }],
      }),
    ],
    facts: { problemCode: device.problem.code },
  };
}

async function diagnoseSerial(device, ctx) {
  if (ctx.platform === 'linux') return linuxSerial(device, ctx);
  if (ctx.platform === 'darwin') return macSerial(device, ctx);
  return windowsSerial(device, ctx);
}

/** Chips that show up as vendor-specific (class ff) but are serial adapters. */
const SERIAL_CHIP_VENDORS = new Set(['0403', '1a86', '10c4', '067b']);

module.exports = { diagnoseSerial, SERIAL_CHIP_VENDORS };
