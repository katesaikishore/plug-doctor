'use strict';

/**
 * Device sources: where devices come from. USB is polled every couple of
 * seconds; screens, Bluetooth and the home network change less often and
 * some take seconds to scan, so each source has its own pace.
 *
 * @typedef {object} Source
 * @property {string} id            usb | display | bluetooth | network
 * @property {string} label         sidebar group title
 * @property {number} intervalMs    how often to refresh
 * @property {boolean} [background] refresh without making list() wait (slow scans)
 * @property {(ctx: any) => Promise<any[]>} list
 */

const usb = require('../usb');

/** @type {Source[]} */
const SOURCES = [{ id: 'usb', label: 'USB', intervalMs: 2000, list: (ctx) => usb.listDevices(ctx) }];

for (const name of ['display', 'bluetooth', 'network']) {
  try {
    SOURCES.push(require(`./${name}`).source);
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND' || !String(err.message).includes(`./${name}`)) throw err;
  }
}

/**
 * Combine several sources into one list() for the watcher.
 * @param {{ sources?: Source[], ctx?: any, isEnabled?: (id: string) => boolean, now?: () => number }} [opts]
 */
function createInventory(opts = {}) {
  const sources = opts.sources ?? SOURCES;
  const ctx = opts.ctx ?? {};
  const isEnabled = opts.isEnabled ?? (() => true);
  const now = opts.now ?? Date.now;
  const state = new Map(sources.map((s) => [s.id, { devices: [], at: null, pending: null, error: null }]));

  function refresh(source) {
    const st = state.get(source.id);
    if (st.pending) return st.pending;
    st.pending = Promise.resolve()
      .then(() => source.list(ctx))
      .then(
        (devices) => {
          st.devices = (devices ?? []).map((d) => ({ ...d, source: d.source ?? source.id }));
          st.error = null;
        },
        (err) => {
          st.error = err; // keep the last good list
        },
      )
      .finally(() => {
        st.at = now();
        st.pending = null;
      });
    return st.pending;
  }

  async function list() {
    const waits = [];
    for (const source of sources) {
      const st = state.get(source.id);
      if (!isEnabled(source.id)) {
        st.devices = [];
        continue;
      }
      if (st.at !== null && now() - st.at < source.intervalMs) continue;
      const p = refresh(source);
      // Slow sources only block the very first listing.
      if (!source.background || st.at === null) waits.push(p);
    }
    await Promise.all(waits);
    return sources.flatMap((s) => (isEnabled(s.id) ? state.get(s.id).devices : []));
  }

  return { list, sources, errors: () => Object.fromEntries([...state].map(([id, st]) => [id, st.error?.message ?? null])) };
}

module.exports = { SOURCES, createInventory };
