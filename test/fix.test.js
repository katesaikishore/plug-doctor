'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { elevate, shQuote, winQuote } = require('../src/core/fix/elevate');
const { runPlan, validateStep } = require('../src/core/fix/runner');
const { installStep } = require('../src/core/fix/packages');
const { fakeRun } = require('./helpers');

test('shQuote survives a round trip through sh', { skip: process.platform === 'win32' }, () => {
  const nasty = ["it's", 'a "b"', '$HOME', '`id`', 'semi;colon', 'usb://HP/LaserJet%201020?serial=X'];
  const out = execFileSync('sh', ['-c', `printf '%s\\n' ${nasty.map(shQuote).join(' ')}`], { encoding: 'utf8' });
  assert.deepEqual(out.trimEnd().split('\n'), nasty);
});

test('elevation wraps commands per platform', () => {
  assert.deepEqual(elevate('lpadmin', ['-p', 'Q'], 'linux'), { cmd: 'pkexec', args: ['lpadmin', '-p', 'Q'] });
  const mac = elevate('lpadmin', ['-p', 'My "Q"'], 'darwin');
  assert.equal(mac.cmd, 'osascript');
  assert.equal(mac.args[1], `do shell script "lpadmin -p 'My \\"Q\\"'" with administrator privileges`);
  const win = elevate('pnputil', ['/scan-devices'], 'win32');
  assert.match(win.args.at(-1), /Start-Process -FilePath 'pnputil' -Verb RunAs/);
});

test('winQuote follows CommandLineToArgvW rules', () => {
  assert.equal(winQuote('plain'), 'plain');
  assert.equal(winQuote('two words'), '"two words"');
  assert.equal(winQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(winQuote('C:\\dir\\'), 'C:\\dir\\');
  assert.equal(winQuote('C:\\my dir\\'), '"C:\\my dir\\\\"');
});

test('only allow-listed programs run; the assistant gets fewer', () => {
  assert.ok(validateStep({ kind: 'command', cmd: 'lpadmin', args: [] }).ok);
  assert.ok(!validateStep({ kind: 'command', cmd: 'rm', args: ['-rf', '/'] }).ok);
  assert.ok(validateStep({ kind: 'command', cmd: 'powershell.exe', args: [] }).ok);
  assert.ok(!validateStep({ kind: 'command', cmd: 'powershell.exe', args: [] }, { source: 'ai' }).ok);
  assert.ok(!validateStep({ kind: 'command', cmd: 'apt-get', args: ['remove', 'cups'] }, { source: 'ai' }).ok);
  assert.ok(validateStep({ kind: 'command', cmd: 'apt-get', args: ['install', '-y', 'hplip'] }, { source: 'ai' }).ok);
  assert.ok(!validateStep({ kind: 'command', cmd: 'lp', args: [42] }).ok);
});

test('runPlan elevates admin steps, skips past optional failures, stops on real ones', async () => {
  const run = fakeRun([
    [/^pkexec lpadmin/, ''],
    [/^lpoptions/, { ok: false, code: 1, stderr: 'nope' }],
    [/^lp /, { ok: false, code: 1, stderr: 'printer on fire' }],
  ]);
  const events = [];
  const outcome = await runPlan(
    {
      steps: [
        { kind: 'command', title: 'add', cmd: 'lpadmin', args: ['-p', 'Q'], admin: true },
        { kind: 'command', title: 'default', cmd: 'lpoptions', args: ['-d', 'Q'], optional: true },
        { kind: 'manual', title: 'replug' },
        { kind: 'command', title: 'test', cmd: 'lp', args: ['-d', 'Q', 'f'] },
        { kind: 'command', title: 'never', cmd: 'lp', args: [] },
      ],
    },
    { platform: 'linux', run, onProgress: (e) => events.push(`${e.type}:${e.index}`) },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stoppedAt, 3);
  assert.deepEqual(run.calls, ['pkexec lpadmin -p Q', 'lpoptions -d Q', 'lp -d Q f']);
  assert.deepEqual(events, ['step-start:0', 'step-done:0', 'step-start:1', 'step-done:1', 'step-manual:2', 'step-start:3', 'step-failed:3']);
});

test('install steps adapt to the package manager, or become manual', () => {
  const apt = { id: 'apt', install: (p) => ['apt-get', ['install', '-y', ...p]] };
  assert.deepEqual(installStep({ apt: ['hplip'] }, apt).args, ['install', '-y', 'hplip']);
  assert.equal(installStep({ dnf: ['hplip'] }, apt).kind, 'manual');
  assert.equal(installStep({ apt: ['hplip'] }, null).kind, 'manual');
});

test('the assistant may not remove software with any package manager', () => {
  const ai = (cmd, args) => validateStep({ kind: 'command', cmd, args }, { source: 'ai' });
  assert.equal(ai('apt-get', ['remove', 'cups']).ok, false);
  assert.equal(ai('apt-get', ['purge', 'cups']).ok, false);
  assert.equal(ai('dnf', ['remove', 'cups']).ok, false);
  assert.equal(ai('zypper', ['remove', 'cups']).ok, false);
  assert.equal(ai('pacman', ['-R', 'cups']).ok, false);
  assert.equal(ai('pacman', ['-Rns', 'cups']).ok, false);
  assert.equal(ai('pacman', ['-S', 'cups']).ok, true, 'installing is allowed');
  assert.equal(ai('apt-get', ['install', '-y', 'hplip']).ok, true, 'installing is allowed');
  assert.equal(ai('brew', ['uninstall', 'cups']).ok, false);
  assert.equal(ai('brew', ['install', 'hplip']).ok, true);
  assert.equal(ai('zypper', ['rm', 'cups']).ok, false);
  assert.equal(ai('apt-get', ['--allow-remove-essential', 'install', 'cups']).ok, false);
});

test('the assistant may only use its own program arguments', () => {
  const ai = (cmd, args) => validateStep({ kind: 'command', cmd, args }, { source: 'ai' });
  assert.equal(ai('lpadmin', ['-x', 'HP_LaserJet_1020']).ok, false, 'deleting a print queue');
  assert.equal(ai('lpadmin', ['-p', 'HP_LaserJet_1020', '-E', '-v', 'usb://x', '-m', 'drv']).ok, true);
  assert.equal(ai('usermod', ['-aG', 'sudo', 'kate']).ok, false, 'not a group the fixes need');
  assert.equal(ai('usermod', ['-aG', 'dialout', 'kate']).ok, true);
  assert.equal(ai('pnputil', ['/delete-driver', 'oem1.inf']).ok, false);
  assert.equal(ai('pnputil', ['/scan-devices']).ok, true);
  assert.equal(ai('udevadm', ['control', '--reload-rules']).ok, true);
});
