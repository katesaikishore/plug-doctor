'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDemo, shSplit, unwrapOsascript } = require('../src/core/demo');
const { elevate } = require('../src/core/fix/elevate');
const { diagnose } = require('../src/core/diagnose');
const { runPlan } = require('../src/core/fix/runner');

test('the demo unwraps the macOS administrator prompt exactly', () => {
  const args = ['-p', "Brother's HL", '-E', '-v', 'usb://Brother/HL-L2350DW%20series?serial=E7', '-m', 'drv:///a b.ppd'];
  const { args: wrapped } = elevate('lpadmin', args, 'darwin');
  assert.deepEqual(unwrapOsascript(wrapped), ['lpadmin', ...args]);
  assert.deepEqual(shSplit("a 'b c' d\\ e"), ['a', 'b c', 'd e']);
});

test('the demo shows devices from every source and fixes the Brother printer', async () => {
  const demo = createDemo();
  const devices = await demo.list();
  const sources = new Set(devices.map((d) => d.source));
  assert.deepEqual([...sources].sort(), ['bluetooth', 'display', 'network', 'usb']);

  const byName = (re) => devices.find((d) => re.test(d.displayName));
  const tv = await diagnose(byName(/Samsung/), demo.ctx);
  assert.equal(tv.category, 'display');
  assert.ok(tv.checks.some((c) => c.id === 'refresh' && c.status === 'warn'), '4K at 30 Hz is flagged');

  const brother = await diagnose(byName(/HL-L2350DW/), demo.ctx);
  assert.equal(brother.status, 'needs-fix');
  assert.equal(brother.support.level, 'app');
  const outcome = await runPlan(brother.plans[0], demo.ctx);
  assert.equal(outcome.ok, true);
  assert.equal((await diagnose(byName(/HL-L2350DW/), demo.ctx)).status, 'ok');

  const phone = await diagnose(byName(/Pixel/), demo.ctx);
  assert.equal(phone.category, 'phone');
  assert.equal(phone.support.level, 'app');

  const pods = await diagnose(byName(/AirPods/), demo.ctx);
  assert.equal(pods.category, 'bluetooth');
  const keyboard = await diagnose(byName(/Magic Keyboard/), demo.ctx);
  assert.equal(keyboard.status, 'idle');

  const netPrinter = await diagnose(byName(/M404n/), demo.ctx);
  assert.equal(netPrinter.status, 'needs-fix');
  assert.ok(netPrinter.plans[0].steps.some((s) => s.cmd === 'lpadmin' && s.args.includes('everywhere')));
});
