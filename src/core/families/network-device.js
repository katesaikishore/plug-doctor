'use strict';

/**
 * Devices on the home network: network printers and scanners, smart TVs,
 * AirPlay and Chromecast receivers, speakers and HomeKit accessories.
 * Most of these need no driver at all; the useful answer is "here is how
 * you use it from this computer", plus a one-click setup for printers.
 */

const cups = require('../printer/cups');
const { installStep } = require('../fix/packages');
const { check, plan, testPagePath } = require('./helpers');

const PRINT_TYPES = ['_ipp._tcp', '_ipps._tcp', '_printer._tcp', '_pdl-datastream._tcp'];
const SCAN_TYPES = ['_uscan._tcp', '_uscans._tcp'];
const SEVERITY = { ok: 0, unknown: 1, 'needs-fix': 2, broken: 3 };

const services = (device) => device.details?.services ?? [];
const svc = (device, type) => services(device).find((s) => s.type === type) ?? null;
const hasType = (device, types) => services(device).some((s) => types.includes(s.type));
const cats = (device) => device.categories ?? [];
const nameOf = (device) => device.displayName || device.details?.host || 'this device';

const openSettings = (title, explain, uri) => ({ kind: 'command', title, explain, cmd: 'explorer.exe', args: [uri], admin: false, safe: true });
const openMac = (title, explain, args) => ({ kind: 'command', title, explain, cmd: 'open', args, admin: false, safe: true });

/** A host name or address that is safe to put in a printer URI. */
function uriHost(device, svcHost) {
  const host = String(svcHost ?? device.details?.host ?? '').replace(/\.$/, '');
  if (/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)) return host;
  const addrs = device.details?.addresses ?? [];
  const v4 = addrs.find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
  if (v4) return v4;
  const v6 = addrs.find((a) => /^[0-9a-f:]+$/i.test(a) && !/^fe80:/i.test(a));
  return v6 ? `[${v6}]` : null;
}

/** IPP resource path from TXT `rp`: letters, digits and a few path characters only. */
function resourcePath(rp) {
  const p = String(rp ?? 'ipp/print').replace(/^\/+/, '');
  return /^[A-Za-z0-9._~\/-]{0,128}$/.test(p) ? p : 'ipp/print';
}

/** The printer says it takes IPP Everywhere (PWG raster) or AirPrint (URF) jobs. */
function isDriverless(txt = {}) {
  const pdl = String(txt.pdl ?? '').toLowerCase();
  const urf = typeof txt.urf === 'string' ? txt.urf.trim().toLowerCase() : '';
  return pdl.includes('image/pwg-raster') || pdl.includes('image/urf') || (urf !== '' && urf !== 'none');
}

/** A CUPS queue that already points at this device (by host, address or Bonjour name). */
function findQueue(device, queues) {
  const host = String(device.details?.host ?? '').toLowerCase().replace(/\.$/, '');
  const addrs = (device.details?.addresses ?? []).map((a) => a.toLowerCase());
  const names = services(device)
    .filter((s) => PRINT_TYPES.includes(s.type) && s.name)
    .map((s) => s.name.toLowerCase());
  const queueNames = new Set(
    services(device)
      .filter((s) => PRINT_TYPES.includes(s.type))
      .flatMap((s) => [s.name, s.txt?.ty])
      .filter(Boolean)
      .map((n) => cups.queueNameFor(n).toLowerCase()),
  );
  return (
    queues.find((q) => {
      let decoded = q.uri;
      try {
        decoded = decodeURIComponent(q.uri);
      } catch {
        // keep it as it is
      }
      decoded = decoded.toLowerCase();
      let hostname = null;
      try {
        hostname = new URL(q.uri).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
      } catch {
        // not a URL
      }
      if (hostname && ((host && hostname === host) || addrs.includes(hostname))) return true;
      if (decoded.startsWith('dnssd://') && names.some((n) => decoded.startsWith(`dnssd://${n}.`))) return true;
      return !q.uri.startsWith('usb:') && queueNames.has(q.queue.toLowerCase());
    }) ?? null
  );
}

// ---------------------------------------------------------------- printer

async function printerCups(device, ctx) {
  const checks = [];
  const plans = [];
  const facts = {};
  const name = nameOf(device);
  const ippSvc = svc(device, '_ipp._tcp') ?? svc(device, '_ipps._tcp');

  if (ctx.platform === 'darwin') {
    checks.push(check('airprint', 'Print from any app', 'info', `On a Mac you can usually just pick "${name}" in the Print dialog; macOS adds AirPrint printers by itself.`));
  }

  const lpstat = await ctx.run('lpstat', ['-v']);
  if (lpstat.missing) {
    checks.push(check('cups', 'Print system (CUPS) installed', 'fail', 'The CUPS printing tools are not installed.'));
    if (ctx.platform === 'linux') {
      plans.push(
        plan({
          id: 'install-cups',
          title: 'Install the print system',
          why: 'Linux needs CUPS to print. Plug Doctor will install it, then you can press "Check again".',
          confidence: 0.9,
          steps: [installStep({ apt: ['cups'], dnf: ['cups'], pacman: ['cups'], zypper: ['cups'] }, ctx.manager)],
          auto: true,
        }),
      );
    }
    return { status: 'broken', headline: `Found ${name} on your network, but this computer has no print system.`, checks, plans, facts, support: 'app' };
  }
  if (/scheduler is not running/i.test(lpstat.stderr ?? '')) {
    checks.push(check('cups', 'Print system (CUPS) running', 'fail', 'The print service is installed but not running.'));
    if (ctx.platform === 'linux') {
      plans.push(
        plan({
          id: 'start-cups',
          title: 'Start the print service',
          why: 'Printing needs the CUPS service running. Starting it changes nothing else.',
          confidence: 0.8,
          auto: true,
          steps: [{ kind: 'command', title: 'Start CUPS', explain: 'Starts the print service now and every time the computer starts.', cmd: 'systemctl', args: ['enable', '--now', 'cups'], admin: true, safe: true }],
        }),
      );
    }
    return { status: 'broken', headline: 'The print service on this computer is not running.', checks, plans, facts, support: 'app' };
  }
  checks.push(check('cups', 'Print system (CUPS) installed', 'pass'));

  const queues = cups.parseLpstatDevices(lpstat.stdout);
  const existing = findQueue(device, queues);
  if (existing) {
    facts.queue = existing.queue;
    facts.uri = existing.uri;
    const state = cups.parseLpstatPrinters((await ctx.run('lpstat', ['-p', existing.queue])).stdout)[0];
    if (state?.state === 'disabled') {
      checks.push(check('queue', 'Printer is set up', 'warn', `"${existing.queue}" exists but is paused: ${state.detail}`));
      plans.push(
        plan({
          id: 'resume-queue',
          title: 'Resume the printer',
          why: 'The printer is set up but paused, usually after a failed job or when it was switched off. Resuming it is safe.',
          confidence: 0.9,
          auto: true,
          steps: [
            { kind: 'command', title: 'Resume printing', explain: 'Turns the paused queue back on.', cmd: 'cupsenable', args: [existing.queue], admin: true, safe: true },
            { kind: 'command', title: 'Accept new jobs', explain: 'Lets apps send jobs again.', cmd: 'cupsaccept', args: [existing.queue], admin: true, safe: true },
          ],
        }),
      );
      return { status: 'needs-fix', headline: `${name} is set up but paused.`, checks, plans, facts, support: 'app' };
    }
    checks.push(check('queue', 'Printer is set up', 'pass', `Queue "${existing.queue}" sends to ${existing.uri}.`));
    plans.push(
      plan({
        id: 'test-page',
        title: 'Print a test page',
        why: 'Everything looks right. Print one page to be sure.',
        confidence: 1,
        steps: [{ kind: 'command', title: 'Print a test page', explain: 'One short page.', cmd: 'lp', args: ['-d', existing.queue, testPagePath()], admin: false, safe: true }],
      }),
    );
    return { status: 'ok', headline: `Ready to print to ${name} as "${existing.queue}".`, checks, plans, facts, support: 'app' };
  }
  checks.push(check('queue', 'Printer is set up', 'info', 'No print queue points at this printer yet.'));

  const host = ippSvc ? uriHost(device, ippSvc.host) : null;
  if (!ippSvc || !host) {
    checks.push(
      check('ipp', 'Driverless printing (IPP)', 'warn', 'The printer only offers older ways to print (LPD or raw port 9100). Those need the driver from the maker.'),
    );
    plans.push(
      plan({
        id: 'add-network-printer-manual',
        title: 'Add it in your printer settings',
        why: "This printer does not offer driverless printing, so it needs its maker's driver.",
        confidence: 0.3,
        steps: [
          {
            kind: 'manual',
            title: 'Add the printer',
            explain: `Open your system's printer settings, choose Add, pick "${name}" from the network printers and select the driver for ${device.productName ?? 'its model'}.`,
          },
        ],
      }),
    );
    return { status: 'needs-fix', headline: `Found ${name} on your network. It needs a driver before you can print.`, checks, plans, facts, support: 'vendor-driver' };
  }

  const txt = ippSvc.txt ?? {};
  const driverless = isDriverless(txt);
  const scheme = ippSvc.type === '_ipps._tcp' ? 'ipps' : 'ipp';
  const port = Number.isInteger(ippSvc.port) && ippSvc.port > 0 && ippSvc.port < 65536 ? ippSvc.port : 631;
  const uri = `${scheme}://${host}:${port}/${resourcePath(txt.rp)}`;
  let queue = cups.queueNameFor(txt.ty || ippSvc.name || device.productName || 'Network_Printer');
  // Never overwrite an existing queue with the same name.
  const taken = new Set(queues.map((q) => q.queue.toLowerCase()));
  if (taken.has(queue.toLowerCase())) {
    let n = 2;
    while (taken.has(`${queue}_network${n === 2 ? '' : `_${n}`}`.toLowerCase())) n++;
    queue = `${queue}_network${n === 2 ? '' : `_${n}`}`;
  }
  facts.uri = uri;
  facts.queue = queue;
  facts.driverless = driverless;
  checks.push(
    check(
      'ipp',
      'Driverless printing (IPP Everywhere / AirPrint)',
      driverless ? 'pass' : 'warn',
      driverless
        ? 'The printer says it understands standard print jobs, so no driver is needed.'
        : 'The printer did not say it supports driverless printing. Setting it up this way may still work; if not, it needs the driver from the maker.',
    ),
  );
  plans.push(
    plan({
      id: 'add-network-printer',
      title: driverless ? 'Add the printer (no driver needed)' : 'Try adding the printer without a driver',
      why: driverless
        ? 'The printer supports driverless printing, so the print system can set it up on its own.'
        : 'Some printers support driverless printing without saying so. If this fails, the printer needs its maker\'s driver.',
      confidence: driverless ? 0.9 : 0.4,
      auto: driverless,
      steps: [
        {
          kind: 'command',
          title: 'Add the printer',
          explain: `Creates a print queue called "${queue}" that sends jobs over the network to ${uri}, using the printer's own built-in description instead of a driver.`,
          cmd: 'lpadmin',
          args: ['-p', queue, '-E', '-v', uri, '-m', 'everywhere'],
          admin: true,
          safe: true,
        },
        { kind: 'command', title: 'Make it your default printer', explain: 'So the Print button in every app uses it.', cmd: 'lpoptions', args: ['-d', queue], admin: false, safe: true, optional: true },
        {
          kind: 'command',
          title: 'Print a test page',
          explain: 'One short page, so you can see it worked.',
          cmd: 'lp',
          args: ['-d', queue, '-t', 'Plug Doctor test page', testPagePath()],
          admin: false,
          safe: true,
          optional: true,
        },
      ],
    }),
  );
  return {
    status: 'needs-fix',
    headline: driverless ? `Found ${name} on your network. One click to set it up, no driver needed.` : `Found ${name} on your network. It is not set up on this computer yet.`,
    checks,
    plans,
    facts,
    support: driverless ? 'app' : 'unknown',
  };
}

function printerWindows(device) {
  const name = nameOf(device);
  return {
    status: 'unknown',
    headline: `Found ${name} on your network. Add it once in Windows settings and it is ready to print.`,
    checks: [
      check('windows-add', 'Add it in Windows', 'info', 'Windows finds network printers by itself: Settings > Bluetooth & devices > Printers & scanners > Add device. Most current printers need no extra driver.'),
    ],
    plans: [
      plan({
        id: 'windows-printers',
        title: 'Open Printers & scanners',
        why: 'Windows sets up network printers from here. Click "Add device" and pick the printer.',
        confidence: 0.8,
        steps: [
          openSettings('Open Printers & scanners', 'Opens Settings > Bluetooth & devices > Printers & scanners.', 'ms-settings:printers'),
          { kind: 'manual', title: `Click "Add device" and choose "${name}"`, explain: 'Windows downloads anything it needs. Then press "Check again".' },
        ],
      }),
    ],
    facts: {},
    support: 'native',
  };
}

// ---------------------------------------------------------------- scanner

function scannerMatches(device, text) {
  const out = String(text ?? '').toLowerCase();
  if (!out) return false;
  const needles = [
    ...(device.details?.addresses ?? []),
    device.details?.host,
    ...services(device)
      .filter((s) => SCAN_TYPES.includes(s.type))
      .flatMap((s) => [s.name, s.txt?.ty]),
  ]
    .filter((n) => typeof n === 'string' && n.length >= 4)
    .map((n) => n.toLowerCase());
  return out
    .split(/\r?\n/)
    .filter((l) => /airscan:|escl:/.test(l))
    .some((l) => needles.some((n) => l.includes(n)));
}

async function scanner(device, ctx) {
  const name = nameOf(device);
  if (ctx.platform === 'darwin') {
    return {
      status: 'ok',
      headline: `${name} can scan to this Mac. No driver needed.`,
      checks: [check('scan-mac', 'Scanning on this Mac', 'pass', 'macOS scans from driverless (eSCL / AirScan) scanners with Image Capture, or from System Settings > Printers & Scanners.')],
      plans: [
        plan({
          id: 'open-image-capture',
          title: 'Scan with Image Capture',
          why: 'Image Capture is built into macOS. Pick the scanner on the left, then click Scan.',
          confidence: 1,
          steps: [openMac('Open Image Capture', 'Opens the scanning app that comes with your Mac.', ['-a', 'Image Capture'])],
        }),
      ],
      facts: {},
      support: 'native',
    };
  }
  if (ctx.platform === 'win32') {
    return {
      status: 'unknown',
      headline: `Found the scanner in ${name} on your network.`,
      checks: [check('scan-windows', 'Scanning on Windows', 'info', 'Add it in Settings > Bluetooth & devices > Printers & scanners, then scan with the Windows Scan app.')],
      plans: [
        plan({
          id: 'windows-scanners',
          title: 'Open Printers & scanners',
          why: 'Windows sets up network scanners from here. Click "Add device" and pick the scanner.',
          confidence: 0.6,
          steps: [openSettings('Open Printers & scanners', 'Opens Settings > Bluetooth & devices > Printers & scanners.', 'ms-settings:printers')],
        }),
      ],
      facts: {},
    };
  }

  // Linux: driverless scanners go through SANE's airscan (or escl) backend.
  const r = await ctx.run('scanimage', ['-L'], { timeout: 30000 });
  if (scannerMatches(device, `${r.stdout}\n${r.stderr}`)) {
    return {
      status: 'ok',
      headline: `${name} is ready to scan.`,
      checks: [check('sane', 'Scanner software sees it', 'pass', 'Open your scanning app (for example Document Scanner or Simple Scan) and pick it.')],
      plans: [],
      facts: { scanBackend: /airscan:/i.test(r.stdout) ? 'airscan' : 'escl' },
      support: 'app',
    };
  }
  return {
    status: 'needs-fix',
    headline: `${name} can scan over the network once one small package is installed.`,
    checks: [
      check(
        'sane',
        'Scanner software sees it',
        r.missing ? 'info' : 'fail',
        r.missing ? 'The scanning tools could not be checked on this computer.' : 'Your scanning software does not list this scanner yet.',
      ),
    ],
    plans: [
      plan({
        id: 'install-airscan',
        title: 'Install the driverless scanner support',
        why: 'sane-airscan lets Linux scanning apps use network scanners that speak eSCL (AirScan), with no maker driver.',
        confidence: 0.85,
        auto: true,
        steps: [
          installStep({ apt: ['sane-airscan'], dnf: ['sane-airscan'], pacman: ['sane-airscan'] }, ctx.manager),
          { kind: 'manual', title: 'Open your scanning app', explain: 'Open Document Scanner (or Simple Scan) and pick the scanner. Then press "Check again".' },
        ],
      }),
    ],
    facts: {},
    support: 'app',
  };
}

// ---------------------------------------------------------------- TVs, receivers, speakers

function airplay(device, ctx) {
  const name = nameOf(device);
  const screen = cats(device).includes('tv');
  if (ctx.platform === 'darwin') {
    if (screen) {
      return {
        status: 'ok',
        headline: `Your Mac can show its screen on ${name} with AirPlay.`,
        checks: [
          check('airplay', 'AirPlay', 'pass', `Open Control Center (top right of the screen), click Screen Mirroring and choose "${name}". In System Settings > Displays you can use it as a separate display.`),
        ],
        plans: [
          plan({
            id: 'open-displays',
            title: 'Open Displays settings',
            why: 'Choose how your Mac uses the TV: mirror the screen or extend it.',
            confidence: 0.7,
            steps: [openMac('Open Displays settings', 'Opens System Settings > Displays.', ['x-apple.systempreferences:com.apple.preference.displays'])],
          }),
        ],
        facts: {},
        support: 'native',
      };
    }
    return {
      status: 'ok',
      headline: `Your Mac can play sound on ${name} with AirPlay.`,
      checks: [check('airplay', 'AirPlay', 'pass', `Click Sound in Control Center (or the AirPlay button in Music) and choose "${name}".`)],
      plans: [
        plan({
          id: 'open-sound',
          title: 'Open Sound settings',
          why: `Pick "${name}" as the sound output.`,
          confidence: 0.6,
          steps: [openMac('Open Sound settings', 'Opens System Settings > Sound.', ['x-apple.systempreferences:com.apple.preference.sound'])],
        }),
      ],
      facts: {},
      support: 'native',
    };
  }
  const os = ctx.platform === 'win32' ? 'Windows' : 'Linux';
  return {
    status: 'ok',
    headline: `${name} is an AirPlay receiver. ${os} needs an app that supports AirPlay to use it.`,
    checks: [
      check(
        'airplay',
        'AirPlay',
        'info',
        `AirPlay is built into Apple devices. ${os} has no built-in AirPlay, so use an iPhone, iPad or Mac, or an app on this computer that can send to AirPlay receivers.`,
      ),
    ],
    plans: [],
    facts: {},
    support: 'app',
  };
}

function cast(device, ctx) {
  const name = nameOf(device);
  const screen = cats(device).includes('tv');
  const checks = [
    check(
      'cast',
      'Google Cast',
      'pass',
      screen
        ? `In Chrome, open the menu (⋮) and choose Cast… to show a tab, a video or your whole screen on "${name}". Apps such as YouTube and Netflix on your phone have a Cast button too.`
        : `Play music to "${name}" from apps with a Cast button (Spotify, YouTube Music and others). In Chrome, the menu (⋮) has Cast… to send a tab's sound.`,
    ),
  ];
  if (ctx.platform === 'darwin') {
    checks.push(check('cast-mac', 'Mirroring from a Mac', 'info', "A Mac's AirPlay does not reach Chromecast devices; use Chrome's Cast… instead."));
  }
  return {
    status: 'ok',
    headline: screen ? `Ready: cast to ${name} from Chrome or from apps with a Cast button.` : `Ready: play to ${name} from apps with a Cast button.`,
    checks,
    plans: [],
    facts: {},
    support: 'app',
  };
}

function smartTv(device, ctx) {
  const name = nameOf(device);
  const st = (device.details?.ssdp?.st ?? []).join(' ');
  const roku = /roku:ecp/i.test(st) || /roku/i.test(`${device.details?.ssdp?.server ?? ''} ${device.vendorName ?? ''}`);
  const dial = /dial-multiscreen-org/i.test(st);
  const dlna = cats(device).includes('dlna');
  const checks = [];
  const plans = [];
  if (dial || roku) {
    checks.push(check('dial', 'Send videos from your phone', 'pass', 'Phone apps such as YouTube and Netflix can find this TV and play videos on it.'));
  }
  if (roku) {
    checks.push(check('roku', 'Roku', 'info', 'The free Roku mobile app works as a remote and can play your own photos, videos and music on it.'));
  }
  if (dlna) {
    checks.push(
      check(
        'dlna',
        'Play your own media (DLNA)',
        'pass',
        'The TV can play videos, music and photos shared by a DLNA media server on this network (for example Plex, Jellyfin or the media streaming built into Windows).',
      ),
    );
  }
  if (ctx.platform === 'darwin') {
    checks.push(check('mirror-mac', 'Mirror this Mac', 'info', 'This TV does not support AirPlay, so a Mac cannot mirror its screen to it without a third-party app. An HDMI cable always works.'));
  } else if (ctx.platform === 'win32') {
    if (dlna) checks.push(check('cast-to-device', 'Play a file on the TV', 'info', 'In File Explorer, right-click a video or music file and choose "Cast to Device" (under "Show more options" on Windows 11).'));
    checks.push(
      check(
        'miracast',
        'Mirror this PC',
        'info',
        'Many TVs also accept Miracast screen mirroring. Plug Doctor cannot see Miracast on the network, so just try it: press Windows+K and pick the TV.',
      ),
    );
    plans.push(
      plan({
        id: 'windows-cast',
        title: 'Show your screen on the TV',
        why: 'Windows can mirror to TVs that support Miracast.',
        confidence: 0.4,
        steps: [{ kind: 'manual', title: 'Press Windows+K', explain: 'Choose the TV in the list. If it is not listed, the TV may not support Miracast; an HDMI cable always works.' }],
      }),
    );
  } else {
    checks.push(check('mirror-linux', 'Mirror this computer', 'info', 'Linux cannot mirror its screen to this TV without extra software. An HDMI cable always works.'));
  }
  return {
    status: 'ok',
    headline: dlna || dial || roku ? `${name} is on your network. Play media on it from apps.` : `${name} is on your network.`,
    checks,
    plans,
    facts: { roku, dial, dlna },
    support: 'app',
  };
}

function speaker(device) {
  const name = nameOf(device);
  const checks = [];
  if (svc(device, '_spotify-connect._tcp')) {
    checks.push(check('spotify', 'Spotify Connect', 'pass', `In the Spotify app, tap the devices button and choose "${name}".`));
  }
  if (cats(device).includes('dlna')) {
    checks.push(check('dlna', 'Play your own music (DLNA)', 'info', 'Apps that support DLNA / UPnP can play music on it.'));
  }
  return { status: 'ok', headline: `${name} is on your network and ready to play.`, checks, plans: [], facts: {}, support: 'app' };
}

function homekit(device, ctx) {
  const name = nameOf(device);
  const txt = svc(device, '_hap._tcp')?.txt ?? {};
  const unpaired = (parseInt(String(txt.sf ?? '0'), 10) & 1) === 1;
  const plans = [];
  if (ctx.platform === 'darwin') {
    plans.push(
      plan({
        id: 'open-home',
        title: 'Open the Home app',
        why: 'HomeKit accessories are set up and controlled in the Home app.',
        confidence: 0.7,
        steps: [openMac('Open Home', 'Opens the Home app that comes with your Mac.', ['-a', 'Home'])],
      }),
    );
  }
  return {
    status: 'ok',
    headline: unpaired ? `${name} is a HomeKit accessory waiting to be added to the Home app.` : `${name} is a HomeKit accessory.`,
    checks: [
      check(
        'homekit',
        'HomeKit',
        unpaired ? 'info' : 'pass',
        unpaired
          ? 'Not added to a home yet. Add it in the Home app on an iPhone, iPad or Mac (you need the setup code on the device or its box).'
          : 'Already added to a home. Control it in the Home app on an iPhone, iPad or Mac.',
      ),
    ],
    plans,
    facts: { homekitPaired: !unpaired },
    support: ctx.platform === 'darwin' ? 'native' : 'app',
  };
}

// ---------------------------------------------------------------- diagnose

async function diagnoseNetworkDevice(device, ctx) {
  const addresses = device.details?.addresses ?? [];
  const parts = [];
  const c = cats(device);

  if (hasType(device, PRINT_TYPES) || c.includes('printer')) {
    parts.push({ kind: 'printer', ...(ctx.platform === 'win32' ? printerWindows(device) : await printerCups(device, ctx)) });
  }
  if (hasType(device, SCAN_TYPES)) parts.push({ kind: 'scanner', ...(await scanner(device, ctx)) });
  if (hasType(device, ['_airplay._tcp', '_raop._tcp'])) parts.push({ kind: 'airplay', ...airplay(device, ctx) });
  if (svc(device, '_googlecast._tcp')) parts.push({ kind: 'cast', ...cast(device, ctx) });
  // TVs found by SSDP (DLNA, DIAL, Roku). An AirPlay TV on a Mac is fully covered by AirPlay.
  const tvLike = c.includes('tv') || (c.includes('dlna') && !c.includes('speaker'));
  const airplayTv = svc(device, '_airplay._tcp') && (ctx.platform === 'darwin' || !device.details?.ssdp);
  if (tvLike && !svc(device, '_googlecast._tcp') && !airplayTv) parts.push({ kind: 'tv', ...smartTv(device, ctx) });
  if (c.includes('speaker') && !hasType(device, ['_airplay._tcp', '_raop._tcp', '_googlecast._tcp'])) parts.push({ kind: 'speaker', ...speaker(device) });
  if (svc(device, '_hap._tcp')) parts.push({ kind: 'smart-home', ...homekit(device, ctx) });

  const checks = [check('reachable', 'Found on your network', 'pass', addresses.length ? `Answered at ${addresses.join(', ')}.` : 'It answered just now.')];
  const facts = {
    kinds: parts.map((p) => p.kind),
    host: device.details?.host ?? null,
    addresses,
    services: services(device).map((s) => `${s.type}${s.port ? `:${s.port}` : ''}`),
    manufacturer: device.details?.manufacturer ?? null,
    model: device.details?.model ?? null,
  };

  if (parts.length === 0) {
    return {
      status: 'unknown',
      headline: `${nameOf(device)} is on your network. Plug Doctor has no specific checks for it yet.`,
      checks,
      plans: [],
      facts,
    };
  }

  let main = parts[0];
  for (const p of parts) if (SEVERITY[p.status] > SEVERITY[main.status]) main = p;
  for (const p of parts) {
    checks.push(...p.checks);
    Object.assign(facts, p.facts);
  }
  return {
    status: main.status,
    headline: main.headline,
    checks,
    plans: parts.flatMap((p) => p.plans),
    facts,
    support: { level: (main.support ?? parts.find((p) => p.support)?.support) || 'unknown' },
  };
}

/** @type {import('./index').Family} */
const family = {
  id: 'network-device',
  label: 'Network device',
  icon: 'network',
  sources: ['network'],
  match: (d) => (d.source === 'network' ? 80 : 0),
  diagnose: diagnoseNetworkDevice,
};

module.exports = { family, diagnoseNetworkDevice, findQueue, isDriverless, scannerMatches };
