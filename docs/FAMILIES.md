# Writing a device family

A *family* is a plug-in that knows one kind of device: how to recognize it, what to check and how to fix it. Printers, serial adapters and drives are families. So are screens, Bluetooth devices, phones and smart TVs.

## Where devices come from: sources

| Source | File | Finds |
| --- | --- | --- |
| `usb` | `src/core/usb/` | anything on the USB bus |
| `display` | `src/core/sources/display.js` | monitors and TVs on HDMI / DisplayPort / USB-C |
| `bluetooth` | `src/core/sources/bluetooth.js` | the Bluetooth controller and paired devices |
| `network` | `src/core/sources/network.js` | smart TVs, AirPlay and Chromecast receivers, network printers and scanners (mDNS + SSDP) |

A source module exports:

```js
/** @type {import('./index').Source} */
const source = {
  id: 'display',
  label: 'Screens',          // sidebar group title
  intervalMs: 5000,          // how often to refresh
  background: false,         // true for slow scans: refresh without blocking the UI
  list: async (ctx) => [...] // ctx.run and ctx.platform are injected, so tests can fake them
};
module.exports = { source, /* parsers, for tests */ };
```

`src/core/sources/index.js` picks it up automatically.

## The device shape

Every source returns devices in this shape. USB devices also carry `vendorId`, `productId`, `deviceClass` and `interfaces`.

```js
{
  id: 'display:SAM-7279-HCJW600123',  // stable across refreshes; prefix with the source
  source: 'display',
  vendorName: 'Samsung', productName: 'LU28R55', displayName: 'Samsung LU28R55',
  serial: null,
  categories: ['display'],            // hints for match()
  interfaces: [], nodes: [],          // USB only; empty arrays elsewhere
  driver: { bound: null, names: [], unboundInterfaces: [] },  // null = not applicable
  problem: null,                      // or { code, message } when the OS reports an error
  details: { ... },                   // source-specific facts the family reads
  raw: { ... },                       // shown in "Under the hood"
}
```

## The family contract

```js
/** @type {import('./index').Family} */
const family = {
  id: 'display',           // also the `category` knowledge base recipes use
  label: 'Screen',
  icon: 'display',         // see ICONS in src/renderer/app.js
  sources: ['display'],
  match: (device, ctx) => 0..100,          // 0 = not mine; highest score wins
  userspace: (platform, device) => bool,   // optional: "no kernel driver" is normal
  diagnose: async (device, ctx) => ({
    status: 'ok' | 'needs-fix' | 'broken' | 'unknown',
    headline: 'One plain sentence about the state of the device.',
    checks: [check(id, label, 'pass'|'warn'|'fail'|'info', detail)],
    plans: [plan({ id, title, why, confidence, steps, auto })],
    facts: { ... },                          // shown in Under the hood, used by the assistant
    support: { level, note },                // optional: overrides the generic verdict
  }),
};
module.exports = { family };
```

Put it in `src/core/families/<id>.js`; `src/core/families/index.js` loads it. The `ctx` passed to `diagnose` has:

- `platform` and `arch` (`darwin` / `arm64` ...)
- `run(cmd, args, opts)`, which never throws and returns `{ ok, code, stdout, stderr, missing }`
- `recipes`, the knowledge base entries for this device and family
- `manager`, the package manager (`installStep(packages, ctx.manager)` from `src/core/fix/packages.js`)
- `baseChecks`, the generic checks that already ran

## Support levels

`native` · `app` (works through normal software, no driver) · `vendor-driver` · `unsupported` · `unknown`. See `src/core/support.js`. On Macs with Apple silicon, a device that needs a third-party kernel extension is `unsupported` for ordinary people: never suggest lowering the Mac's security. Say so plainly and suggest what does work.

## Plan steps

- `{ kind: 'command', title, explain, cmd, args, admin, safe, optional }`: `cmd` must be on `ALLOWED_PROGRAMS` in `src/core/fix/runner.js`.
- `{ kind: 'manual', title, explain }`: the plan pauses until the person clicks "I've done this".
- `{ kind: 'open-url', title, explain, url }`: https only.

Opening a settings pane is a command: `open x-apple.systempreferences:...` on macOS, `explorer.exe ms-settings:...` on Windows.

## Rules

- Never remove, erase or overwrite anything automatically. A step that does (reformatting a drive, for example) must be a `manual` step with a clear warning.
- `auto: true` only for plans whose steps are all safe, additive commands.
- Plain language. The reader has never opened a terminal.
- Test with recorded real output in `test/fixtures/`. Parsers must survive missing keys and junk.
