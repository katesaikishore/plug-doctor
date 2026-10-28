'use strict';

const { check, plan } = require('./helpers');

/**
 * USB sound devices: headsets, speakers, DACs, microphones, audio
 * interfaces and MIDI keyboards. Devices that follow the USB Audio Class
 * need no driver on any desktop OS, so the checks confirm the OS actually
 * turned the device into something apps can use.
 */

/**
 * Makers of audio interfaces and MIDI gear whose vendor-specific devices
 * (class ff) are audio devices that need the maker's driver.
 */
const PRO_AUDIO_VENDORS = {
  '1235': 'Focusrite / Novation',
  '0582': 'Roland',
  '17cc': 'Native Instruments',
  '07fd': 'MOTU',
  '0e41': 'Line 6',
  '0763': 'M-Audio',
  '1397': 'Behringer',
  '194f': 'PreSonus',
  '0644': 'TASCAM',
};

const MAC_SOUND_SETTINGS = 'x-apple.systempreferences:com.apple.Sound-Settings.extension';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** What the device's interfaces say it can do. */
function audioRoles(device) {
  const itfs = device.interfaces ?? [];
  const audio = itfs.filter((i) => i.class === '01');
  const streaming = audio.some((i) => i.subclass === '02');
  const midi = audio.some((i) => i.subclass === '03');
  const classCompliant = audio.length > 0 || device.deviceClass === '01';
  return {
    classCompliant,
    streaming,
    midi,
    vendorSpecific: itfs.some((i) => i.class === 'ff'),
    kind: !classCompliant ? 'vendor' : midi && !streaming ? 'midi' : 'audio',
  };
}

function matchAudio(d) {
  const classes = new Set([d.deviceClass, ...(d.interfaces ?? []).map((i) => i.class)]);
  // Webcams carry a microphone; the camera family handles them.
  if (classes.has('01')) return classes.has('0e') || classes.has('10') ? 30 : 85;
  if (PRO_AUDIO_VENDORS[d.vendorId] && classes.has('ff')) return 60;
  return 0;
}

// ---------------------------------------------------------------- parsers

/**
 * `/proc/asound/cards`. The second line of each card names where it is
 * plugged in ("... at usb-0000:00:14.0-2.3, full speed"), which ties a sound
 * card to a USB port without guessing from names.
 */
function parseAsoundCards(text) {
  const cards = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(\d+)\s+\[([^\]]*)\]:\s*(\S+)\s+-\s+(.*)$/);
    if (!m) continue;
    const desc = (lines[i + 1] ?? '').trim();
    const usb = desc.match(/\bat usb-(\S+)-([\d.]+),/);
    cards.push({ index: Number(m[1]), id: m[2].trim(), driver: m[3], name: m[4].trim(), description: desc, usbPort: usb ? usb[2] : null });
  }
  return cards;
}

/** `aplay -l` / `arecord -l`: one entry per PCM device. */
function parseAplay(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^card (\d+): (\S+) \[(.*?)\], device (\d+): (.*?) \[(.*)\]\s*$/);
    if (m) out.push({ card: Number(m[1]), id: m[2], cardName: m[3], device: Number(m[4]), name: m[6] });
  }
  return out;
}

/** `amidi -l`: MIDI ports as { dir, card, port, name }. */
function parseAmidi(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*(IO|I|O)\s+hw:(\d+),(\d+)(?:,(\d+))?\s+(.*)$/);
    if (m) out.push({ dir: m[1], card: Number(m[2]), port: `hw:${m[2]},${m[3]}${m[4] != null ? ',' + m[4] : ''}`, name: m[5].trim() });
  }
  return out;
}

/** `aconnect -l`: ALSA sequencer clients as { client, name, card }. */
function parseAconnect(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^client (\d+): '([^']*)' \[([^\]]*)\]/);
    if (!m) continue;
    const card = m[3].match(/card=(\d+)/);
    out.push({ client: Number(m[1]), name: m[2], card: card ? Number(card[1]) : null });
  }
  return out;
}

/** `pactl list short sinks`: tab-separated id, name, driver, format, state. */
function parsePactlSinks(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cols = line.split('\t');
    if (cols.length >= 2 && /^\d+$/.test(cols[0].trim()) && cols[1].trim()) {
      out.push({ id: Number(cols[0]), name: cols[1].trim(), state: (cols[4] ?? '').trim() || null });
    }
  }
  return out;
}

/**
 * `system_profiler SPAudioDataType -json`, flattened to the audio devices
 * it lists. Walks the whole tree so a changed nesting does not break it.
 */
function parseSpAudio(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const out = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if (typeof node._name === 'string' && Object.keys(node).some((k) => k.startsWith('coreaudio_device_') || k.startsWith('coreaudio_default_'))) {
      out.push({
        name: node._name,
        manufacturer: typeof node.coreaudio_device_manufacturer === 'string' ? node.coreaudio_device_manufacturer : null,
        transport: typeof node.coreaudio_device_transport === 'string' ? node.coreaudio_device_transport.replace(/^coreaudio_device_type_/, '') : null,
        inputs: Number(node.coreaudio_device_input) || 0,
        outputs: Number(node.coreaudio_device_output) || 0,
        defaultOutput: node.coreaudio_default_audio_output_device === 'spaudio_yes',
        defaultInput: node.coreaudio_default_audio_input_device === 'spaudio_yes',
      });
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(data, 0);
  return out;
}

// ---------------------------------------------------------------- matching

/** The USB port path ("2.3") from a Linux sysfs name ("1-2.3"). */
function portPath(sysName) {
  const m = String(sysName ?? '').match(/^\d+-([\d.]+)$/);
  return m ? m[1] : null;
}

function nameMatches(device, ...names) {
  const product = norm(device.productName);
  if (product.length < 3) return false;
  return names.some((n) => norm(n).includes(product));
}

/** This device's ALSA card, by USB port first, then by name. */
function findCard(device, cards) {
  const usb = cards.filter((c) => c.driver === 'USB-Audio' || c.usbPort);
  const port = portPath(device.sysName);
  if (port) {
    const byPort = usb.filter((c) => c.usbPort === port);
    if (byPort.length === 1) return byPort[0];
    if (byPort.length > 1) return byPort.find((c) => nameMatches(device, c.name, c.description)) ?? null;
  }
  const byName = usb.filter((c) => nameMatches(device, c.name, c.description));
  if (byName.length === 1) return byName[0];
  return !port && usb.length === 1 ? usb[0] : null;
}

/**
 * The PipeWire / PulseAudio output for this device. Sink names embed the USB
 * vendor and product strings ("alsa_output.usb-Focusrite_Scarlett_2i2_USB-00.analog-stereo").
 * Returns null unless exactly one USB sink matches.
 */
function findSink(device, sinks) {
  const usb = sinks.filter((s) => /^alsa_output\.usb-/.test(s.name));
  let hits = usb.filter((s) => nameMatches(device, s.name));
  const serial = norm(device.serial);
  if (hits.length > 1 && serial.length >= 4) hits = hits.filter((s) => norm(s.name).includes(serial));
  return hits.length === 1 ? hits[0] : null;
}

function findMacAudio(device, items) {
  const product = norm(device.productName);
  const exact = items.filter((i) => product && norm(i.name) === product);
  if (exact.length) return exact[0];
  const partial = items.filter((i) => nameMatches(device, i.name) || (product.length >= 3 && norm(i.name).length >= 3 && product.includes(norm(i.name)) && i.transport === 'usb'));
  if (partial.length === 1) return partial[0];
  const usb = items.filter((i) => i.transport === 'usb');
  return usb.length === 1 ? usb[0] : null;
}

// ---------------------------------------------------------------- plans

const replugStep = { kind: 'manual', title: 'Unplug the device and plug it back in', explain: 'Use a port directly on the computer rather than a hub if you can. Then press "Check again".' };

function vendorDriverPlan(device, platform) {
  const maker = PRO_AUDIO_VENDORS[device.vendorId] ?? device.vendorName ?? 'the maker';
  const steps = [
    {
      kind: 'manual',
      title: `Install ${maker}'s driver or control app`,
      explain:
        `Download it from ${maker}'s website (look for "Downloads" or "Support" and your model), install it, then press "Check again".` +
        (platform === 'darwin'
          ? " Pick the version for your macOS. If the installer asks you to lower your Mac's security settings, stop: look for a newer driver instead, or ask the maker whether the device has a class-compliant mode."
          : ''),
    },
    replugStep,
  ];
  return plan({ id: 'vendor-driver', title: `Install ${maker}'s driver`, why: "This device uses its maker's own protocol instead of the standard USB audio one, so it needs their software.", confidence: 0.6, steps });
}

function macSoundPlan(output) {
  return plan({
    id: 'sound-settings',
    title: output ? 'Choose it as the sound output' : 'Check it in Sound settings',
    why: output ? 'macOS does not always switch to a new sound device by itself. Pick it once and macOS remembers.' : 'Sound settings shows every sound device macOS can use.',
    confidence: 0.6,
    steps: [
      { kind: 'command', title: 'Open Sound settings', explain: 'Opens System Settings at Sound.', cmd: 'open', args: [MAC_SOUND_SETTINGS], admin: false, safe: true },
      { kind: 'manual', title: `Pick it under ${output ? 'Output' : 'Output or Input'}`, explain: 'Click its name in the list. Then press "Check again".' },
    ],
  });
}

function windowsSoundPlan() {
  return plan({
    id: 'sound-settings',
    title: 'Choose it as the sound output',
    why: 'Windows does not always switch to a new sound device by itself. Pick it once and Windows remembers.',
    confidence: 0.5,
    steps: [
      { kind: 'command', title: 'Open Sound settings', explain: 'Opens Settings at System > Sound.', cmd: 'explorer.exe', args: ['ms-settings:sound'], admin: false, safe: true },
      { kind: 'manual', title: 'Pick it under Output', explain: 'Choose its name in the list. Then press "Check again".' },
    ],
  });
}

// ---------------------------------------------------------------- per OS

async function linuxAudio(device, ctx, roles) {
  const { run } = ctx;
  const checks = [];
  const plans = [];
  const facts = { roles: roleList(roles) };

  if (roles.kind === 'vendor') return vendorOnly(device, ctx, roles);

  const audioItfs = device.interfaces.filter((i) => i.class === '01');
  if (audioItfs.length && !audioItfs.some((i) => i.driver)) {
    checks.push(check('driver', 'Sound driver attached', 'fail', "Linux's built-in USB audio driver (snd-usb-audio) did not attach to this device."));
    plans.push(
      plan({
        id: 'load-snd-usb-audio',
        title: 'Load the USB sound driver',
        why: 'Linux has a built-in driver for USB sound devices; it just was not loaded.',
        confidence: 0.7,
        auto: true,
        steps: [{ kind: 'command', title: 'Load snd-usb-audio', explain: 'Loads the kernel driver for USB sound devices.', cmd: 'modprobe', args: ['snd-usb-audio'], admin: true, safe: true }],
      }),
    );
    return { status: 'broken', headline: 'The USB sound driver is not attached to this device.', checks, plans, facts };
  }
  if (audioItfs.length) checks.push(check('driver', 'Sound driver attached', 'pass', [...new Set(audioItfs.map((i) => i.driver).filter(Boolean))].join(', ')));

  const cardsRes = await run('cat', ['/proc/asound/cards']);
  const playRes = await run('aplay', ['-l']);
  const recRes = await run('arecord', ['-l']);
  const playback = parseAplay(playRes.stdout);
  const capture = parseAplay(recRes.stdout);
  let card = findCard(device, parseAsoundCards(cardsRes.stdout));
  if (!card && !cardsRes.ok) {
    // No /proc/asound: fall back to the card names aplay/arecord print.
    const named = [...playback, ...capture].filter((p) => nameMatches(device, p.cardName));
    const ids = [...new Set(named.map((p) => p.card))];
    if (ids.length === 1) card = { index: ids[0], name: named[0].cardName };
  }

  if (!card) {
    const unknown = !cardsRes.ok && playRes.missing && recRes.missing;
    checks.push(check('sound-card', 'Linux made it a sound card', unknown ? 'info' : 'fail', unknown ? 'Could not list sound cards on this computer.' : 'The driver is attached but no sound card appeared for this device.'));
    if (unknown) return { status: 'unknown', headline: 'The USB sound driver is attached. Plug Doctor could not list sound cards to confirm the rest.', checks, plans, facts };
    plans.push(plan({ id: 'replug', title: 'Reconnect the device', why: 'A sound card that does not appear is often a power or connection hiccup.', confidence: 0.4, steps: [replugStep] }));
    return { status: 'broken', headline: 'The device is connected but no sound card appeared.', checks, plans, facts };
  }
  facts.card = `card ${card.index}: ${card.name}`;
  checks.push(check('sound-card', 'Linux made it a sound card', 'pass', facts.card));

  if (roles.streaming && (playRes.ok || recRes.ok)) {
    const outs = playback.filter((p) => p.card === card.index);
    const ins = capture.filter((p) => p.card === card.index);
    facts.outputs = outs.length;
    facts.inputs = ins.length;
    checks.push(check('playback', 'Sound output', outs.length ? 'pass' : 'info', outs.length ? outs.map((p) => p.name).join(', ') : 'None. This device only records (a microphone or line input).'));
    checks.push(check('capture', 'Sound input', ins.length ? 'pass' : 'info', ins.length ? ins.map((p) => p.name).join(', ') : 'None. This device only plays sound.'));
  }

  if (roles.midi) {
    const amidi = await run('amidi', ['-l']);
    let ports = parseAmidi(amidi.stdout).filter((p) => p.card === card.index).map((p) => `${p.port} ${p.name}`);
    let tool = amidi;
    if (amidi.missing) {
      tool = await run('aconnect', ['-l']);
      ports = parseAconnect(tool.stdout).filter((c) => c.card === card.index).map((c) => `client ${c.client}: ${c.name}`);
    }
    facts.midiPorts = ports;
    if (tool.missing) checks.push(check('midi', 'MIDI ports', 'info', 'The ALSA tools (alsa-utils) are not installed, so Plug Doctor cannot list MIDI ports. Music apps can still see the device.'));
    else checks.push(check('midi', 'MIDI ports', ports.length ? 'pass' : 'warn', ports.length ? ports.join(', ') : 'The sound card exists but it lists no MIDI ports.'));
  }

  if (roles.kind === 'midi') {
    return { status: 'ok', headline: 'Ready. Music apps can use it as a MIDI device.', checks, plans, facts };
  }

  // The desktop sound server (PipeWire or PulseAudio) decides where apps play.
  if (facts.outputs !== 0) {
    const sinksRes = await run('pactl', ['list', 'short', 'sinks']);
    if (sinksRes.ok) {
      const sink = findSink(device, parsePactlSinks(sinksRes.stdout));
      if (sink) {
        facts.sink = sink.name;
        const info = await run('pactl', ['info']);
        const def = (info.stdout.match(/^Default Sink:\s*(.+)$/m) ?? [])[1]?.trim() ?? null;
        if (def === sink.name) {
          checks.push(check('default-output', 'Used for sound', 'pass', 'It is the default sound output.'));
        } else {
          checks.push(check('default-output', 'Used for sound', 'info', 'Your desktop knows it, but sound currently plays somewhere else.'));
          plans.push(
            plan({
              id: 'set-default-sink',
              title: 'Play sound through it',
              why: 'Makes it the default output, the same as picking it in your sound settings. You can switch back any time.',
              confidence: 0.6,
              steps: [{ kind: 'command', title: 'Make it the default output', explain: `Sends sound from all apps to ${device.productName}.`, cmd: 'pactl', args: ['set-default-sink', sink.name], admin: false, safe: true, optional: true }],
            }),
          );
        }
      }
    }
  }
  return {
    status: 'ok',
    headline: plans.length ? 'Working. You can make it your sound output with one click.' : 'Working. It shows up as a sound device.',
    checks,
    plans,
    facts,
  };
}

async function macAudio(device, ctx, roles) {
  const checks = [];
  const plans = [];
  const facts = { roles: roleList(roles) };

  if (roles.kind === 'vendor') return vendorOnly(device, ctx, roles);

  if (roles.kind === 'midi') {
    checks.push(check('midi', 'MIDI', 'pass', 'macOS drives standard USB MIDI devices itself. Music apps see it directly.'));
    plans.push(
      plan({
        id: 'audio-midi-setup',
        title: 'See it in Audio MIDI Setup',
        why: "Audio MIDI Setup is macOS's own window for MIDI devices. Useful to check it is there or to rename it.",
        confidence: 0.4,
        steps: [
          { kind: 'command', title: 'Open Audio MIDI Setup', explain: 'Opens the built-in Audio MIDI Setup app.', cmd: 'open', args: ['-a', 'Audio MIDI Setup'], admin: false, safe: true },
          { kind: 'manual', title: 'Choose Window > Show MIDI Studio', explain: 'Your device should appear as an icon. A greyed-out icon means macOS remembers it but cannot reach it now.' },
        ],
      }),
    );
    return { status: 'ok', headline: 'Ready. macOS handles MIDI devices itself.', checks, plans, facts };
  }

  const res = await ctx.run('system_profiler', ['SPAudioDataType', '-json'], { timeout: 30000 });
  const items = res.ok ? parseSpAudio(res.stdout) : null;
  if (!items) {
    checks.push(check('os-sees', 'macOS lists it as a sound device', 'info', 'Could not read the list of sound devices.'));
    return { status: 'unknown', headline: 'Connected. Plug Doctor could not read the list of sound devices.', checks, plans: [macSoundPlan(roles.streaming)], facts };
  }
  const mine = findMacAudio(device, items);
  if (!mine) {
    checks.push(check('os-sees', 'macOS lists it as a sound device', 'fail', 'macOS does not list this device among its sound devices.'));
    plans.push(plan({ id: 'replug', title: 'Reconnect the device', why: 'A sound device that does not appear is often a power or connection hiccup.', confidence: 0.4, steps: [replugStep] }));
    return { status: 'broken', headline: 'The device is connected but macOS did not make it a sound device.', checks, plans, facts };
  }
  Object.assign(facts, { coreAudioName: mine.name, outputs: mine.outputs, inputs: mine.inputs });
  const io = [mine.outputs ? `${mine.outputs} output channel${mine.outputs === 1 ? '' : 's'}` : null, mine.inputs ? `${mine.inputs} input channel${mine.inputs === 1 ? '' : 's'}` : null].filter(Boolean).join(', ');
  checks.push(check('os-sees', 'macOS lists it as a sound device', 'pass', `${mine.name}${io ? ` (${io})` : ''}`));
  if (mine.outputs) {
    checks.push(check('default-output', 'Used for sound', mine.defaultOutput ? 'pass' : 'info', mine.defaultOutput ? 'It is the current sound output.' : 'Sound currently plays somewhere else.'));
    if (!mine.defaultOutput) plans.push(macSoundPlan(true));
  } else if (mine.inputs) {
    checks.push(check('default-input', 'Used for recording', mine.defaultInput ? 'pass' : 'info', mine.defaultInput ? 'It is the current sound input.' : 'Apps record from another input unless you pick this one.'));
    if (!mine.defaultInput) plans.push(macSoundPlan(false));
  }
  return { status: 'ok', headline: plans.length ? 'Working. Pick it in Sound settings to use it.' : 'Working. It is your sound device.', checks, plans, facts };
}

async function windowsAudio(device, ctx, roles) {
  if (roles.kind === 'vendor') return vendorOnly(device, ctx, roles);
  const facts = { roles: roleList(roles) };
  if (device.problem) {
    return {
      status: 'broken',
      headline: 'Windows has a problem with this sound device.',
      checks: [check('driver', 'Windows has a working driver', 'fail', device.problem.message)],
      plans: [
        plan({
          id: 'windows-update',
          title: 'Ask Windows to look for a driver',
          why: 'Windows has a built-in driver for standard USB sound devices. Re-scanning usually fixes a device that did not start.',
          confidence: 0.6,
          auto: true,
          steps: [{ kind: 'command', title: 'Re-scan devices', explain: 'Asks Windows to re-detect hardware and fetch a driver.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true }],
        }),
      ],
      facts: { ...facts, problemCode: device.problem.code },
    };
  }
  const checks = [check('driver', 'Windows has a working driver', 'pass', device.driver?.names?.join(', ') ?? '')];
  if (roles.kind === 'midi') return { status: 'ok', headline: 'Ready. Music apps can use it as a MIDI device.', checks, plans: [], facts };
  return { status: 'ok', headline: 'Working. Pick it in Sound settings if sound plays elsewhere.', checks, plans: [windowsSoundPlan()], facts };
}

/** Vendor-specific audio gear with no standard audio interface. */
async function vendorOnly(device, ctx) {
  const maker = PRO_AUDIO_VENDORS[device.vendorId] ?? device.vendorName ?? 'its maker';
  const working = ctx.platform === 'win32' ? !device.problem && device.driver?.bound !== false : device.driver?.bound === true;
  const facts = { roles: ['vendor-specific'] };
  if (working) {
    return {
      status: 'ok',
      headline: `Working with ${maker}'s driver.`,
      checks: [check('vendor-driver', "Maker's driver attached", 'pass', device.driver?.names?.join(', ') ?? '')],
      plans: [],
      facts,
    };
  }
  if (ctx.platform === 'linux') {
    return {
      status: 'broken',
      headline: `This device uses ${maker}'s own protocol, and Linux has no driver for it.`,
      checks: [check('vendor-driver', 'A driver for its protocol', 'fail', `${maker} does not usually publish Linux drivers. Search the device's USB ID (${device.vendorId}:${device.productId}) with "ALSA" or "Linux" to see whether the community supports it.`)],
      plans: [],
      facts,
      support: { level: 'unknown', note: 'Some devices like this are supported by Linux community drivers; many are not.' },
    };
  }
  return {
    status: 'needs-fix',
    headline: `This audio device needs ${maker}'s driver.`,
    checks: [check('vendor-driver', "Maker's driver attached", 'fail', ctx.platform === 'win32' && device.problem ? device.problem.message : 'No driver is handling it yet.')],
    plans: [vendorDriverPlan(device, ctx.platform)],
    facts,
    support: { level: 'vendor-driver', note: "Audio interfaces like this one come with the maker's driver or control app." },
  };
}

function roleList(roles) {
  return [roles.streaming ? 'audio' : null, roles.midi ? 'MIDI' : null, roles.vendorSpecific ? 'vendor-specific' : null].filter(Boolean);
}

async function diagnoseAudio(device, ctx) {
  const roles = audioRoles(device);
  if (ctx.platform === 'linux') return linuxAudio(device, ctx, roles);
  if (ctx.platform === 'darwin') return macAudio(device, ctx, roles);
  return windowsAudio(device, ctx, roles);
}

/** @type {import('./index').Family} */
const family = {
  id: 'audio',
  label: 'Sound device',
  icon: 'audio',
  sources: ['usb'],
  match: matchAudio,
  diagnose: diagnoseAudio,
};

module.exports = {
  family,
  diagnoseAudio,
  audioRoles,
  parseAsoundCards,
  parseAplay,
  parseAmidi,
  parseAconnect,
  parsePactlSinks,
  parseSpAudio,
  findCard,
  findSink,
  PRO_AUDIO_VENDORS,
};
