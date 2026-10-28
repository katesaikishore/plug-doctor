#!/usr/bin/env node
'use strict';

/**
 * Command-line front end to the same engine the app uses. Handy for
 * headless machines, for bug reports, and for contributors.
 *
 *   plug-doctor list
 *   plug-doctor diagnose [usb-id-or-name]
 *   plug-doctor fix <usb-id-or-name> [plan-number]
 *   plug-doctor report <usb-id-or-name>
 *   plug-doctor watch
 */

const readline = require('node:readline/promises');
const { createInventory } = require('../src/core/sources');
const { DeviceWatcher } = require('../src/core/usb/watcher');
const { diagnose } = require('../src/core/diagnose');
const { runPlan, describe } = require('../src/core/fix/runner');
const report = require('../src/core/report');

const ICON = { pass: '✔', warn: '!', fail: '✘', info: '·', ok: '✔', 'needs-fix': '!', broken: '✘', unknown: '?', idle: '·' };

// --no-network skips the home-network scan (it takes a few seconds).
const inventory = createInventory({ isEnabled: (id) => id !== 'network' || !process.argv.includes('--no-network') });
const listDevices = () => inventory.list();

function label(d) {
  const where = d.vendorId ? `${d.vendorId}:${d.productId}` : d.source;
  return `${where.padEnd(9)}  ${d.displayName}  [${(d.categories ?? []).join(', ')}]`;
}

async function pick(query) {
  const devices = await listDevices();
  if (!query) return devices;
  const q = query.toLowerCase();
  return devices.filter((d) => d.id.toLowerCase().includes(q) || `${d.vendorId}:${d.productId}` === q || label(d).toLowerCase().includes(q));
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
  const [cmd = 'list', target, extra] = argv.filter((a) => !a.startsWith('--'));
  if (cmd === 'list') {
    const devices = await listDevices();
    if (devices.length === 0) console.log('No devices found.');
    for (const d of devices) console.log(label(d));
    return 0;
  }
  if (cmd === 'diagnose') {
    const devices = await pick(target);
    if (devices.length === 0) console.log('No matching devices.');
    for (const d of devices) printDiagnosis(await diagnose(d));
    return 0;
  }
  if (cmd === 'report') {
    const [d] = await pick(target);
    if (!d) return console.error('No matching device.'), 1;
    const r = await diagnose(d);
    console.log(report.buildMarkdown(d, r, await report.rawDescriptors(d)));
    console.log(`\nShare it: ${report.issueUrl(d)}`);
    return 0;
  }
  if (cmd === 'fix') {
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
    console.log('Watching for USB devices. Plug something in (Ctrl+C to stop).');
    return new Promise(() => {});
  }
  console.log('usage: plug-doctor [list | diagnose [device] | fix <device> [plan#] | report <device> | watch] [--no-network]');
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
