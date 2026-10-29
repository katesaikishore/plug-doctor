'use strict';

/**
 * Screenshots for the README, in light and dark: launches the app in demo mode
 * (simulated devices, nothing real is touched) and saves one picture per scene.
 * The theme is switched for this run only; saved settings are not changed.
 *
 *   npm install --no-save playwright
 *   xvfb-run -a node scripts/screenshots.js [output folder]    # default: docs/screenshots
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'screenshots'));

let electron;
try {
  ({ _electron: electron } = require('playwright'));
} catch {
  console.error('Playwright is needed for screenshots: npm install --no-save playwright');
  process.exit(2);
}

/** Scene name, the device to open (by name), and what to do before the picture. */
const SCENES = [
  { name: 'tv', device: /Samsung TV/ },
  { name: 'fix-plan', device: /HL-L2350DW/ },
  { name: 'phone', device: /Pixel/ },
  { name: 'drive', device: /SanDisk/ },
  { name: 'unsupported', device: /Microsoft Controller/ },
  { name: 'network-printer', device: /M404n/ },
  { name: 'fixed', device: /HL-L2350DW/, run: true },
];

async function open(win, pattern) {
  for (const item of await win.$$('.device-item')) {
    if (pattern.test((await item.textContent()) || '')) {
      await item.click();
      await win.waitForTimeout(500);
      await win.evaluate(() => document.querySelector('#detail')?.scrollTo({ top: 0 }));
      return true;
    }
  }
  return false;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const app = await electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'),
    args: [ROOT, '--demo', '--no-sandbox'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1240, height: 800 }));
    await win.waitForSelector('.device-item', { timeout: 60000 });
    await win.waitForTimeout(3000);
    const setTheme = async (theme) => {
      await app.evaluate(({ nativeTheme }, t) => {
        nativeTheme.themeSource = t;
      }, theme);
      // Playwright pins pages to the light scheme; lift that so the app's own theme setting decides.
      await win.emulateMedia({ colorScheme: null });
      await win.waitForTimeout(600);
    };
    const save = async (name, theme) => {
      const file = path.join(OUT, theme === 'light' ? `${name}.png` : `${name}-dark.png`);
      await win.screenshot({ path: file });
      console.log(`saved ${path.relative(ROOT, file)}`);
    };

    // Every scene before the fix, in both themes; the fix changes the printer for the rest of the run.
    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      for (const scene of SCENES.filter((x) => !x.run)) {
        if (await open(win, scene.device)) await save(scene.name, theme);
      }
    }
    for (const scene of SCENES.filter((x) => x.run)) {
      if (!(await open(win, scene.device))) continue;
      if (await win.$('.plan.recommended >> text=Make it work')) {
        await win.click('.plan.recommended >> text=Make it work');
        await win.waitForSelector('.pill.ok', { timeout: 60000 }).catch(() => {});
        await win.waitForTimeout(600);
      }
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        await win.evaluate(() => document.querySelector('#detail')?.scrollTo({ top: 0 }));
        await save(scene.name, theme);
      }
    }
  } finally {
    await app.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
