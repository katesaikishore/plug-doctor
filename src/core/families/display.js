'use strict';

const fs = require('node:fs');
const { check, plan } = require('./helpers');

/**
 * Screens and TVs. The usual trouble is not a missing driver but a picture
 * that is worse than it should be: 4K stuck at 30 Hz because of a cable or
 * adapter, a blurry non-native resolution, a TV that cuts off the edges,
 * or a Mac that can only drive one external screen.
 */

const DISPLAYLINK_VENDOR = '17e9';

const DISPLAYLINK_URLS = {
  darwin: 'https://www.synaptics.com/products/displaylink-graphics/downloads/macos',
  win32: 'https://www.synaptics.com/products/displaylink-graphics/downloads/windows',
  linux: 'https://www.synaptics.com/products/displaylink-graphics/downloads/ubuntu',
};

/**
 * Macs whose chip drives one external screen by itself (base M1 and M2
 * MacBook Air and 13-inch MacBook Pro). Only models we are sure of.
 */
const ONE_EXTERNAL_MACS = {
  'MacBookAir10,1': 'MacBook Air (M1)',
  'MacBookPro17,1': '13-inch MacBook Pro (M1)',
  'Mac14,2': 'MacBook Air (M2)',
  'Mac14,15': '15-inch MacBook Air (M2)',
  'Mac14,7': '13-inch MacBook Pro (M2)',
};

const MAC_DISPLAYS_PANE = 'x-apple.systempreferences:com.apple.Displays-Settings.extension';

const modeText = (m) => (m ? `${m.width} × ${m.height}${m.refresh ? ` at ${Math.round(m.refresh)} Hz` : ''}` : 'unknown');
const sizeText = (m) => `${m.width} × ${m.height}`;

/** A step that opens the display settings, or tells the person how on Linux. */
function settingsStep(platform, explain) {
  if (platform === 'darwin') {
    return { kind: 'command', title: 'Open Displays settings', explain, cmd: 'open', args: [MAC_DISPLAYS_PANE], admin: false, safe: true };
  }
  if (platform === 'win32') {
    return { kind: 'command', title: 'Open Display settings', explain, cmd: 'explorer.exe', args: ['ms-settings:display'], admin: false, safe: true };
  }
  return { kind: 'manual', title: 'Open Settings > Displays', explain: `Open your desktop's Settings app and choose Displays (or Screen / Monitors). ${explain}` };
}

/** Where the refresh rate lives on each OS. */
function refreshHint(platform) {
  if (platform === 'darwin') return 'Choose the screen, then open the Refresh rate menu.';
  if (platform === 'win32') return 'Choose the screen, open Advanced display, then Choose a refresh rate.';
  return 'Choose the screen and look at Refresh Rate.';
}

function resolutionHint(platform) {
  if (platform === 'darwin') return 'Choose the screen and pick "Default for display" (or one of the text-size choices next to it). Avoid low resolutions from "Show all resolutions".';
  if (platform === 'win32') return 'Choose the screen and, under Display resolution, pick the one marked "(Recommended)".';
  return 'Choose the screen and pick the largest resolution, normally the first one in the list.';
}

// ---------------------------------------------------------------- screens

function refreshCheck(device, ctx, checks, plans, problems) {
  const d = device.details;
  const cur = d.current;
  if (!cur?.refresh) return;
  const highRes = cur.width >= 3840 || cur.height >= 2160;
  if (!highRes || cur.refresh > 31) {
    checks.push(check('refresh', 'Smooth refresh rate', 'pass', `${Math.round(cur.refresh)} Hz.`));
    return;
  }
  const platform = ctx.platform;
  let detail =
    `The screen runs at ${modeText(cur)}, so the mouse and scrolling look choppy. ` +
    '4K at 60 Hz needs every link to keep up: the computer\'s port, any adapter or dock, the cable and the screen\'s input. ' +
    'Older HDMI 1.4 adapters and cables top out at 30 Hz for 4K; many cheap USB-C to HDMI adapters are like that.';
  const e = d.edid;
  if (d.connection === 'HDMI' && e?.hdmi && !e.hdmiForum && e.maxTmdsMhz && e.maxTmdsMhz <= 340) {
    detail += ' This screen itself does not report HDMI 2.0 speed, so over HDMI 30 Hz may be its limit; a DisplayPort or USB-C input, if it has one, avoids that.';
  }
  checks.push(check('refresh', 'Smooth refresh rate', 'warn', detail));
  problems.push(`${d.isTV ? 'Your TV' : 'The screen'} is running at ${Math.round(cur.refresh)} Hz, so motion looks choppy.`);

  // Linux with xrandr: when a faster rate is already on offer, it is just a setting.
  const faster = (d.availableRates ?? []).filter((r) => r >= 50 && r <= 61).sort((a, b) => Math.abs(60 - a) - Math.abs(60 - b))[0];
  if (platform === 'linux' && d.output && faster) {
    plans.push(
      plan({
        id: 'set-60hz',
        title: `Switch to ${Math.round(faster)} Hz`,
        why: `The screen and cable already offer ${Math.round(faster)} Hz at this resolution; it is just not selected.`,
        confidence: 0.8,
        steps: [
          {
            kind: 'command',
            title: `Set ${d.output} to ${Math.round(faster)} Hz`,
            explain: 'Changes the refresh rate for this session. To keep it after you log out, also choose it in Settings > Displays.',
            cmd: 'xrandr',
            args: ['--output', d.output, '--mode', sizeText(cur).replace(' × ', 'x'), '--rate', faster.toFixed(2)],
            admin: false,
            safe: true,
          },
        ],
      }),
    );
    return;
  }

  const steps = [settingsStep(platform, `${refreshHint(platform)} If 60 Hz is listed, choose it and you are done.`)];
  steps.push({
    kind: 'manual',
    title: 'Use a cable and adapter made for 4K at 60 Hz',
    explain:
      'For HDMI, use a cable labelled "Premium High Speed" or "Ultra High Speed" (HDMI 2.0 or newer) and, if you need an adapter, one that says "4K 60Hz" or HDMI 2.0. ' +
      'A USB-C to DisplayPort cable or a DisplayPort cable is another good option if the screen has that input.',
  });
  if (d.isTV) {
    steps.push({
      kind: 'manual',
      title: 'Turn on the TV\'s full-speed HDMI setting',
      explain:
        'Many TVs ship with their HDMI inputs limited to the old speed. Look in the TV\'s settings for "Input Signal Plus" or "HDMI UHD Color" (Samsung), ' +
        '"HDMI Ultra HD Deep Colour" (LG) or "HDMI signal format: Enhanced" (Sony), and turn it on for the input you use. Some TVs only allow it on certain HDMI inputs.',
    });
  }
  steps.push({ kind: 'manual', title: 'Choose 60 Hz', explain: `${refreshHint(platform)} Pick 60 Hz, then press "Check again".` });
  plans.push(
    plan({
      id: 'fix-refresh',
      title: 'Get 60 Hz on your 4K screen',
      why: 'At 30 Hz everything you move on screen stutters. This is almost always the cable, adapter or port, not the computer.',
      confidence: 0.6,
      steps,
    }),
  );
}

function resolutionCheck(device, ctx, checks, plans, problems) {
  const d = device.details;
  const cur = d.current;
  const native = d.native;
  if (!cur || !native) return;
  if (cur.width >= native.width && cur.height >= native.height) {
    checks.push(check('resolution', 'Sharpest resolution', 'pass', `Uses the screen's full ${sizeText(native)} pixels.`));
    return;
  }
  checks.push(
    check(
      'resolution',
      'Sharpest resolution',
      'warn',
      `The computer sends ${sizeText(cur)} but the screen has ${sizeText(native)} pixels, so it stretches the picture and text looks soft or blurry. ` +
        'If you want bigger text, use the text-size or scaling setting instead of a lower resolution.',
    ),
  );
  problems.push('The screen is running below its sharpest resolution, so text looks blurry.');
  const platform = ctx.platform;
  const steps = [];
  const nativeMode = `${native.width}x${native.height}`;
  const xrandrHasMode = (device.raw?.xrandr?.modes ?? []).some((m) => m.width === native.width && m.height === native.height);
  if (platform === 'linux' && d.output && xrandrHasMode) {
    steps.push({
      kind: 'command',
      title: `Set ${d.output} to ${sizeText(native)}`,
      explain: 'Switches to the screen\'s own resolution for this session. To keep it after you log out, also choose it in Settings > Displays.',
      cmd: 'xrandr',
      args: ['--output', d.output, '--mode', nativeMode],
      admin: false,
      safe: true,
    });
  } else {
    steps.push(settingsStep(platform, resolutionHint(platform)));
    steps.push({ kind: 'manual', title: `Choose ${sizeText(native)}`, explain: `${resolutionHint(platform)} Then press "Check again".` });
  }
  plans.push(
    plan({
      id: 'native-resolution',
      title: 'Use the screen\'s own resolution',
      why: 'Every screen is sharpest at the resolution it was built with.',
      confidence: 0.7,
      steps,
    }),
  );
}

function macLimitCheck(device, ctx, checks, plans, problems) {
  const d = device.details;
  if (ctx.platform !== 'darwin' || d.builtIn) return;
  const count = d.externalCount ?? 1;
  const model = ONE_EXTERNAL_MACS[d.hwModel];
  const baseChip = /^Apple M[12]$/i.test(d.chip ?? '');
  // Sure: a known model. Hedged: base chip but the model could not be read.
  if (!model && !(baseChip && !d.hwModel)) return;
  if (d.chip && !baseChip) return;
  const who = model ? `This ${model} can` : `If this Mac is a MacBook Air or 13-inch MacBook Pro with the ${d.chip} chip, it can`;
  const limit = `${who} drive one external screen by itself. Docks and multi-port hubs cannot change that; a second external screen needs a DisplayLink adapter or dock and its app.`;
  if (count > 1) {
    checks.push(check('mac-screens', 'Number of external screens', model ? 'warn' : 'info', `${limit} You have ${count} external screens connected, so the extra ones may show the same picture or stay dark unless they run through DisplayLink.`));
    if (model) problems.push(`This Mac drives only one external screen by itself, and ${count} are connected.`);
  } else {
    checks.push(check('mac-screens', 'Number of external screens', 'info', limit));
  }
  plans.push(
    plan({
      id: 'displaylink-mac',
      title: 'Add another screen with DisplayLink',
      why: 'DisplayLink adapters and docks send the picture over USB with an app, which gets around the Mac\'s one-screen limit.',
      confidence: count > 1 ? 0.6 : 0.3,
      steps: [
        {
          kind: 'manual',
          title: 'Get a DisplayLink adapter or dock',
          explain: 'Look for "DisplayLink" on the box. Ordinary USB-C hubs and multi-port adapters will not add a screen to this Mac.',
        },
        { kind: 'open-url', title: 'Install DisplayLink Manager', explain: 'Download Synaptics\' free DisplayLink Manager app for macOS and install it.', url: DISPLAYLINK_URLS.darwin },
        {
          kind: 'manual',
          title: 'Allow Screen Recording when asked',
          explain: 'DisplayLink Manager needs the Screen Recording permission (System Settings > Privacy & Security) to send the picture. Then plug the second screen into the DisplayLink adapter.',
        },
      ],
    }),
  );
}

function tvChecks(device, ctx, checks, plans) {
  const d = device.details;
  if (!d.isTV || d.builtIn) return;
  const platform = ctx.platform;
  if (d.tvReason) checks.push(check('tv', 'Looks like a TV', 'info', d.tvReason));

  const fitNames = '"Screen Fit" or "Fit to Screen" (Samsung), "Just Scan" or "Original" (LG), "Full Pixel" (Sony), or "1:1 Pixel", "Dot by Dot" or "Full" on other brands';
  checks.push(
    check(
      'tv-overscan',
      'Edges of the picture',
      'info',
      `TVs often zoom in slightly (overscan), which cuts off the menu bar, the taskbar or the mouse at the edges. Set the TV's picture size to ${fitNames}.` +
        (platform === 'darwin' ? ' Some TVs also get an Underscan slider in the Mac\'s Displays settings; the TV setting gives a sharper picture.' : ''),
    ),
  );
  const fitSteps = [
    {
      kind: 'manual',
      title: 'Set the TV to show every pixel',
      explain: `On the TV remote, open Settings > Picture > Picture Size (or Aspect Ratio) and choose ${fitNames}.`,
    },
  ];
  if (platform === 'darwin') fitSteps.push({ ...settingsStep(platform, 'If the TV has no such setting, look for an Underscan slider for this TV here.'), optional: true });
  if (platform === 'win32') {
    fitSteps.push({ ...settingsStep(platform, 'If edges are still cut off, your graphics driver\'s control panel may have an overscan or "scaling" setting for this screen.'), optional: true });
  }
  plans.push(plan({ id: 'tv-fit', title: 'Show the whole picture on the TV', why: 'Stops the TV from cutting off the edges of your desktop.', confidence: 0.4, steps: fitSteps }));

  checks.push(
    check(
      'tv-pc-mode',
      'TV picture mode',
      'info',
      'For sharp text and less delay between the mouse and the screen, switch the TV to PC mode or Game mode. On Samsung and LG TVs you get PC mode by renaming the HDMI input (or setting its icon) to "PC".',
    ),
  );
  plans.push(
    plan({
      id: 'tv-pc-mode',
      title: 'Make text sharp and the mouse responsive',
      why: 'TVs process the picture for films by default, which blurs small text and adds delay.',
      confidence: 0.4,
      steps: [
        {
          kind: 'manual',
          title: 'Switch the TV to PC or Game mode',
          explain: 'In the TV\'s input list, rename this HDMI input or set its icon to "PC" (Samsung, LG), or choose the "Game" or "Graphics" picture mode. Turn off extra sharpness and motion smoothing.',
        },
      ],
    }),
  );

  if (d.edid?.hdr !== null || platform !== 'linux') {
    const where = platform === 'darwin' ? '"High Dynamic Range" in Displays settings' : platform === 'win32' ? '"Use HDR" in Display settings' : 'your desktop\'s display settings';
    checks.push(
      check(
        'tv-hdr',
        'HDR',
        'info',
        `If the TV supports HDR, you can turn it on with ${where}, when the computer offers it. HDR is best for films and games; if the desktop looks dull or washed out, turn it off again.`,
      ),
    );
  }

  checks.push(
    check(
      'tv-cec',
      'TV remote control (HDMI-CEC)',
      'info',
      platform === 'darwin'
        ? 'Macs do not support HDMI-CEC, so the TV remote cannot control the Mac and the TV will not turn on or switch input by itself. Use the TV remote to pick the input.'
        : 'Most computers do not support HDMI-CEC, so the TV remote cannot control the computer and the TV will not turn on or switch input by itself. Use the TV remote to pick the input.',
    ),
  );
}

async function diagnoseScreen(device, ctx) {
  const d = device.details ?? {};
  const dev = { ...device, details: d };
  const checks = [];
  const plans = [];
  const problems = [];
  const facts = {
    connection: d.connection ?? null,
    currentMode: d.current ? modeText(d.current) : null,
    nativeResolution: d.native ? sizeText(d.native) : null,
    builtIn: Boolean(d.builtIn),
    isTV: Boolean(d.isTV),
    externalScreens: d.externalCount ?? null,
    ...(d.chip ? { chip: d.chip } : {}),
    ...(d.hwModel ? { hwModel: d.hwModel } : {}),
    ...(d.edid ? { edid: d.edid } : {}),
  };

  if (d.enabled === false) {
    checks.push(check('enabled', 'Screen is switched on', 'warn', 'The screen is plugged in and detected, but the computer is not sending a picture to it.'));
    problems.push('The screen is connected but switched off in your display settings.');
    const steps =
      ctx.platform === 'linux' && d.output
        ? [{ kind: 'command', title: `Turn on ${d.output}`, explain: 'Turns the screen on at its preferred resolution for this session. To keep it, also turn it on in Settings > Displays.', cmd: 'xrandr', args: ['--output', d.output, '--auto'], admin: false, safe: true }]
        : [settingsStep(ctx.platform, 'Choose the screen and turn it on.')];
    plans.push(plan({ id: 'enable-screen', title: 'Turn the screen on', why: 'The computer sees the screen but is not using it.', confidence: 0.8, steps }));
  } else {
    const via = d.connection && !d.builtIn ? ` over ${d.connection}` : '';
    checks.push(check('connected', 'Screen detected', 'pass', `Connected${via}${d.current ? `, showing ${modeText(d.current)}` : ''}.`));
  }

  if (!d.builtIn) refreshCheck(dev, ctx, checks, plans, problems);
  resolutionCheck(dev, ctx, checks, plans, problems);
  macLimitCheck(dev, ctx, checks, plans, problems);
  tvChecks(dev, ctx, checks, plans);

  const needsFix = checks.some((c) => c.status === 'warn' || c.status === 'fail');
  const headline = problems[0] ?? (d.builtIn ? 'Your built-in screen is working.' : d.isTV ? 'Your TV is working as a computer screen.' : 'Your screen is working.');
  return { status: needsFix ? 'needs-fix' : 'ok', headline, checks, plans, facts, support: { level: 'native' } };
}

// ---------------------------------------------------------------- USB

const isDisplayLink = (d) => d.vendorId === DISPLAYLINK_VENDOR;
/** USB Billboard class: a USB-C adapter reporting its video (alternate) mode. */
const isBillboard = (d) => d.deviceClass === '11' || (d.interfaces ?? []).some((i) => i.class === '11');

async function diagnoseDisplayLink(device, ctx) {
  const platform = ctx.platform;
  const exists = ctx.pathExists ?? fs.existsSync;
  const checks = [];
  const plans = [];
  const facts = { displayLink: true };
  const support = {
    level: 'vendor-driver',
    note:
      platform === 'darwin'
        ? 'DisplayLink screens need Synaptics\' free DisplayLink Manager app. No kernel extension and no security changes are needed.'
        : 'DisplayLink screens need the DisplayLink driver from Synaptics.',
  };
  const installPlan = (steps) =>
    plan({
      id: 'install-displaylink',
      title: platform === 'darwin' ? 'Install DisplayLink Manager' : 'Install the DisplayLink driver',
      why: 'DisplayLink adapters and docks send the picture over USB, and only Synaptics\' DisplayLink software knows how to drive them.',
      confidence: 0.8,
      steps,
    });

  if (platform === 'darwin') {
    let installed = false;
    try {
      installed = Boolean(exists('/Applications/DisplayLink Manager.app'));
    } catch {
      installed = false;
    }
    if (installed) {
      checks.push(check('displaylink-app', 'DisplayLink Manager installed', 'pass'));
      checks.push(
        check('displaylink-permission', 'Screen Recording allowed', 'info', 'If the screens on this adapter stay black, open System Settings > Privacy & Security > Screen Recording and make sure DisplayLink Manager is switched on.'),
      );
      return { status: 'ok', headline: 'DisplayLink Manager is installed for this adapter.', checks, plans, facts, support };
    }
    checks.push(check('displaylink-app', 'DisplayLink Manager installed', 'fail', 'This is a DisplayLink adapter or dock. Its screens stay black until DisplayLink Manager is installed.'));
    plans.push(
      installPlan([
        { kind: 'open-url', title: 'Download DisplayLink Manager', explain: 'Opens Synaptics\' download page. Download the latest DisplayLink Manager for macOS and install it.', url: DISPLAYLINK_URLS.darwin },
        { kind: 'manual', title: 'Allow Screen Recording', explain: 'Open DisplayLink Manager. When macOS asks, allow Screen Recording for it in System Settings > Privacy & Security; that is how it sends the picture.' },
        { kind: 'manual', title: 'Unplug the adapter and plug it back in', explain: 'Then press "Check again".' },
      ]),
    );
    return { status: 'needs-fix', headline: 'This DisplayLink adapter needs the DisplayLink Manager app.', checks, plans, facts, support };
  }

  if (platform === 'win32') {
    if (!device.problem) {
      checks.push(check('displaylink-driver', 'DisplayLink driver installed', 'pass', device.driver?.names?.join(', ') || ''));
      return { status: 'ok', headline: 'Windows has the DisplayLink driver for this adapter.', checks, plans, facts, support };
    }
    checks.push(check('displaylink-driver', 'DisplayLink driver installed', 'fail', device.problem.message));
    plans.push(
      installPlan([
        { kind: 'command', title: 'Ask Windows Update for the driver', explain: 'Windows Update usually has the DisplayLink driver. This makes Windows look again.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true, optional: true },
        { kind: 'open-url', title: 'Or download it from Synaptics', explain: 'If the screens still stay black, install the latest DisplayLink driver for Windows.', url: DISPLAYLINK_URLS.win32 },
        { kind: 'manual', title: 'Unplug the adapter and plug it back in', explain: 'Then press "Check again".' },
      ]),
    );
    return { status: 'broken', headline: 'Windows has no working driver for this DisplayLink adapter.', checks, plans, facts, support };
  }

  // Linux: Synaptics' driver uses the evdi kernel module.
  let evdi = false;
  try {
    evdi = Boolean(exists('/sys/module/evdi'));
  } catch {
    evdi = false;
  }
  facts.evdiLoaded = evdi;
  if (evdi) {
    checks.push(check('displaylink-driver', 'DisplayLink driver loaded', 'pass', 'The evdi module used by DisplayLink is loaded.'));
    return { status: 'ok', headline: 'The DisplayLink driver is loaded.', checks, plans, facts, support };
  }
  checks.push(check('displaylink-driver', 'DisplayLink driver loaded', 'warn', 'This is a DisplayLink adapter or dock. Linux needs the DisplayLink driver from Synaptics (it uses the "evdi" module) before screens on it work.'));
  plans.push(
    installPlan([
      {
        kind: 'open-url',
        title: 'Download the DisplayLink driver',
        explain: 'Synaptics publishes the driver for Ubuntu. Other distributions have community packages; search for "displaylink" with your distribution\'s name.',
        url: DISPLAYLINK_URLS.linux,
      },
      { kind: 'manual', title: 'Install it and restart', explain: 'Follow the instructions on the page, restart the computer, then press "Check again".' },
    ]),
  );
  return { status: 'needs-fix', headline: 'This DisplayLink adapter needs the DisplayLink driver.', checks, plans, facts, support };
}

async function diagnoseBillboard() {
  return {
    status: 'unknown',
    headline: 'This is the part of a USB-C video adapter or dock that reports its video mode.',
    checks: [
      check(
        'usbc-video',
        'USB-C video',
        'info',
        'Not every USB-C port carries video. If the screen on this adapter stays black, the port may not support DisplayPort over USB-C, or the adapter could not switch to video mode.',
      ),
    ],
    plans: [
      plan({
        id: 'usbc-port',
        title: 'Try a USB-C port that carries video',
        why: 'On many laptops only some USB-C ports can send a picture.',
        confidence: 0.4,
        steps: [
          {
            kind: 'manual',
            title: 'Use a port marked for video',
            explain: 'Plug the adapter into a USB-C port with a Thunderbolt (lightning) or DisplayPort (D-shaped) symbol, or the one your computer\'s manual lists for displays. Then press "Check again".',
          },
        ],
      }),
    ],
    facts: { usbCBillboard: true },
    support: { level: 'native' },
  };
}

async function diagnoseDisplay(device, ctx) {
  if ((device.source ?? 'usb') === 'display') return diagnoseScreen(device, ctx);
  if (isDisplayLink(device)) return diagnoseDisplayLink(device, ctx);
  return diagnoseBillboard(device, ctx);
}

/** @type {import('./index').Family} */
const family = {
  id: 'display',
  label: 'Screen',
  icon: 'display',
  sources: ['display', 'usb'],
  match: (d) => {
    if (d.source === 'display') return 90;
    if (isDisplayLink(d)) return 85;
    if (isBillboard(d)) return 55;
    return 0;
  },
  // DisplayLink Manager (macOS) and DisplayLinkManager + evdi (Linux) talk
  // to the adapter from user space; only Windows binds a driver to it.
  userspace: (platform, d) => isDisplayLink(d ?? {}) && platform !== 'win32',
  diagnose: diagnoseDisplay,
};

module.exports = { family, diagnoseDisplay, ONE_EXTERNAL_MACS, DISPLAYLINK_URLS, DISPLAYLINK_VENDOR };
