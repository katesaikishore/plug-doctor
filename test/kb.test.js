'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kb = require('../src/core/kb');
const { validateStep } = require('../src/core/fix/runner');

const dir = kb.DEFAULT_DIR;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const MANAGERS = new Set(['apt', 'dnf', 'pacman', 'zypper', 'brew']);
const PLATFORMS = new Set(['linux', 'darwin', 'win32']);
const STEP_KINDS = new Set(['command', 'manual', 'open-url']);

// Every community recipe is checked here, so a bad pull request fails CI
// instead of breaking someone's printer.
for (const file of files) {
  test(`knowledge/${file} is a valid recipe`, () => {
    const e = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.equal(`${e.id}.json`, file, 'file name must be <id>.json');
    for (const key of ['id', 'name', 'summary', 'match', 'platforms']) assert.ok(e[key], `missing "${key}"`);
    for (const id of e.match.usb ?? []) assert.match(id, /^[0-9a-f]{4}:[0-9a-f]{4}$/, 'USB IDs are lowercase vvvv:pppp');
    for (const v of e.match.vendors ?? []) assert.match(v, /^[0-9a-f]{4}$/);
    assert.ok((e.match.usb ?? []).length + (e.match.models ?? []).length + (e.match.vendors ?? []).length > 0, 'must match something');
    if (e.confidence != null) assert.ok(e.confidence > 0 && e.confidence <= 1);
    for (const [platform, plan] of Object.entries(e.platforms)) {
      assert.ok(PLATFORMS.has(platform), `unknown platform ${platform}`);
      for (const m of Object.keys(plan.packages ?? {})) assert.ok(MANAGERS.has(m), `unknown package manager ${m}`);
      for (const step of plan.steps ?? []) {
        assert.ok(STEP_KINDS.has(step.kind), `unknown step kind ${step.kind}`);
        assert.ok(step.title && step.explain, 'steps need a title and an explanation');
        assert.ok(validateStep(step).ok, `step "${step.title}" runs a program that is not allowed`);
        if (step.kind === 'open-url') assert.match(step.url, /^https:\/\//);
      }
    }
    for (const s of e.sources ?? []) assert.match(s, /^https?:\/\//);
  });
}

test('lookup by USB ID beats vendor-wide entries', () => {
  const hits = kb.findForDevice({ vendorId: '03f0', productId: '2b17' });
  assert.deepEqual(hits.map((h) => h.id), ['hp-laserjet-hostbased']);
  assert.deepEqual(kb.findForDevice({ vendorId: '03f0', productId: '9999' }).map((h) => h.id), ['hp-printers']);
});

test('search finds recipes by words', () => {
  assert.equal(kb.search('brltty ubuntu')[0].id, 'ch340-serial');
  assert.deepEqual(kb.search(''), []);
});
