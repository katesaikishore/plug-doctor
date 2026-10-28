'use strict';

/**
 * Pick a driver for a USB printer. This is the reasoning that turned an
 * "unsupported" printer into a working one by hand, written down:
 *
 *   1. A community recipe for this exact model wins.
 *   2. A printer that speaks IPP-over-USB needs no driver at all.
 *   3. A driver already installed for this exact model.
 *   4. Otherwise, the printer's IEEE 1284 command set tells us which
 *      *generic* driver will work: PostScript, PCL 6, PCL 5, ESC/P.
 *   5. Host-based printers (no page language) need model-specific
 *      software; we say so honestly and hand over to the knowledge base
 *      or the assistant.
 */

const STOPWORDS = new Set(['hp', 'hewlett', 'packard', 'inc', 'co', 'ltd', 'printer', 'series', 'the', 'usb', 'foomatic', 'cups', 'driver', 'en']);

function tokens(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t));
}

/**
 * Best installed model (PPD) for a printer model name, or null.
 * Every significant token of the printer's model must appear in the PPD's
 * make-and-model, so "1020" never matches "10200".
 * @param {string} printerModel
 * @param {Array<{ name: string, makeAndModel: string }>} models
 */
function findExactModel(printerModel, models) {
  const want = tokens(printerModel);
  if (want.length === 0) return null;
  let best = null;
  for (const m of models) {
    const have = new Set(tokens(m.makeAndModel));
    if (!want.every((t) => have.has(t))) continue;
    let score = 10 - Math.max(0, have.size - want.length); // fewer extra words = closer match
    if (/recommended/i.test(m.makeAndModel)) score += 5;
    if (/hpcups/i.test(m.name + m.makeAndModel)) score += 3;
    if (/gutenprint/i.test(m.makeAndModel)) score += 1;
    if (!best || score > best.score) best = { ...m, score };
  }
  return best;
}

const GENERIC_PATTERNS = {
  postscript: [/generic.*postscript/i, /postscript.*generic/i],
  pclxl: [/generic.*pcl ?6/i, /generic.*pcl ?xl/i, /pxlmono/i, /pxlcolor/i],
  pcl: [/generic.*pcl ?5/i, /laserjet series pcl/i, /generic.*pcl/i],
  escp: [/epson.*esc\/p/i, /generic.*esc\/p/i],
};

function findGeneric(family, models) {
  for (const re of GENERIC_PATTERNS[family] ?? []) {
    const hit = models.find((m) => re.test(m.makeAndModel) || re.test(m.name));
    if (hit) return hit;
  }
  return null;
}

const LANGUAGE_LABELS = {
  postscript: 'PostScript',
  pclxl: 'PCL 6 (PCL XL)',
  pcl: 'PCL 5',
  escp: 'Epson ESC/P',
  driverless: 'AirPrint / IPP Everywhere raster',
  hostbased: 'a host-based (GDI) stream',
  label: 'a label/receipt printer language',
};

/**
 * @param {object} input
 * @param {{ model: string|null, languages: string[], commandSet: string[] } | null} input.deviceId  parsed IEEE 1284 ID
 * @param {Array<{ name: string, makeAndModel: string }>} input.models  installed drivers (`lpinfo -m`)
 * @param {Array<{ class: string|null, subclass: string|null, protocol: string|null }>} [input.interfaces]
 * @param {object[]} [input.recipes]  knowledge base entries for this device
 * @param {NodeJS.Platform} input.platform
 * @returns {Array<{ id: string, label: string, confidence: number, model?: string, why: string, packages?: object, recipe?: object }>}
 */
function chooseDriver({ deviceId, models = [], interfaces = [], recipes = [], platform }) {
  const out = [];
  const model = deviceId?.model ?? null;
  const languages = deviceId?.languages ?? [];

  const exact = model ? findExactModel(model, models) : null;

  for (const recipe of recipes) {
    const plan = recipe.platforms?.[platform];
    if (!plan || (!plan.ppd && !plan.packages && !plan.steps?.length)) continue; // notes only
    // A recipe that only installs software is moot once a driver for the exact model is installed.
    if (!plan.ppd && exact) continue;
    const ppd = plan.ppd ? models.find((m) => m.name === plan.ppd || (plan.ppdMatch && new RegExp(plan.ppdMatch, 'i').test(m.makeAndModel))) : null;
    const base = recipe.confidence ?? 0.95;
    out.push({
      id: 'recipe',
      label: `Known recipe: ${recipe.name}`,
      confidence: plan.ppd && !ppd ? base - 0.15 : base,
      model: ppd?.name ?? plan.ppd ?? undefined,
      why: recipe.summary,
      packages: plan.packages,
      recipe,
    });
  }

  const ippUsb = interfaces.some((i) => i.class === '07' && i.protocol === '04');
  if (ippUsb) {
    out.push({
      id: 'ipp-usb',
      label: 'Driverless printing (IPP over USB)',
      confidence: 0.85,
      why: 'The printer exposes an IPP-over-USB interface, so it can describe itself and print without any vendor driver.',
      packages: platform === 'linux' ? { apt: ['ipp-usb'], dnf: ['ipp-usb'], pacman: ['ipp-usb'], zypper: ['ipp-usb'] } : undefined,
    });
  }

  if (exact) {
    out.push({
      id: 'exact',
      label: `Installed driver for ${model}`,
      confidence: 0.9,
      model: exact.name,
      why: `A driver made for this model is already installed: ${exact.makeAndModel}.`,
    });
  }

  for (const family of languages) {
    if (family === 'hostbased' || family === 'label' || family === 'driverless') continue;
    const generic = findGeneric(family, models);
    if (!generic) continue;
    out.push({
      id: `generic-${family}`,
      label: `Generic ${LANGUAGE_LABELS[family]} driver`,
      confidence: { postscript: 0.75, pclxl: 0.7, pcl: 0.65, escp: 0.55 }[family],
      model: generic.name,
      why: `The printer says it understands ${LANGUAGE_LABELS[family]} (command set: ${deviceId.commandSet.join(', ')}), so the generic driver "${generic.makeAndModel}" can drive it even without a vendor driver.`,
    });
  }

  if (out.length === 0) {
    const hostbased = languages.includes('hostbased');
    out.push({
      id: hostbased ? 'hostbased' : 'unknown',
      label: hostbased ? 'Model-specific driver needed' : 'No driver found yet',
      confidence: hostbased ? 0.2 : 0.1,
      why: hostbased
        ? `This printer only accepts ${LANGUAGE_LABELS.hostbased} (command set: ${deviceId.commandSet.join(', ')}). Generic drivers cannot drive it; it needs a model-specific open-source driver such as foo2zjs, splix or HPLIP. Check the knowledge base or ask the assistant.`
        : 'The printer did not report a page language we recognize and no installed driver matches its name. Ask the assistant to research it.',
    });
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}

module.exports = { chooseDriver, findExactModel, findGeneric, tokens, LANGUAGE_LABELS };
