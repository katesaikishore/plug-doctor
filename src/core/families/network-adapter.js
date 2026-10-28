'use strict';

const { check, plan } = require('./helpers');

/**
 * USB Ethernet and Wi-Fi adapters. Standard USB Ethernet (CDC-ECM, CDC-NCM)
 * works out of the box on macOS and Linux; a few popular chips have their own
 * Linux drivers. USB Wi-Fi dongles are the hard case: they all need the chip
 * maker's driver, and Macs with Apple silicon have none.
 */

/** Phones tether over RNDIS/NCM too; the phone family handles these vendors. */
const PHONE_VENDORS = new Set(['05ac', '18d1', '04e8', '22b8', '2717', '2a70', '12d1', '0bb4', '1004', '0fce', '22d9']);

/** Popular USB Ethernet chips and their Linux drivers. */
const ETHERNET_CHIPS = {
  '0bda:8152': { chip: 'Realtek RTL8152', module: 'r8152' },
  '0bda:8153': { chip: 'Realtek RTL8153', module: 'r8152' },
  '0b95:1790': { chip: 'ASIX AX88179', module: 'ax88179_178a' },
};

/** Linux modules for the standard USB networking protocols. */
const PROTOCOL_MODULE = { 'CDC-ECM': 'cdc_ether', 'CDC-NCM': 'cdc_ncm', RNDIS: 'rndis_host' };

/** Wi-Fi dongle makers. Realtek and MediaTek make other things too, so those need more evidence. */
const WIFI_VENDORS = { '0bda': 'Realtek', '0e8d': 'MediaTek', '148f': 'MediaTek (Ralink)', '2357': 'TP-Link', '0846': 'NETGEAR', '7392': 'Edimax' };
const WIFI_ONLY_VENDORS = new Set(['148f', '2357', '0846', '7392']);
const WIFI_NAME = /\b(wlan|wi-?fi|wireless|802\.11[a-z/]*)\b/i;
const WIFI_DRIVER = /^(rtl8xxxu|rtl8192cu|rtl8188eu|r8188eu|rtw88_|rtw89_|rtw_|8188|8192|8812|8821|8814|88x2bu|88xxau|mt7601u|mt76x0u|mt76x2u|mt7921u|mt7925u|rt2800usb|rt2500usb|rt73usb|ath9k_htc|carl9170|ar5523|zd1211rw)/i;
const ETHERNET_NAME = /\b(ethernet|gigabit|gbe)\b|(^|[^w])lan\b/i;
const ETHERNET_DRIVER = /^(r8152|ax88179_178a|asix|cdc_ether|cdc_ncm|rndis_host|smsc95xx|lan78xx|aqc111|r8153_ecm)$/;

const isRndis = (i) => (i.class === 'e0' && i.subclass === '01' && i.protocol === '03') || (i.class === 'ef' && i.subclass === '04' && i.protocol === '01') || (i.class === '02' && i.subclass === '02' && i.protocol === 'ff');

const MAC_WIFI_ADVICE = "Use the Mac's built-in Wi-Fi, or a USB Ethernet adapter for a wired connection: those work without any driver.";

/**
 * What kind of adapter this is, or null when it is not one.
 * @returns {{ kind: 'ethernet'|'wifi', protocol: string|null, chip: string|null, module: string|null } | null}
 */
function adapterKind(device) {
  if (PHONE_VENDORS.has(device.vendorId)) return null;
  const itfs = device.interfaces ?? [];
  const usbId = `${device.vendorId}:${device.productId}`;
  const known = ETHERNET_CHIPS[usbId];
  const cdc = itfs.find((i) => i.class === '02' && (i.subclass === '06' || i.subclass === '0d'));
  if (cdc) {
    const protocol = cdc.subclass === '0d' ? 'CDC-NCM' : 'CDC-ECM';
    return { kind: 'ethernet', protocol, chip: known?.chip ?? null, module: PROTOCOL_MODULE[protocol] };
  }
  if (itfs.some(isRndis)) return { kind: 'ethernet', protocol: 'RNDIS', chip: null, module: PROTOCOL_MODULE.RNDIS };
  if (known) return { kind: 'ethernet', protocol: null, chip: known.chip, module: known.module };

  const vendorSpecific = itfs.length > 0 && itfs.every((i) => i.class === 'ff');
  if (!vendorSpecific || !WIFI_VENDORS[device.vendorId]) return null;
  const names = [device.productName, ...itfs.map((i) => i.name)].filter(Boolean).join(' ');
  const drivers = itfs.map((i) => i.driver).filter(Boolean);
  if (drivers.some((d) => ETHERNET_DRIVER.test(d)) || ETHERNET_NAME.test(names)) return { kind: 'ethernet', protocol: null, chip: null, module: null };
  const wifi = drivers.some((d) => WIFI_DRIVER.test(d)) || WIFI_NAME.test(names) || WIFI_ONLY_VENDORS.has(device.vendorId);
  return wifi ? { kind: 'wifi', protocol: null, chip: null, module: null } : null;
}

function matchAdapter(d) {
  const a = adapterKind(d);
  if (!a) return 0;
  if (a.chip) return 80;
  // Above serial (70): ECM/NCM adapters also carry a CDC data interface.
  if (a.protocol === 'CDC-ECM' || a.protocol === 'CDC-NCM') return 75;
  if (a.protocol === 'RNDIS') return 65;
  return 70;
}

// ---------------------------------------------------------------- parsers

/**
 * `ls -l /sys/class/net`: interface name -> sysfs path. The path runs through
 * the USB interface ("…/usb2/2-1/2-1:2.0/net/enx…"), which ties a network
 * interface to the USB device without guessing.
 */
function parseSysClassNet(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/\s(\S+) -> (\S+)\s*$/);
    if (m) out.push({ name: m[1], path: m[2] });
  }
  return out;
}

/** `ip -o link`: { name, flags, state }. */
function parseIpLink(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\d+:\s+([^:@\s]+)(?:@\S+)?:\s+<([^>]*)>(.*)$/);
    if (!m) continue;
    const state = (m[3].match(/\bstate (\S+)/) ?? [])[1] ?? null;
    out.push({ name: m[1], flags: m[2].split(','), state });
  }
  return out;
}

/** `networksetup -listallhardwareports`: { port, device }. */
function parseHardwarePorts(text) {
  const out = [];
  let port = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const p = line.match(/^Hardware Port:\s*(.+)$/);
    if (p) port = p[1].trim();
    const d = line.match(/^Device:\s*(\S+)/);
    if (d && port) {
      out.push({ port, device: d[1] });
      port = null;
    }
  }
  return out;
}

/** `ifconfig en7`: link status ("active" / "inactive") and IPv4 address. */
function parseIfconfig(text) {
  const s = String(text ?? '');
  return { status: (s.match(/^\s*status:\s*(\S+)/m) ?? [])[1] ?? null, ipv4: (s.match(/^\s*inet (\d+\.\d+\.\d+\.\d+)/m) ?? [])[1] ?? null };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// ---------------------------------------------------------------- per OS

function what(a) {
  return a.kind === 'wifi' ? 'Wi-Fi adapter' : 'network adapter';
}

async function linuxAdapter(device, ctx, a) {
  const { run } = ctx;
  const checks = [];
  const plans = [];
  const facts = { kind: what(a), ...(a.protocol ? { protocol: a.protocol } : {}), ...(a.chip ? { chip: a.chip } : {}) };

  if (!device.driver?.bound) {
    checks.push(check('driver', 'Network driver attached', 'fail', 'No driver claimed the adapter.'));
    if (a.module) {
      plans.push(
        plan({
          id: 'load-module',
          title: `Load the ${a.module} driver`,
          why: `Linux has a built-in driver (${a.module}) for this adapter; it just was not loaded.`,
          confidence: 0.7,
          auto: true,
          steps: [{ kind: 'command', title: `Load ${a.module}`, explain: 'Loads the kernel driver for this network adapter.', cmd: 'modprobe', args: [a.module], admin: true, safe: true }],
        }),
      );
      return { status: 'broken', headline: 'The network driver for this adapter is not loaded.', checks, plans, facts };
    }
    if (a.kind === 'wifi') {
      checks.push(
        check(
          'chipset',
          'A Linux driver for its chip',
          'warn',
          `Many USB Wi-Fi chips need a driver that is not part of Linux. Search for the adapter's USB ID (${device.vendorId}:${device.productId}) to find out which chip it has and whether your distribution packages a driver for it.`,
        ),
      );
      return { status: 'broken', headline: 'Linux has no driver loaded for this Wi-Fi adapter.', checks, plans, facts };
    }
    return { status: 'broken', headline: 'No driver is handling this network adapter.', checks, plans, facts };
  }
  checks.push(check('driver', 'Network driver attached', 'pass', device.driver.names.join(', ')));

  // Which network interface belongs to this USB device, from sysfs links.
  const ls = await run('ls', ['-l', '/sys/class/net']);
  const sys = device.sysName ? `/${device.sysName}:` : null;
  const mine = sys ? parseSysClassNet(ls.stdout).filter((l) => l.path.includes(sys)).map((l) => l.name) : [];
  const links = parseIpLink((await run('ip', ['-o', 'link', 'show'])).stdout);

  if (mine.length === 0) {
    if (ls.ok && sys) {
      checks.push(
        check(
          'interface',
          'Network interface created',
          'fail',
          a.kind === 'wifi' ? 'The driver loaded but no Wi-Fi interface appeared. The chip firmware may be missing: check that your distribution\'s firmware package (often "linux-firmware") is installed.' : 'The driver loaded but no network interface appeared.',
        ),
      );
      return { status: 'broken', headline: 'The adapter has a driver but no network interface appeared.', checks, plans, facts };
    }
    // Could not tie interfaces to this device: list the likely candidates for information.
    const guess = links.filter((l) => /^(enx|eth|wlx|wlan)/.test(l.name)).map((l) => l.name);
    checks.push(check('interface', 'Network interface created', 'info', guess.length ? `Possible interfaces: ${guess.join(', ')}.` : 'Could not tell which network interface belongs to this adapter.'));
    return { status: 'ok', headline: `The ${what(a)} has a working driver.`, checks, plans, facts };
  }

  facts.interfaces = mine;
  checks.push(check('interface', 'Network interface created', 'pass', mine.join(', ')));
  const link = links.find((l) => l.name === mine[0]);
  if (link) {
    facts.state = link.state;
    if (a.kind === 'ethernet') {
      const noCarrier = link.flags.includes('NO-CARRIER');
      const up = link.flags.includes('LOWER_UP') || link.state === 'UP';
      checks.push(check('link', 'Cable connected', up && !noCarrier ? 'pass' : 'warn', up && !noCarrier ? 'The adapter sees a live network on the cable.' : 'No network on the cable. Check that the cable is plugged in at both ends and the router or switch is on.'));
      if (!up || noCarrier) return { status: 'needs-fix', headline: `Ready as ${mine[0]}, but no live network cable is connected.`, checks, plans, facts };
    } else {
      checks.push(check('link', 'Connected to a network', link.state === 'UP' ? 'pass' : 'info', link.state === 'UP' ? 'Connected.' : 'Not connected yet. Pick a network from the Wi-Fi menu.'));
    }
  }
  return { status: 'ok', headline: a.kind === 'wifi' ? `Ready as ${mine[0]}. Pick a network from the Wi-Fi menu.` : `Ready as ${mine[0]}.`, checks, plans, facts };
}

async function macAdapter(device, ctx, a) {
  const { run } = ctx;
  const checks = [];
  const facts = { kind: what(a), ...(a.protocol ? { protocol: a.protocol } : {}), ...(a.chip ? { chip: a.chip } : {}) };

  if (a.kind === 'wifi') {
    const arm = ctx.arch === 'arm64';
    checks.push(check('support', 'macOS has a driver', 'fail', `${arm ? 'Macs with Apple silicon have' : 'macOS has'} no drivers for USB Wi-Fi adapters. ${MAC_WIFI_ADVICE}`));
    return {
      status: 'broken',
      headline: arm ? 'USB Wi-Fi adapters cannot work on Macs with Apple silicon.' : 'macOS has no driver for this Wi-Fi adapter.',
      checks,
      plans: [],
      facts,
      support: arm
        ? { level: 'unsupported', note: `There are no working drivers for USB Wi-Fi adapters on Macs with Apple silicon. ${MAC_WIFI_ADVICE}` }
        : { level: 'vendor-driver', note: `Some makers published drivers for older macOS versions on Intel Macs; most were never updated. ${MAC_WIFI_ADVICE}` },
    };
  }
  if (a.protocol === 'RNDIS') {
    checks.push(check('support', 'macOS has a driver', 'fail', 'macOS has no driver for RNDIS, the Windows-style USB networking this device uses. If it has a setting for "ECM" or "NCM" mode, switch to that.'));
    return {
      status: 'broken',
      headline: 'macOS cannot use this kind of USB network connection (RNDIS).',
      checks,
      plans: [],
      facts,
      support: { level: 'unsupported', note: 'macOS has no RNDIS driver. Devices that also offer CDC-ECM or CDC-NCM work natively in that mode.' },
    };
  }

  // The interface's BSD name (en7) comes from the registry; networksetup is the fallback.
  let names = (device.nodes ?? []).filter((n) => /^en\d+$/.test(n));
  if (names.length === 0) {
    const ports = parseHardwarePorts((await run('networksetup', ['-listallhardwareports'])).stdout);
    const product = norm(device.productName);
    const hits = ports.filter((p) => product.length >= 3 && norm(p.port) === product);
    if (hits.length === 1) names = [hits[0].device];
  }
  if (names.length === 0) {
    if (device.driver?.bound === false) {
      checks.push(check('interface', 'Network interface created', 'fail', 'macOS did not attach a network driver to this adapter.'));
      return { status: 'broken', headline: 'macOS did not make this adapter a network connection.', checks, plans: [], facts };
    }
    checks.push(check('interface', 'Network interface created', 'info', 'Could not tell which network interface belongs to this adapter.'));
    return { status: 'unknown', headline: 'Connected. Plug Doctor could not tell which network connection is this adapter.', checks, plans: [], facts };
  }
  facts.interfaces = names;
  checks.push(check('interface', 'Network interface created', 'pass', names.join(', ')));
  const ifc = parseIfconfig((await run('ifconfig', [names[0]])).stdout);
  if (ifc.status) {
    facts.link = ifc.status;
    const active = ifc.status === 'active';
    checks.push(check('link', 'Cable connected', active ? 'pass' : 'warn', active ? `Connected${ifc.ipv4 ? `, address ${ifc.ipv4}` : ''}.` : 'No network on the cable. Check that the cable is plugged in at both ends and the router or switch is on.'));
    if (!active) return { status: 'needs-fix', headline: `Ready as ${names[0]}, but no live network cable is connected.`, checks, plans: [], facts };
  }
  return { status: 'ok', headline: `Ready as ${names[0]}.`, checks, plans: [], facts };
}

async function windowsAdapter(device, ctx, a) {
  const facts = { kind: what(a), ...(a.protocol ? { protocol: a.protocol } : {}), ...(a.chip ? { chip: a.chip } : {}) };
  if (!device.problem) {
    return {
      status: 'ok',
      headline: a.kind === 'wifi' ? 'Ready. Pick a network from the Wi-Fi menu in the taskbar.' : `Windows has a driver for this ${what(a)}.`,
      checks: [check('driver', 'Windows has a working driver', 'pass', device.driver?.names?.join(', ') ?? '')],
      plans: [],
      facts,
    };
  }
  return {
    status: 'broken',
    headline: `Windows has no working driver for this ${what(a)}.`,
    checks: [check('driver', 'Windows has a working driver', 'fail', device.problem.message)],
    plans: [
      plan({
        id: 'windows-update',
        title: 'Ask Windows to look for a driver',
        why: 'Windows Update has drivers for most USB network and Wi-Fi adapters. This makes Windows search again.',
        confidence: 0.6,
        auto: true,
        steps: [{ kind: 'command', title: 'Re-scan devices', explain: 'Asks Windows to re-detect hardware and fetch a driver.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true }],
      }),
    ],
    facts: { ...facts, problemCode: device.problem.code },
  };
}

async function diagnoseAdapter(device, ctx) {
  const a = adapterKind(device) ?? { kind: 'ethernet', protocol: null, chip: null, module: null };
  if (ctx.platform === 'linux') return linuxAdapter(device, ctx, a);
  if (ctx.platform === 'darwin') return macAdapter(device, ctx, a);
  return windowsAdapter(device, ctx, a);
}

/** @type {import('./index').Family} */
const family = {
  id: 'network-adapter',
  label: 'Network adapter',
  icon: 'adapter',
  sources: ['usb'],
  match: matchAdapter,
  diagnose: diagnoseAdapter,
};

module.exports = { family, diagnoseAdapter, adapterKind, parseSysClassNet, parseIpLink, parseHardwarePorts, parseIfconfig };
