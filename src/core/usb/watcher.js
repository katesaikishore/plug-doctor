'use strict';

const { EventEmitter } = require('node:events');
const { listDevices } = require('./index');

/**
 * Polls the device list (USB by default, or any combined inventory from
 * src/core/sources) and emits `attach` / `detach` / `change` events.
 * Polling (instead of libusb hotplug) keeps the app free of native modules,
 * so it installs on any machine without a compiler.
 *
 * Events:
 *   attach (device)        a device appeared
 *   detach (device)        a device went away
 *   update (device)        a device's state changed (driver, problem, details)
 *   change (devices[])     the list changed in any way
 *   error  (err)
 */
const signature = (d) => JSON.stringify([d.driver ?? null, d.problem ?? null, d.details ?? null]);

class UsbWatcher extends EventEmitter {
  /** @param {{ intervalMs?: number, list?: () => Promise<any[]> }} [opts] */
  constructor(opts = {}) {
    super();
    this.intervalMs = opts.intervalMs ?? 2000;
    this.list = opts.list ?? (() => listDevices());
    this.devices = new Map();
    this.timer = null;
    this.polling = false;
    this.primed = false;
  }

  /** Start watching. Devices already plugged in are reported once as `attach` unless `silentInitial`. */
  async start({ silentInitial = false } = {}) {
    await this.poll({ silent: silentInitial });
    this.primed = true;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
    return this.snapshot();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot() {
    return [...this.devices.values()];
  }

  async poll({ silent = false } = {}) {
    if (this.polling) return;
    this.polling = true;
    try {
      const next = new Map((await this.list()).map((d) => [d.id, d]));
      let changed = false;
      for (const [id, dev] of next) {
        if (!this.devices.has(id)) {
          changed = true;
          if (!silent) this.emit('attach', dev);
        } else if (signature(this.devices.get(id)) !== signature(dev)) {
          // A driver got bound, headphones connected, a screen changed mode...
          changed = true;
          if (!silent) this.emit('update', dev);
        }
      }
      for (const [id, dev] of this.devices) {
        if (!next.has(id)) {
          changed = true;
          this.emit('detach', dev);
        }
      }
      this.devices = next;
      if (changed) this.emit('change', this.snapshot());
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.polling = false;
    }
  }
}

/** The watcher is not USB-specific any more; DeviceWatcher is the honest name. */
module.exports = { UsbWatcher, DeviceWatcher: UsbWatcher };
