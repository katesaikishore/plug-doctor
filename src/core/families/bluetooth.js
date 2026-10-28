'use strict';

const { installStep } = require('../fix/packages');
const { check, plan } = require('./helpers');

/**
 * Bluetooth: this computer's Bluetooth controller and the devices paired
 * with it. The classic failures: Bluetooth is switched off (or blocked by
 * airplane mode), the Bluetooth service is not running, a paired device
 * stopped connecting, a battery is nearly flat, and headphones that are
 * connected but the sound still comes out of the speakers.
 */

const LOW_BATTERY = 15;
const AUDIO_KINDS = new Set(['headphones', 'headset', 'speaker']);
const KIND_NAME = {
  headphones: 'headphones',
  headset: 'headset',
  speaker: 'speaker',
  keyboard: 'keyboard',
  mouse: 'mouse',
  trackpad: 'trackpad',
  controller: 'game controller',
  pen: 'pen',
  watch: 'watch',
  phone: 'phone',
  computer: 'computer',
};

const MAC_BLUETOOTH_PANE = 'x-apple.systempreferences:com.apple.BluetoothSettings';
const MAC_SOUND_PANE = 'x-apple.systempreferences:com.apple.preference.sound';

/** A command step that opens the Bluetooth settings, or null on Linux (no standard way). */
function openBluetoothSettings(platform) {
  if (platform === 'darwin') {
    return { kind: 'command', title: 'Open Bluetooth settings', explain: 'Opens the Bluetooth page of System Settings.', cmd: 'open', args: [MAC_BLUETOOTH_PANE], admin: false, safe: true };
  }
  if (platform === 'win32') {
    // explorer.exe often exits with code 1 even when it opened the page.
    return { kind: 'command', title: 'Open Bluetooth settings', explain: 'Opens the Bluetooth page of Windows Settings.', cmd: 'explorer.exe', args: ['ms-settings:bluetooth'], admin: false, safe: true, optional: true };
  }
  return null;
}

const SETTINGS_NAME = { darwin: 'System Settings > Bluetooth', win32: 'Settings > Bluetooth & devices', linux: 'your desktop\'s Bluetooth settings' };

// ---------------------------------------------------------------- turning Bluetooth on

/**
 * Steps that switch this computer's Bluetooth on, from the controller state
 * the source reported ({ powered, softBlocked, hardBlocked, serviceActive }).
 */
function turnOnSteps(ctl, platform) {
  if (platform === 'darwin') {
    return [
      openBluetoothSettings('darwin'),
      { kind: 'manual', title: 'Switch Bluetooth on', explain: 'Turn on the Bluetooth switch at the top of the page, then press "Check again".' },
    ];
  }
  if (platform === 'win32') {
    return [
      openBluetoothSettings('win32'),
      { kind: 'manual', title: 'Switch Bluetooth on', explain: 'Turn the Bluetooth switch to On. If Airplane mode is on, turn it off first. Then press "Check again".' },
    ];
  }
  const steps = [];
  if (ctl.hardBlocked) {
    steps.push({
      kind: 'manual',
      title: 'Turn on wireless with the switch or key',
      explain: 'Bluetooth is switched off in hardware: a wireless switch on the side of the laptop, a key with an antenna or airplane icon (often together with Fn), or airplane mode. Turn it on.',
    });
  }
  if (ctl.serviceActive === false) {
    steps.push({ kind: 'command', title: 'Start the Bluetooth service', explain: 'Starts the background service that runs Bluetooth on Linux.', cmd: 'systemctl', args: ['start', 'bluetooth'], admin: true, safe: true });
    steps.push({ kind: 'command', title: 'Start it automatically from now on', explain: 'So Bluetooth works right after you turn the computer on.', cmd: 'systemctl', args: ['enable', 'bluetooth'], admin: true, safe: true, optional: true });
  }
  if (ctl.softBlocked || ctl.hardBlocked) {
    steps.push({ kind: 'command', title: 'Unblock Bluetooth', explain: 'Lifts the software block on the Bluetooth radio (the same thing airplane mode sets).', cmd: 'rfkill', args: ['unblock', 'bluetooth'], admin: true, safe: true });
  }
  steps.push({
    kind: 'command',
    title: 'Switch Bluetooth on',
    explain: 'Powers on the Bluetooth radio.',
    cmd: 'bluetoothctl',
    args: ['power', 'on'],
    admin: false,
    safe: true,
    // Right after the service starts the radio may already come on by itself.
    optional: ctl.serviceActive === false,
  });
  return steps;
}

function turnOnPlan(ctl, platform) {
  return plan({
    id: 'turn-on',
    title: 'Turn Bluetooth on',
    why: ctl.hardBlocked
      ? 'Bluetooth is switched off by a wireless switch, a key or airplane mode. Only you can flip that; Plug Doctor does the rest.'
      : 'Bluetooth is switched off on this computer, so no Bluetooth device can connect.',
    confidence: 0.9,
    // Someone may have switched it off on purpose, so never without a click.
    auto: false,
    steps: turnOnSteps(ctl, platform),
  });
}

/** Linux checks for the parts of Bluetooth below the radio switch. Returns plans' worth of problems in `issues`. */
function linuxStackChecks(d, checks) {
  const issues = { off: false };
  if (d.toolsMissing?.includes('bluetoothctl')) {
    checks.push(check('bluez', 'Bluetooth software (BlueZ) installed', 'fail', 'The bluetoothctl tool is missing, so the Bluetooth software is probably not installed.'));
    issues.bluez = true;
  } else {
    checks.push(check('bluez', 'Bluetooth software (BlueZ) installed', 'pass'));
  }
  if (d.serviceActive === false) {
    checks.push(check('service', 'Bluetooth service running', 'fail', 'The Bluetooth service (bluetooth.service) is not running.'));
    issues.off = true;
  } else if (d.serviceActive === true) {
    checks.push(check('service', 'Bluetooth service running', 'pass'));
  }
  if (d.hardBlocked) {
    checks.push(check('rfkill', 'Not blocked by airplane mode or a switch', 'fail', 'Bluetooth is blocked in hardware: a wireless switch, a key or airplane mode.'));
    issues.off = true;
  } else if (d.softBlocked) {
    checks.push(check('rfkill', 'Not blocked by airplane mode or a switch', 'fail', 'Bluetooth is blocked in software (airplane mode or a settings switch).'));
    issues.off = true;
  } else if (d.softBlocked === false) {
    checks.push(check('rfkill', 'Not blocked by airplane mode or a switch', 'pass'));
  }
  return issues;
}

function bluezPlan(ctx) {
  return plan({
    id: 'install-bluez',
    title: 'Install the Bluetooth software',
    why: 'Linux needs BlueZ to use Bluetooth. Plug Doctor will install it and start it.',
    confidence: 0.8,
    steps: [
      installStep({ apt: ['bluez'], dnf: ['bluez'], pacman: ['bluez', 'bluez-utils'], zypper: ['bluez'] }, ctx.manager),
      { kind: 'command', title: 'Start the Bluetooth service', explain: 'Starts the background service that runs Bluetooth.', cmd: 'systemctl', args: ['start', 'bluetooth'], admin: true, safe: true },
      { kind: 'command', title: 'Start it automatically from now on', explain: 'So Bluetooth works right after you turn the computer on.', cmd: 'systemctl', args: ['enable', 'bluetooth'], admin: true, safe: true, optional: true },
    ],
  });
}

// ---------------------------------------------------------------- the controller

function noControllerResult(device, ctx, checks, plans, facts) {
  const { platform } = ctx;
  const d = device.details;
  checks.push(
    check(
      'controller',
      'This computer has Bluetooth',
      'fail',
      platform === 'darwin'
        ? 'macOS did not report a Bluetooth controller. Every recent Mac has one, so this usually clears up after a restart.'
        : 'No Bluetooth adapter was found. Many desktop computers have none; on laptops it can be turned off in the firmware (BIOS/UEFI) settings or its driver did not load.',
    ),
  );
  if (platform === 'linux' && d.toolsMissing?.includes('bluetoothctl')) plans.push(bluezPlan(ctx));
  if (platform === 'linux' && d.serviceActive === false) {
    plans.push(plan({ id: 'turn-on', title: 'Start the Bluetooth service', why: 'The Bluetooth service is not running, so Plug Doctor cannot see the adapter yet.', confidence: 0.6, steps: turnOnSteps(d, 'linux') }));
  }
  if (platform === 'win32') {
    plans.push(
      plan({
        id: 'windows-rescan',
        title: 'Ask Windows to look for the Bluetooth adapter',
        why: 'If this computer has Bluetooth, re-detecting hardware can bring a missing adapter back.',
        confidence: 0.4,
        auto: true,
        steps: [{ kind: 'command', title: 'Re-scan devices', explain: 'Asks Windows to re-detect hardware and load its drivers.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true }],
      }),
    );
  }
  if (platform === 'darwin') {
    plans.push(
      plan({
        id: 'restart',
        title: 'Restart the Mac',
        why: 'A restart resets the Bluetooth controller.',
        confidence: 0.5,
        steps: [{ kind: 'manual', title: 'Restart your Mac', explain: 'Apple menu > Restart. Then open Plug Doctor again.' }],
      }),
    );
  } else {
    plans.push(
      plan({
        id: 'usb-adapter',
        title: 'Add a USB Bluetooth adapter',
        why: 'A small USB Bluetooth adapter gives any computer Bluetooth. Most work without installing anything.',
        confidence: 0.3,
        steps: [{ kind: 'manual', title: 'Plug in a USB Bluetooth adapter', explain: 'Plug it into a free USB port. Plug Doctor will check it like any other device.' }],
      }),
    );
  }
  return { status: 'broken', headline: 'Plug Doctor could not find Bluetooth on this computer.', checks, plans, facts, support: { level: 'unknown' } };
}

async function diagnoseController(device, ctx) {
  const { platform } = ctx;
  const d = device.details;
  const checks = [];
  const plans = [];
  const facts = {
    chipset: d.chipset,
    address: d.address,
    powered: d.powered,
    connectedDevices: d.connectedCount,
    pairedDevices: d.pairedCount,
    ...(platform === 'linux' ? { serviceActive: d.serviceActive, softBlocked: d.softBlocked, hardBlocked: d.hardBlocked } : {}),
    ...(d.instanceId ? { instanceId: d.instanceId } : {}),
  };
  const native = { level: 'native' };

  if (d.present === false) return noControllerResult(device, ctx, checks, plans, facts);

  let off = d.powered === false;
  if (platform === 'linux') {
    const issues = linuxStackChecks(d, checks);
    off = off || issues.off;
    if (issues.bluez) {
      plans.push(bluezPlan(ctx));
      return { status: 'broken', headline: 'The Bluetooth software is not installed.', checks, plans, facts, support: native };
    }
  }

  if (d.present === null && !off) {
    checks.push(check('controller', 'This computer has Bluetooth', 'info', 'Plug Doctor could not read the Bluetooth state on this computer.'));
    return { status: 'unknown', headline: 'Plug Doctor could not read the Bluetooth state on this computer.', checks, plans, facts, support: native };
  }
  checks.push(check('controller', 'This computer has Bluetooth', 'pass', d.chipset ?? ''));

  if (platform === 'win32' && device.problem) {
    checks.push(check('radio', 'Bluetooth adapter working', 'fail', `Windows reports a problem with the Bluetooth adapter: ${device.problem.message}`));
    if (device.problem.code === 22 && d.instanceId) {
      const id = d.instanceId.replace(/'/g, "''");
      plans.push(
        plan({
          id: 'windows-enable-radio',
          title: 'Turn the Bluetooth adapter back on',
          why: 'The Bluetooth adapter is disabled in Device Manager. This enables it again.',
          confidence: 0.8,
          steps: [{ kind: 'command', title: 'Enable the adapter', explain: 'Enables the Bluetooth adapter in Device Manager.', cmd: 'powershell.exe', args: ['-NoProfile', '-Command', `Enable-PnpDevice -InstanceId '${id}' -Confirm:$false`], admin: true, safe: true }],
        }),
      );
    }
    plans.push(
      plan({
        id: 'windows-rescan',
        title: 'Ask Windows to set up the Bluetooth adapter again',
        why: 'Re-detecting hardware makes Windows reload the adapter\'s driver, and fetch one from Windows Update if needed.',
        confidence: 0.6,
        auto: true,
        steps: [{ kind: 'command', title: 'Re-scan devices', explain: 'Asks Windows to re-detect hardware and load its drivers.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true }],
      }),
    );
    return { status: 'broken', headline: 'Windows reports a problem with the Bluetooth adapter.', checks, plans, facts, support: native };
  }

  if (off) {
    checks.push(check('powered', 'Bluetooth is on', 'fail', d.hardBlocked ? 'Switched off by a wireless switch, a key or airplane mode.' : 'Bluetooth is switched off.'));
    plans.push(turnOnPlan(d, platform));
    return { status: 'needs-fix', headline: 'Bluetooth is switched off on this computer.', checks, plans, facts, support: native };
  }

  if (d.powered === true) {
    checks.push(check('powered', 'Bluetooth is on', 'pass'));
  } else if (platform === 'win32') {
    checks.push(check('powered', 'Bluetooth is on', 'info', 'Windows does not report whether Bluetooth is switched on. If no device connects, check the switch in Settings > Bluetooth & devices.'));
    plans.push(plan({ id: 'open-settings', title: 'Open Bluetooth settings', why: 'To check that Bluetooth is switched on, and to pair new devices.', confidence: 0.2, steps: [openBluetoothSettings('win32')] }));
  }

  const n = d.connectedCount ?? 0;
  const headline = n === 0 ? 'Bluetooth is working. No devices are connected right now.' : `Bluetooth is working. ${n} device${n === 1 ? '' : 's'} connected.`;
  return { status: 'ok', headline, checks, plans, facts, support: native };
}

// ---------------------------------------------------------------- paired devices

function batteryText(b) {
  const label = { main: 'Battery', left: 'Left', right: 'Right', case: 'Case' };
  return Object.entries(b).map(([k, v]) => `${label[k] ?? k} ${v}%`).join(', ');
}

function reconnectPlan(device, platform) {
  const d = device.details;
  const name = device.displayName;
  const steps = [{ kind: 'manual', title: `Turn on ${name} and bring it close`, explain: 'Make sure it is switched on, charged and within a few meters of the computer. If it is connected to another phone or computer, disconnect it there first.' }];
  if (platform === 'linux' && d.address) {
    if (d.trusted === false) {
      steps.push({ kind: 'command', title: 'Let it reconnect by itself', explain: 'Marks the device as trusted, so it can connect again without asking.', cmd: 'bluetoothctl', args: ['trust', d.address], admin: false, safe: true, optional: true });
    }
    steps.push({ kind: 'command', title: `Connect ${name}`, explain: 'Asks the computer to connect to it.', cmd: 'bluetoothctl', args: ['connect', d.address], admin: false, safe: true });
  } else {
    const open = openBluetoothSettings(platform);
    if (open) steps.push(open);
    steps.push({ kind: 'manual', title: `Connect ${name}`, explain: platform === 'darwin' ? `Find ${name} in the list and click Connect.` : `Select ${name} in the list, then choose Connect.` });
  }
  return plan({ id: 'reconnect', title: `Reconnect ${name}`, why: 'It is paired with this computer but not connected. Usually it is off, out of range or connected to another device.', confidence: 0.7, steps });
}

function repairPlan(device, platform) {
  const name = device.displayName;
  const where = SETTINGS_NAME[platform] ?? SETTINGS_NAME.linux;
  const steps = [];
  const open = openBluetoothSettings(platform);
  if (open) steps.push(open);
  steps.push(
    { kind: 'manual', title: `Remove ${name}`, explain: `In ${where}, find ${name} and remove it (Forget / Remove device). This only removes the pairing; you will pair it again in a moment.` },
    { kind: 'manual', title: 'Put it in pairing mode', explain: 'Usually you hold its power or Bluetooth button for a few seconds until a light flashes. Its manual has the exact way.' },
    { kind: 'manual', title: 'Pair it again', explain: `In ${where}, wait for ${name} to appear in the list and choose it to pair. Then press "Check again".` },
  );
  return plan({ id: 'pair-again', title: `Pair ${name} again`, why: 'If reconnecting does not work, starting the pairing over fixes most Bluetooth connection problems.', confidence: 0.4, steps });
}

/** "No sound?" help for connected headphones and speakers. May call pactl on Linux. */
async function audioOutput(device, ctx, checks, plans, facts) {
  const { platform, run } = ctx;
  const name = device.displayName;
  if (platform === 'linux') {
    const sinks = await run('pactl', ['list', 'short', 'sinks'], { timeout: 5000 });
    if (!sinks.ok) {
      checks.push(check('audio-output', 'Sound goes to it', 'info', `No sound? Choose ${name} as the output in your desktop's sound settings.`));
      return;
    }
    const tag = (device.details.address ?? '').replace(/:/g, '_').toLowerCase();
    const sink = tag
      ? sinks.stdout.split('\n').map((l) => l.split('\t')[1]?.trim()).find((s) => s && s.toLowerCase().includes(tag))
      : null;
    if (!sink) {
      checks.push(
        check('audio-output', 'Sound goes to it', 'info', `The sound system has no output for ${name} yet. If you hear nothing, choose it as the output in your desktop's sound settings; if it is not listed there, disconnect and reconnect it.`),
      );
      return;
    }
    facts.audioSink = sink;
    const info = await run('pactl', ['info'], { timeout: 5000 });
    const current = info.stdout.match(/^Default Sink:\s*(.+)$/m)?.[1].trim() ?? null;
    if (current === sink) {
      checks.push(check('audio-output', 'Sound goes to it', 'pass', `${name} is the sound output.`));
      return;
    }
    checks.push(check('audio-output', 'Sound goes to it', 'warn', `Sound is going to another output${current ? ` (${current})` : ''}, not to ${name}.`));
    plans.push(
      plan({
        id: 'audio-output',
        title: `Play sound through ${name}`,
        why: `${name} is connected, but sound is still going somewhere else.`,
        confidence: 0.6,
        steps: [{ kind: 'command', title: `Use ${name} for sound`, explain: 'Makes it the default sound output.', cmd: 'pactl', args: ['set-default-sink', sink], admin: false, safe: true }],
      }),
    );
    return;
  }
  const isMac = platform === 'darwin';
  checks.push(
    check(
      'audio-output',
      'Sound goes to it',
      'info',
      isMac
        ? `No sound? Choose ${name} under Output in System Settings > Sound, or from the Sound menu in the menu bar.`
        : `No sound? Choose ${name} under Output in Settings > System > Sound, or from the sound icon in the taskbar.`,
    ),
  );
  plans.push(
    plan({
      id: 'audio-output',
      title: `No sound? Play sound through ${name}`,
      why: 'Connected headphones are not always picked as the sound output automatically.',
      confidence: 0.3,
      steps: [
        isMac
          ? { kind: 'command', title: 'Open Sound settings', explain: 'Opens the Sound page of System Settings.', cmd: 'open', args: [MAC_SOUND_PANE], admin: false, safe: true }
          : { kind: 'command', title: 'Open Sound settings', explain: 'Opens the Sound page of Windows Settings.', cmd: 'explorer.exe', args: ['ms-settings:sound'], admin: false, safe: true, optional: true },
        { kind: 'manual', title: `Choose ${name} as the output`, explain: `Under Output, select ${name}.` },
      ],
    }),
  );
}

async function diagnoseRemote(device, ctx) {
  const { platform } = ctx;
  const d = device.details;
  const ctl = d.controller ?? {};
  const name = device.displayName;
  const kind = KIND_NAME[d.kind] ?? null;
  const checks = [];
  const plans = [];
  const facts = {
    address: d.address,
    kind: d.kind,
    connected: d.connected,
    paired: d.paired,
    ...(d.battery ? { battery: d.battery } : {}),
    ...(d.vendorId ? { bluetoothVendorId: d.vendorId, bluetoothProductId: d.productId } : {}),
    ...(d.instanceId ? { instanceId: d.instanceId } : {}),
  };
  const native = { level: 'native' };

  if (device.problem) {
    checks.push(check('windows-device', 'Windows reports no problems', 'fail', device.problem.message));
    plans.push(
      plan({
        id: 'windows-rescan',
        title: 'Ask Windows to set it up again',
        why: 'Re-detecting hardware makes Windows reload the driver for this device.',
        confidence: 0.5,
        auto: true,
        steps: [{ kind: 'command', title: 'Re-scan devices', explain: 'Asks Windows to re-detect hardware and load its drivers.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true }],
      }),
      repairPlan(device, platform),
    );
    return { status: 'broken', headline: `Windows reports a problem with ${name}.`, checks, plans, facts, support: native };
  }

  const btOff = ctl.powered === false || ctl.softBlocked === true || ctl.hardBlocked === true || ctl.serviceActive === false;
  if (btOff && d.connected !== true) {
    checks.push(check('bluetooth-on', 'Bluetooth on this computer is on', 'fail', 'Bluetooth is switched off on this computer.'));
    plans.push(turnOnPlan(ctl, platform));
    return { status: 'needs-fix', headline: `Bluetooth is switched off on this computer, so ${name} cannot connect.`, checks, plans, facts, support: native };
  }

  if (d.blocked === true && d.address) {
    checks.push(check('blocked', 'Allowed to connect', 'fail', 'This device is on the computer\'s block list, so it cannot connect.'));
    plans.push(
      plan({
        id: 'unblock',
        title: `Allow ${name} to connect`,
        why: 'It was blocked on this computer. Unblocking it lets it connect again.',
        confidence: 0.9,
        steps: [{ kind: 'command', title: `Unblock ${name}`, explain: 'Removes the device from the block list.', cmd: 'bluetoothctl', args: ['unblock', d.address], admin: false, safe: true }],
      }),
    );
    return { status: 'needs-fix', headline: `${name} is blocked on this computer.`, checks, plans, facts, support: native };
  }

  if (d.paired === true) checks.push(check('paired', 'Paired with this computer', 'pass'));
  else if (d.paired === false) checks.push(check('paired', 'Paired with this computer', 'info', 'Connected without pairing. It may not reconnect by itself later.'));

  if (d.connected === false) {
    checks.push(check('connected', 'Connected', 'warn', 'Paired with this computer, but not connected right now.'));
    plans.push(reconnectPlan(device, platform), repairPlan(device, platform));
    // Remembered but switched off or away is normal, not a fault: a Mac
    // can remember dozens of devices. 'idle' keeps them out of the alarms.
    return { status: 'idle', headline: `${name} is paired but not connected right now.`, checks, plans, facts, support: native };
  }

  if (d.connected === true) {
    checks.push(check('connected', 'Connected', 'pass'));
  } else {
    checks.push(check('connected', 'Connected', 'info', 'This computer does not report whether it is connected right now.'));
    plans.push(reconnectPlan(device, platform), repairPlan(device, platform));
    plans.forEach((p) => (p.confidence = Math.min(p.confidence, 0.3)));
  }

  let low = null;
  if (d.battery) {
    const levels = Object.entries(d.battery);
    low = levels.filter(([, v]) => v <= LOW_BATTERY);
    checks.push(check('battery', 'Battery', low.length ? 'warn' : 'pass', `${batteryText(d.battery)}${low.length ? '. Charge it soon.' : ''}`));
  }

  if (d.connected === true && AUDIO_KINDS.has(d.kind)) await audioOutput(device, ctx, checks, plans, facts);

  const what = kind ? `Your ${kind}` : name;
  let headline = d.connected === true ? `${what} ${kind === 'headphones' ? 'are' : 'is'} connected and working.` : `${name} is paired with this computer.`;
  if (low?.length) headline = `${d.connected === true ? 'Connected, but the' : 'The'} battery is low (${batteryText(Object.fromEntries(low))}).`;
  return { status: 'ok', headline, checks, plans, facts, support: native };
}

async function diagnoseBluetooth(device, ctx) {
  if (device.details?.role === 'controller') return diagnoseController(device, ctx);
  return diagnoseRemote(device, ctx);
}

/** @type {import('./index').Family} */
const family = {
  id: 'bluetooth',
  label: 'Bluetooth',
  icon: 'bluetooth',
  sources: ['bluetooth'],
  match: (d) => (d.source === 'bluetooth' ? 80 : 0),
  // Bluetooth devices have no driver of their own to bind.
  userspace: () => true,
  diagnose: diagnoseBluetooth,
};

module.exports = { family, diagnoseBluetooth, turnOnSteps, LOW_BATTERY };
