'use strict';

const kb = require('../kb');
const { supportFor } = require('../support');
const { check, plan } = require('./helpers');

/**
 * Keyboards, mice, game controllers and drawing tablets. Plain keyboards and
 * mice just work everywhere; controllers and tablets are where the
 * differences between operating systems show. Model knowledge (which OS
 * supports which controller, where tablet drivers live) is in the knowledge
 * base, in recipes with category "input" and a "kind" of controller or tablet.
 */

/** Xbox 360-style controllers (and the wireless receiver): vendor class 5d. */
const isXbox360 = (i) => i.class === 'ff' && i.subclass === '5d' && (i.protocol === '01' || i.protocol === '81');
/** Xbox One / Series controllers over USB (GIP): vendor class 47, protocol d0. */
const isXboxOne = (i) => i.class === 'ff' && i.subclass === '47' && i.protocol === 'd0';
const isXbox = (i) => isXbox360(i) || isXboxOne(i);

const CONTROLLER_NAME = /\b(game ?pad|game ?controller|joystick|joypad)\b/i;

/** Sidebar picture per kind (see ICONS in src/renderer/app.js). */
const KIND_ICON = { keyboard: 'keyboard', mouse: 'mouse', 'keyboard-mouse': 'keyboard', controller: 'gamepad', tablet: 'tablet' };

const KIND_LABEL = {
  keyboard: 'keyboard',
  mouse: 'mouse',
  'keyboard-mouse': 'keyboard and mouse',
  controller: 'game controller',
  tablet: 'drawing tablet',
  hid: 'input device',
};

function inputRecipes(device, ctx) {
  try {
    return kb.findForDevice(device, {}, ctx?.kbDir).filter((r) => r.category === 'input');
  } catch {
    return [];
  }
}

function matchInput(d, ctx) {
  if (!d.vendorId) return 0;
  // Above audio (85): PlayStation controllers also carry a headset audio interface.
  if (inputRecipes(d, ctx).length) return 88;
  if ((d.interfaces ?? []).some(isXbox)) return 80;
  return d.categories?.includes('input') ? 50 : 0;
}

/** keyboard, mouse, keyboard-mouse, controller, tablet or hid. */
function inputKind(device, recipes = []) {
  const fromRecipe = recipes.find((r) => KIND_LABEL[r.kind])?.kind;
  if (fromRecipe) return fromRecipe;
  const itfs = device.interfaces ?? [];
  if (itfs.some(isXbox) || CONTROLLER_NAME.test(device.productName ?? '')) return 'controller';
  const hid = itfs.filter((i) => i.class === '03');
  const keyboard = hid.some((i) => i.protocol === '01');
  const mouse = hid.some((i) => i.protocol === '02');
  return keyboard && mouse ? 'keyboard-mouse' : keyboard ? 'keyboard' : mouse ? 'mouse' : 'hid';
}

/**
 * A verdict the family decides itself, only for Xbox-style controllers with
 * no recipe of their own (third-party pads): Linux (xpad) and Windows drive
 * them; macOS has no driver for the Xbox 360 kind.
 */
function ownSupport(device, ctx, recipes) {
  const fromRecipe = recipes.some((r) => r.support?.[`${ctx.platform}-${ctx.arch}`] ?? r.support?.[ctx.platform]);
  const itfs = device.interfaces ?? [];
  if (fromRecipe || !itfs.some(isXbox)) return null;
  if (ctx.platform !== 'darwin') return { level: 'native' };
  if (!itfs.some(isXbox360)) return null;
  return {
    level: 'unsupported',
    note: 'macOS has no driver for wired Xbox 360-style controllers. Controllers that work on a Mac out of the box include the Xbox Wireless Controller over Bluetooth, the PlayStation DualShock 4 and DualSense, and the Nintendo Switch Pro Controller.',
  };
}

/** The steps a recipe gives for this OS, as a plan. */
function recipePlan(recipes, platform, kind) {
  const recipe = recipes.find((r) => (r.platforms?.[platform]?.steps ?? []).length);
  if (!recipe) return null;
  const tablet = kind === 'tablet';
  return plan({
    id: tablet ? 'maker-driver' : 'recipe-steps',
    title: tablet ? "Install the tablet maker's driver" : `Set up ${recipe.name}`,
    why: tablet ? 'Without it the pen works like a mouse: no pressure, tilt or shortcut buttons.' : recipe.summary,
    confidence: recipe.confidence ?? 0.7,
    steps: recipe.platforms[platform].steps,
  });
}

function okHeadline(kind, platform) {
  if (kind === 'controller') return 'Ready to play.';
  if (kind === 'tablet') return platform === 'linux' ? 'Working as a drawing tablet.' : "Works as a pointer. For pen pressure and buttons, install the maker's driver.";
  if (kind === 'hid') return 'Connected and working.';
  return `Working as a ${KIND_LABEL[kind]}.`;
}

async function diagnoseInput(device, ctx) {
  const recipes = ctx.recipes ?? [];
  const kind = inputKind(device, recipes);
  const facts = { kind: KIND_LABEL[kind], icon: KIND_ICON[kind] ?? 'input' };
  const own = ownSupport(device, ctx, recipes);
  const verdictNow = own ?? supportFor(device, { platform: ctx.platform, arch: ctx.arch, recipes });
  const checks = [];
  const plans = [];
  const withSupport = (r) => (own ? { ...r, support: own } : r);

  if (verdictNow.level === 'unsupported') {
    checks.push(check('support', 'This computer supports it', 'fail', verdictNow.note ?? 'There is no driver for it on this computer.'));
    return withSupport({
      status: 'broken',
      headline: ctx.platform === 'darwin' ? `This Mac has no driver for this ${KIND_LABEL[kind]}.` : `This computer has no driver for this ${KIND_LABEL[kind]}.`,
      checks,
      plans,
      facts,
    });
  }

  if (ctx.platform === 'win32') {
    if (device.problem) {
      checks.push(check('driver', 'Windows has a working driver', 'fail', device.problem.message));
      plans.push(
        plan({
          id: 'windows-update',
          title: 'Ask Windows to look for a driver',
          why: 'Windows Update carries drivers for Xbox controllers and most keyboards, mice and tablets.',
          confidence: 0.6,
          auto: true,
          steps: [{ kind: 'command', title: 'Re-scan devices', explain: 'Asks Windows to re-detect hardware and fetch a driver.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true }],
        }),
      );
      return withSupport({ status: 'broken', headline: `Windows has a problem with this ${KIND_LABEL[kind]}.`, checks, plans, facts: { ...facts, problemCode: device.problem.code } });
    }
  } else if (ctx.platform === 'linux') {
    const xbox = device.interfaces.filter(isXbox);
    if (xbox.length && !xbox.some((i) => i.driver)) {
      checks.push(check('driver', 'Controller driver attached', 'fail', "Linux's built-in Xbox controller driver (xpad) did not attach."));
      plans.push(
        plan({
          id: 'load-xpad',
          title: 'Load the Xbox controller driver',
          why: 'Linux has a built-in driver for Xbox-style controllers (xpad); it just was not loaded.',
          confidence: 0.7,
          auto: true,
          steps: [{ kind: 'command', title: 'Load xpad', explain: 'Loads the kernel driver for Xbox-style controllers.', cmd: 'modprobe', args: ['xpad'], admin: true, safe: true }],
        }),
      );
      return withSupport({ status: 'broken', headline: 'The controller driver is not loaded.', checks, plans, facts });
    }
    if (device.driver?.bound === false) {
      return withSupport({ status: 'broken', headline: `No driver is handling this ${KIND_LABEL[kind]}.`, checks, plans, facts });
    }
  } else if (ctx.platform === 'darwin') {
    if (device.driver?.bound === false) {
      const p = recipePlan(recipes, 'darwin', kind);
      if (p && kind === 'controller') {
        checks.push(check('driver', 'macOS is using it', 'warn', 'macOS did not attach a driver to it over the cable.'));
        plans.push(p);
        return withSupport({ status: 'needs-fix', headline: 'macOS supports this controller, but it needs to be connected the way macOS expects.', checks, plans, facts });
      }
      return withSupport({ status: 'broken', headline: `macOS did not attach a driver to this ${KIND_LABEL[kind]}.`, checks, plans, facts });
    }
  }

  if (device.driver?.bound == null && !device.problem && ctx.platform !== 'win32') {
    return withSupport({ status: 'unknown', headline: 'Connected. Plug Doctor could not see which driver handles it.', checks, plans, facts });
  }

  if (kind === 'tablet' && ctx.platform !== 'linux') {
    const p = recipePlan(recipes, ctx.platform, kind);
    if (p) plans.push(p);
  }
  if (kind === 'controller') {
    checks.push(check('controller', 'Games can see it', 'pass', ctx.platform === 'linux' ? 'It shows up as a standard Linux game controller.' : 'The operating system drives it; games and Steam can use it.'));
  }
  return withSupport({ status: 'ok', headline: okHeadline(kind, ctx.platform), checks, plans, facts });
}

/** @type {import('./index').Family} */
const family = {
  id: 'input',
  label: 'Input device',
  icon: 'input',
  sources: ['usb'],
  match: matchInput,
  diagnose: diagnoseInput,
};

module.exports = { family, diagnoseInput, inputKind, isXbox360, isXboxOne };
