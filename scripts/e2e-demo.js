'use strict';

/**
 * End-to-end check: launches the real Electron app in demo mode and checks
 * what a person sees and does. Needs Playwright, which is not a dependency of
 * the app:
 *
 *   npm install --no-save playwright
 *   npm run e2e                                  # from the source tree
 *   PLUG_DOCTOR_EXE=dist/linux-unpacked/plug-doctor npm run e2e   # a packaged build
 *
 * On Linux without a screen, wrap it in xvfb-run. Screenshots go to
 * PLUG_DOCTOR_E2E_OUT (default: a folder in the system temp directory).
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.PLUG_DOCTOR_E2E_OUT || path.join(os.tmpdir(), 'plug-doctor-e2e');
const PACKAGED = process.env.PLUG_DOCTOR_EXE;

let electron;
try {
  ({ _electron: electron } = require('playwright'));
} catch {
  console.error('Playwright is needed for the end-to-end check: npm install --no-save playwright');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
};

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const launch = PACKAGED
    ? { executablePath: path.resolve(PACKAGED), args: ['--demo', '--no-sandbox'] }
    : {
        executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'),
        args: [ROOT, '--demo', '--no-sandbox'],
      };
  const app = await electron.launch({ ...launch, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const errors = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
    win.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await win.setViewportSize({ width: 1180, height: 800 });
    await win.waitForSelector('.device-item', { timeout: 60000 });
    await win.waitForTimeout(4000);

    const groups = await win.$$eval('.group-title', (els) => els.map((e) => e.textContent));
    const count = await win.$$eval('.device-item', (els) => els.length);
    check('sidebar lists devices from several sources', count >= 8, `${count} devices`);
    check('sidebar is grouped by source', ['USB', 'Screens', 'Bluetooth', 'On your network'].every((g) => groups.includes(g)), groups.join(' | '));

    const names = await win.$$eval('.device-item .device-name', (els) => els.map((e) => e.textContent));
    const stuck = [];
    for (const [i, n] of names.entries()) {
      await win.locator('.device-item').nth(i).click();
      await win.waitForTimeout(300);
      const headline = (await win.textContent('.headline').catch(() => '')) || '';
      if (!headline || /Checking this device/.test(headline)) stuck.push(n);
      await win.screenshot({ path: path.join(OUT, `device-${i}.png`) });
    }
    check('every device gets a verdict', stuck.length === 0, stuck.join(', ') || 'all have one');

    await win.click('.device-item:has-text("HL-L2350DW")');
    await win.waitForTimeout(400);
    check('printer shows a recommended plan', (await win.$('.plan.recommended')) !== null);
    await win.click('.plan.recommended >> text=Make it work');
    await win.waitForSelector('.pill.ok', { timeout: 60000 });
    check('printer fix ends in Working', true);

    await win.click('.device-item:has-text("LaserJet 1020")');
    await win.waitForTimeout(400);
    const detail = (await win.textContent('#detail').catch(() => '')) || '';
    check('printer with no automatic fix offers the assistant', /No automatic fix yet/.test(detail) && (await win.$('text=Ask the assistant')) !== null);

    await win.click('.device-item:has-text("Pixel")');
    await win.waitForTimeout(400);
    await win.click('.plan.recommended >> text=Make it work');
    await win.waitForSelector('.your-turn', { timeout: 60000 });
    check('a manual step waits for the person', true);
    await win.click('.your-turn >> text=Stop');
    await win.waitForTimeout(800);
    check('stopping a manual step ends the wait', (await win.$('.your-turn')) === null);

    await win.click('.tab >> text=Assistant');
    await win.waitForTimeout(300);
    const assistant = (await win.textContent('#detail').catch(() => '')) || '';
    check('assistant without a key says what to do next', /Add API key|Connect the assistant|turned off/.test(assistant));

    await win.click('.tab >> text=Under the hood');
    await win.waitForSelector('pre.report', { timeout: 30000 }).catch(() => {});
    check('Under the hood report renders', (await win.$('pre.report')) !== null);

    await win.click('#open-settings');
    await win.waitForTimeout(300);
    check('settings dialog opens', await win.isVisible('#settings'));
    await win.click('#settings-form >> button[value="save"]');
    await win.waitForTimeout(400);
    check('settings save closes the dialog', !(await win.isVisible('#settings')));

    // Pressing Enter in the key box must save, not cancel (regression check).
    const before = await win.evaluate(() => window.plugDoctor.getSettings());
    await win.click('#open-settings');
    await win.waitForTimeout(300);
    await win.click('#settings-form input[name="webResearch"]');
    await win.click('#settings-form input[name="apiKey"]');
    await win.keyboard.press('Enter');
    await win.waitForTimeout(500);
    const after = await win.evaluate(() => window.plugDoctor.getSettings());
    check('Enter in the key box saves the settings', after.webResearch === !before.webResearch);
    // Put the setting back so the check leaves no trace.
    await win.click('#open-settings');
    await win.waitForTimeout(300);
    await win.click('#settings-form input[name="webResearch"]');
    await win.click('#settings-form >> button[value="save"]');
    await win.waitForTimeout(400);

    // The theme button cycles to Dark, and the page really turns dark. Playwright
    // pins pages to the light scheme, so lift that and let the app's setting decide.
    await win.emulateMedia({ colorScheme: null });
    const themeBefore = (await win.evaluate(() => window.plugDoctor.getSettings())).theme;
    for (let i = 0; i < 3; i++) {
      if ((await win.evaluate(() => window.plugDoctor.getSettings())).theme === 'dark') break;
      await win.click('#theme-toggle');
      await win.waitForTimeout(400);
    }
    const background = await win.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = (background.match(/\d+/g) ?? []).map(Number);
    check('the theme button switches to dark', r + g + b < 120, background);
    await win.screenshot({ path: path.join(OUT, 'dark.png') });
    await win.evaluate((t) => window.plugDoctor.updateSettings({ theme: t }), themeBefore);
    await win.emulateMedia({ colorScheme: 'light' });
    await win.waitForTimeout(300);

    await win.setViewportSize({ width: 760, height: 520 });
    await win.waitForTimeout(400);
    const overflow = await win.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('no sideways scrolling at the window minimum (760px)', overflow <= 0, `${overflow}px over`);
    await win.screenshot({ path: path.join(OUT, 'min-760.png') });

    await win.setViewportSize({ width: 390, height: 800 });
    await win.waitForTimeout(400);
    const phone = await win.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('no sideways scrolling at phone width (390px)', phone <= 0, `${phone}px over`);

    check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await app.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${OUT}`);
  return failed;
}

run().then(
  (failed) => process.exit(failed ? 1 : 0),
  (err) => {
    console.error('End-to-end run crashed:', err);
    process.exit(2);
  },
);
