'use strict';

const { run: defaultRun } = require('../exec');
const { elevate } = require('./elevate');

/**
 * Programs a fix is allowed to run. Anything else - including anything the
 * AI assistant proposes - is refused and shown to the person as a manual
 * step instead. Keep this list short and boring.
 */
const ALLOWED_PROGRAMS = new Set([
  // printing (CUPS)
  'lpadmin', 'lpoptions', 'lp', 'cupsenable', 'cupsaccept', 'cupsctl', 'lpstat', 'lpinfo',
  // packages
  'apt-get', 'dnf', 'pacman', 'zypper', 'brew',
  // linux system plumbing
  'usermod', 'systemctl', 'modprobe', 'udevadm', 'udisksctl', 'rfkill', 'bluetoothctl', 'xrandr', 'pactl',
  // windows
  'pnputil', 'powershell.exe', 'rundll32', 'explorer.exe',
  // macOS
  'open',
]);

/**
 * The assistant gets a narrower list: no script hosts (powershell, open,
 * rundll32) and nothing that removes software.
 */
const AI_ALLOWED_PROGRAMS = new Set([
  'lpadmin', 'lpoptions', 'lp', 'cupsenable', 'cupsaccept',
  'apt-get', 'dnf', 'pacman', 'zypper', 'brew',
  'usermod', 'modprobe', 'udevadm', 'pnputil',
]);

/** Commands that can remove or rewrite things get an extra warning in the UI. */
const DESTRUCTIVE = [/^(apt-get|dnf|zypper)$/, /^pacman$/];
const DESTRUCTIVE_ARGS = /\b(remove|purge|erase|autoremove|-R\w*)\b/;

/**
 * @param {any} step
 * @param {{ source?: 'builtin'|'ai' }} [opts]
 */
function validateStep(step, opts = {}) {
  if (step.kind !== 'command') return { ok: true };
  if (typeof step.cmd !== 'string' || !Array.isArray(step.args) || step.args.some((a) => typeof a !== 'string')) {
    return { ok: false, reason: 'Malformed command.' };
  }
  const allowed = opts.source === 'ai' ? AI_ALLOWED_PROGRAMS : ALLOWED_PROGRAMS;
  if (!allowed.has(step.cmd)) {
    return { ok: false, reason: `"${step.cmd}" is not on Plug Doctor's list of programs it may run.` };
  }
  if (opts.source === 'ai' && isDestructive(step)) {
    return { ok: false, reason: 'The assistant may not remove software.' };
  }
  return { ok: true };
}

function isDestructive(step) {
  return step.kind === 'command' && DESTRUCTIVE.some((re) => re.test(step.cmd)) && DESTRUCTIVE_ARGS.test(step.args.join(' '));
}

/** Human-readable one-liner for a step, shown before anything runs. */
function describe(step) {
  if (step.kind !== 'command') return step.title;
  return [step.admin ? '(as administrator)' : null, step.cmd, ...step.args].filter(Boolean).join(' ');
}

/**
 * Run a fix plan step by step. Stops at the first failing command.
 *
 * @param {{ steps: any[], source?: 'builtin'|'ai' }} plan
 * @param {object} [opts]
 * @param {NodeJS.Platform} [opts.platform]
 * @param {typeof defaultRun} [opts.run]
 * @param {(event: { type: string, index: number, step: any, result?: any }) => void} [opts.onProgress]
 * @param {(step: any, index: number) => Promise<boolean>} [opts.onManual]  resolve true when the person has done it
 * @returns {Promise<{ ok: boolean, results: any[], stoppedAt: number|null }>}
 */
async function runPlan(plan, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRun;
  const emit = opts.onProgress ?? (() => {});
  const results = [];

  for (let index = 0; index < plan.steps.length; index++) {
    const step = plan.steps[index];
    const check = validateStep(step, { source: plan.source });
    if (!check.ok) {
      const result = { ok: false, skipped: true, error: check.reason };
      results.push(result);
      emit({ type: 'step-failed', index, step, result });
      return { ok: false, results, stoppedAt: index };
    }
    if (step.kind !== 'command') {
      emit({ type: 'step-manual', index, step });
      // Manual steps (run a vendor installer, replug the device) pause the
      // plan until the person says they are done.
      const done = opts.onManual ? await opts.onManual(step, index) : true;
      results.push({ ok: done, manual: true });
      if (!done) return { ok: false, results, stoppedAt: index, cancelled: true };
      continue;
    }

    emit({ type: 'step-start', index, step });
    const { cmd, args } = step.admin ? elevate(step.cmd, step.args, platform) : step;
    const res = await run(cmd, args, { timeout: step.timeout ?? 10 * 60 * 1000 });
    const result = { ok: res.ok, code: res.code, stdout: res.stdout.slice(-8000), stderr: res.stderr.slice(-8000), missing: res.missing };
    results.push(result);
    if (!res.ok && !step.optional) {
      emit({ type: 'step-failed', index, step, result });
      return { ok: false, results, stoppedAt: index };
    }
    emit({ type: 'step-done', index, step, result });
  }
  return { ok: true, results, stoppedAt: null };
}

module.exports = { runPlan, validateStep, isDestructive, describe, ALLOWED_PROGRAMS, AI_ALLOWED_PROGRAMS };
