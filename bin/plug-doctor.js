#!/usr/bin/env node
'use strict';

/**
 * Command-line front end to the same engine the app uses. Handy for
 * headless machines, for bug reports, and for contributors.
 *
 *   plug-doctor list
 *   plug-doctor diagnose [name-or-id]
 *   plug-doctor fix <name-or-id> [plan-number]
 *   plug-doctor report <name-or-id>
 *   plug-doctor watch
 *
 * Flags: --demo (simulated Mac, nothing real touched), --no-network, --help
 */

const readline = require('node:readline/promises');
const { createInventory } = require('../src/core/sources');
const { DeviceWatcher } = require('../src/core/usb/watcher');
const { diagnose: diagnoseDevice } = require('../src/core/diagnose');
const { runPlan, describe } = require('../src/core/fix/runner');
const { createDemo } = require('../src/core/demo');
const report = require('../src/core/report');

const ICON = { pass: '✔', warn: '!', fail: '✘', info: '·', ok: '✔', 'needs-fix': '!', broken: '✘', unknown: '?', idle: '·' };

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const demo = flags.has('--demo') ? createDemo() : null;
// Demo mode runs the same sources and families against a simulated Mac.
const inventory = demo
  ? { list: demo.list }
  : createInventory({ isEnabled: (id) => id !== 'network' || !flags.has('--no-network') });
const listDevices = () => inventory.list();
const diagnose = (d) => diagnoseDevice(d, demo ? demo.ctx : undefined);

const USAGE = `Plug Doctor, command line

  plug-doctor list                  show what is connected
  plug-doctor diagnose [name]       check everything, or devices whose name matches
  plug-doctor fix <name> [plan#]    check a device, then apply a fix after you confirm
  plug-doctor report <name>         a report you can paste into a GitHub issue
  plug-doctor watch                 keep watching while you plug things in

Names can be part of the device name ("brother") or its USB ID ("04f9:0042").

Options:
  --demo          use a simulated Mac with sample devices (nothing real is touched)
  --no-network    skip the home-network scan, which takes a few seconds
  --help          show this message
`;

function label(d) {
  const where = d.vendorId ? `${d.vendorId}:${d.productId}` : d.source;
  return `${where.padEnd(9)}  ${d.displayName}  [${(d.categories ?? []).join(', ')}]`;
}

async function pick(query) {
  const devices = await listDevices();
  if (!query) return devices;
  const q = query.toLowerCase();
  return devices.filter((d) => d.id.toLowerCase().includes(q) || `${d.vendorId}:${d.productId}` === q || (d.displayName ?? '').toLowerCase().includes(q));
}

function printDiagnosis(r) {
  console.log(`\n${ICON[r.status]} ${r.title}  (${r.categoryLabel ?? r.category})`);
  console.log(`  ${r.headline}`);
  if (r.support) console.log(`  Support: ${r.support.label}${r.support.note ? ' - ' + r.support.note : ''}`);
  for (const c of r.checks) console.log(`   ${ICON[c.status]} ${c.label}${c.detail ? ' - ' + c.detail : ''}`);
  r.plans.forEach((p, i) => {
    console.log(`  Fix ${i + 1}: ${p.title}  (confidence ${Math.round(p.confidence * 100)}%)`);
    console.log(`     ${p.why}`);
    for (const s of p.steps) console.log(`       - ${describe(s)}`);
  });
  for (const rec of r.recipes) if (rec.notes) console.log(`  Note (${rec.name}): ${rec.notes}`);
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const [cmd = 'list', target, extra] = argv.filter((a) => !a.startsWith('--'));
  if (cmd === 'list') {
    const devices = await listDevices();
    if (devices.length === 0) console.log('No devices found. Plug something in, or try the simulated Mac with: npm run cli -- list --demo');
    for (const d of devices) console.log(label(d));
    return 0;
  }
  if (cmd === 'diagnose') {
    const devices = await pick(target);
    if (devices.length === 0) console.log('No matching devices. Run "plug-doctor list" to see names.');
    for (const d of devices) printDiagnosis(await diagnose(d));
    return 0;
  }
  if (cmd === 'report') {
    if (!target) return console.error('Name a device, for example: plug-doctor report brother'), 1;
    const [d] = await pick(target);
    if (!d) return console.error('No matching device.'), 1;
    const r = await diagnose(d);
    console.log(report.buildMarkdown(d, r, await report.rawDescriptors(d, demo ? demo.ctx : {})));
    console.log(`\nShare it: ${report.issueUrl(d)}`);
    return 0;
  }
  if (cmd === 'fix') {
    if (!target) return console.error('Name a device, for example: plug-doctor fix brother'), 1;
    const [d] = await pick(target);
    if (!d) return console.error('No matching device.'), 1;
    const r = await diagnose(d);
    printDiagnosis(r);
    const chosen = r.plans[(Number(extra) || 1) - 1];
    if (!chosen) return console.log('\nNothing to fix.'), 0;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nApply "${chosen.title}"? [y/N] `);
    if (!/^y/i.test(answer)) return rl.close(), 0;
    const outcome = await runPlan(chosen, {
      ...(demo ? demo.ctx : {}),
      onManual: async () => /^y/i.test(await rl.question('  Done? [y/N] ')),
      onProgress: async (e) => {
        if (e.type === 'step-start') console.log(`→ ${e.step.title}: ${describe(e.step)}`);
        if (e.type === 'step-done') console.log('  done');
        if (e.type === 'step-manual') console.log(`→ YOU: ${e.step.title}. ${e.step.explain}${e.step.url ? ' ' + e.step.url : ''}`);
        if (e.type === 'step-failed') console.log(`  failed: ${e.result.error ?? e.result.stderr.trim()}`);
      },
    });
    rl.close();
    console.log(outcome.ok ? '\nFixed. Run "plug-doctor diagnose" to confirm.' : '\nThe fix did not finish.');
    return outcome.ok ? 0 : 1;
  }
  if (cmd === 'watch') {
    const w = new DeviceWatcher({ list: listDevices });
    w.on('attach', async (d) => {
      console.log(`+ ${label(d)}`);
      printDiagnosis(await diagnose(d));
    });
    w.on('detach', (d) => console.log(`- ${label(d)}`));
    await w.start({ silentInitial: true });
    console.log('Watching for devices. Plug something in (Ctrl+C to stop).');
    return new Promise(() => {});
  }
  console.log(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
