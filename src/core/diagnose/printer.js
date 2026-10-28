'use strict';

const cups = require('../printer/cups');
const { parseDeviceId } = require('../printer/ieee1284');
const { chooseDriver } = require('../printer/strategy');
const { installStep } = require('../fix/packages');
const { check, plan, testPagePath } = require('./helpers');

/** Find this USB device among the printers CUPS can see. */
function matchCupsDevice(device, cupsDevices) {
  const usb = cupsDevices.filter((d) => d.uri?.startsWith('usb:'));
  if (device.serial) {
    const bySerial = usb.find((d) => {
      try {
        return new URL(d.uri).searchParams.get('serial')?.toLowerCase() === device.serial.toLowerCase();
      } catch {
        return false;
      }
    });
    if (bySerial) return bySerial;
  }
  const name = (device.productName ?? '').toLowerCase();
  const byName = usb.find((d) => name && (d.makeAndModel ?? d.info ?? '').toLowerCase().includes(name.replace(/^hp /, '')));
  if (byName) return byName;
  return usb.length === 1 ? usb[0] : null;
}

function setupSteps({ queue, uri, candidate, manager, platform }) {
  const steps = [];
  if (candidate.packages) steps.push(installStep(candidate.packages, manager));
  for (const extra of candidate.recipe?.platforms?.[platform]?.steps ?? []) steps.push(extra);
  if (candidate.id === 'recipe' && !candidate.model) {
    steps.push({
      kind: 'manual',
      title: 'Press "Check again"',
      explain: 'With the driver installed, Plug Doctor can now find the exact driver for your model and finish the setup.',
    });
    return steps;
  }
  if (candidate.id === 'ipp-usb') {
    steps.push({
      kind: 'manual',
      title: 'Unplug the printer and plug it back in',
      explain: 'The driverless service picks the printer up on the next connection. Then press "Check again".',
    });
    return steps;
  }
  steps.push({
    kind: 'command',
    title: 'Add the printer',
    explain: `Creates a print queue called "${queue}" that sends jobs to the USB printer using ${candidate.label.toLowerCase()}.`,
    cmd: 'lpadmin',
    args: ['-p', queue, '-E', '-v', uri, '-m', candidate.model],
    admin: true,
    safe: true,
  });
  steps.push({
    kind: 'command',
    title: 'Make it your default printer',
    explain: 'So the Print button in every app uses it.',
    cmd: 'lpoptions',
    args: ['-d', queue],
    admin: false,
    safe: true,
    optional: true,
  });
  steps.push({
    kind: 'command',
    title: 'Print a test page',
    explain: 'One short page, so you can see it worked.',
    cmd: 'lp',
    args: ['-d', queue, '-t', 'Plug Doctor test page', testPagePath()],
    admin: false,
    safe: true,
    optional: true,
  });
  return steps;
}

/** CUPS (macOS + Linux) printer diagnosis. */
async function diagnoseCups(device, ctx) {
  const { run } = ctx;
  const checks = [];
  const plans = [];
  const facts = {};

  const lpstat = await run('lpstat', ['-v']);
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
    return { status: 'broken', headline: 'Your computer has no print system installed.', checks, plans, facts };
  }
  checks.push(check('cups', 'Print system (CUPS) installed', 'pass'));

  const lpinfo = await run('lpinfo', ['--include-schemes', 'usb', '-l', '-v'], { timeout: 60000 });
  const cupsDevice = matchCupsDevice(device, cups.parseLpinfoDevices(lpinfo.stdout));
  if (!cupsDevice) {
    checks.push(
      check(
        'cups-sees',
        'Print system can see the printer',
        'fail',
        lpinfo.ok
          ? 'The printer is on the USB bus but CUPS cannot talk to it. Another program (often a scanner or IPP-USB service) may have claimed it, or it needs firmware.'
          : `lpinfo failed: ${lpinfo.stderr.trim() || 'no output'}`,
      ),
    );
  } else {
    checks.push(check('cups-sees', 'Print system can see the printer', 'pass', cupsDevice.uri));
    facts.uri = cupsDevice.uri;
  }

  const idRaw = cupsDevice?.deviceId ?? '';
  const deviceId = idRaw ? parseDeviceId(idRaw) : null;
  if (deviceId) {
    facts.deviceId = idRaw;
    facts.model = deviceId.model;
    facts.commandSet = deviceId.commandSet;
    facts.languages = deviceId.languages;
    checks.push(
      check(
        'languages',
        'Printer languages',
        deviceId.languages.length && !deviceId.languages.every((l) => l === 'hostbased') ? 'pass' : 'warn',
        deviceId.commandSet.length ? `Speaks: ${deviceId.commandSet.join(', ')}` : 'The printer did not list any page languages.',
      ),
    );
  }

  const queues = cups.parseLpstatDevices(lpstat.stdout);
  const existing = cupsDevice ? queues.find((q) => cups.sameUsbPrinter(q.uri, cupsDevice.uri)) : null;
  if (existing) {
    facts.queue = existing.queue;
    const state = cups.parseLpstatPrinters((await run('lpstat', ['-p', existing.queue])).stdout)[0];
    if (state?.state === 'disabled') {
      checks.push(check('queue', 'Printer is set up', 'warn', `"${existing.queue}" exists but is paused: ${state.detail}`));
      plans.push(
        plan({
          id: 'resume-queue',
          title: 'Resume the printer',
          why: 'The printer is set up but paused, usually after a failed job. Resuming it is safe.',
          confidence: 0.9,
          auto: true,
          steps: [
            { kind: 'command', title: 'Resume printing', explain: 'Turns the paused queue back on.', cmd: 'cupsenable', args: [existing.queue], admin: true, safe: true },
            { kind: 'command', title: 'Accept new jobs', explain: 'Lets apps send jobs again.', cmd: 'cupsaccept', args: [existing.queue], admin: true, safe: true },
          ],
        }),
      );
      return { status: 'needs-fix', headline: 'Your printer is set up but paused.', checks, plans, facts };
    }
    checks.push(check('queue', 'Printer is set up', 'pass', `Queue "${existing.queue}" is ${state?.state ?? 'ready'}.`));
    plans.push(
      plan({
        id: 'test-page',
        title: 'Print a test page',
        why: 'Everything looks right. Print one page to be sure.',
        confidence: 1,
        steps: [{ kind: 'command', title: 'Print a test page', explain: 'One short page.', cmd: 'lp', args: ['-d', existing.queue, testPagePath()], admin: false, safe: true }],
      }),
    );
    return { status: 'ok', headline: `Ready to print as "${existing.queue}".`, checks, plans, facts };
  }
  checks.push(check('queue', 'Printer is set up', cupsDevice ? 'fail' : 'info', 'No print queue exists for this printer yet.'));

  if (!cupsDevice) {
    return { status: 'broken', headline: 'The printer is plugged in but the print system cannot reach it.', checks, plans, facts };
  }

  const models = cups.parseLpinfoModels((await run('lpinfo', ['-m'], { timeout: 120000 })).stdout);
  facts.installedDrivers = models.length;
  const candidates = chooseDriver({
    deviceId,
    models,
    interfaces: device.interfaces,
    recipes: ctx.recipes,
    platform: ctx.platform,
  });
  facts.candidates = candidates.map(({ recipe, ...c }) => c);

  const queue = cups.queueNameFor(deviceId?.model ?? cupsDevice.makeAndModel ?? device.productName);
  for (const candidate of candidates) {
    if (candidate.id === 'hostbased' || candidate.id === 'unknown') continue;
    if (candidate.id !== 'ipp-usb' && candidate.id !== 'recipe' && !candidate.model) continue;
    const title =
      candidate.id === 'ipp-usb' ? 'Turn on driverless printing'
      : candidate.id === 'recipe' && !candidate.model ? `Install the driver (${candidate.recipe.name})`
      : `Set up with: ${candidate.label}`;
    plans.push(
      plan({
        id: `setup-${candidate.id}`,
        title,
        why: candidate.why,
        confidence: candidate.confidence,
        steps: setupSteps({ queue, uri: cupsDevice.uri, candidate, manager: ctx.manager, platform: ctx.platform }),
        auto: candidate.confidence >= 0.7,
      }),
    );
  }

  const best = candidates[0];
  if (plans.length === 0) {
    checks.push(check('driver', 'A driver that can drive it', 'fail', best.why));
    return { status: 'broken', headline: 'No driver on this computer can drive this printer yet.', checks, plans, facts };
  }
  checks.push(check('driver', 'A driver that can drive it', 'pass', best.why));
  const oneClick = plans[0].steps.every((s) => s.kind === 'command');
  const headline = oneClick ? 'Found a way to make your printer work. One click to set it up.' : 'Found a way to make your printer work. It takes a couple of steps.';
  return { status: 'needs-fix', headline, checks, plans, facts };
}

/** Windows printer diagnosis, from Plug and Play state. */
async function diagnoseWindows(device) {
  const checks = [];
  const plans = [];
  const name = (device.productName || 'USB Printer').replace(/'/g, '');
  if (!device.problem) {
    checks.push(check('driver', 'Windows has a driver', 'pass', device.driver.names.join(', ')));
    return { status: 'ok', headline: 'Windows has installed this printer.', checks, plans, facts: {} };
  }
  checks.push(check('driver', 'Windows has a driver', 'fail', device.problem.message));
  plans.push(
    plan({
      id: 'windows-update',
      title: 'Ask Windows to look for a driver',
      why: 'Windows Update has drivers for most printers; this makes Windows search again.',
      confidence: 0.6,
      auto: true,
      steps: [{ kind: 'command', title: 'Re-scan devices', explain: 'Asks Windows to re-detect hardware and fetch a driver.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true }],
    }),
  );
  const script = [
    `Add-PrinterDriver -Name 'Microsoft PCL6 Class Driver' -ErrorAction SilentlyContinue`,
    `$port = (Get-PrinterPort | Where-Object Name -like 'USB*' | Select-Object -Last 1).Name`,
    `if (-not $port) { throw 'No USB printer port found' }`,
    `Add-Printer -Name '${name}' -DriverName 'Microsoft PCL6 Class Driver' -PortName $port`,
  ].join('; ');
  plans.push(
    plan({
      id: 'windows-class-driver',
      title: 'Use the built-in Microsoft PCL6 driver',
      why: 'Most office laser printers understand PCL 6, and Windows ships a generic driver for it.',
      confidence: 0.4,
      steps: [{ kind: 'command', title: 'Add printer with generic driver', explain: 'Creates a printer that uses Windows\' own PCL6 class driver.', cmd: 'powershell.exe', args: ['-NoProfile', '-Command', script], admin: true, safe: true }],
    }),
  );
  return { status: 'broken', headline: 'Windows does not have a driver for this printer.', checks, plans, facts: { problemCode: device.problem.code } };
}

async function diagnosePrinter(device, ctx) {
  if (ctx.platform === 'win32') return diagnoseWindows(device, ctx);
  return diagnoseCups(device, ctx);
}

module.exports = { diagnosePrinter, matchCupsDevice };
