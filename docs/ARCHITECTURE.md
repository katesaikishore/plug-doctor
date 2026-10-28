# Architecture

Plug Doctor has two halves:

- `src/core/` is plain Node.js with no Electron. It holds device sources, device families (diagnosis), fix plans and the runner. It is fully unit-tested and also drives the CLI (`bin/plug-doctor.js`) and demo mode (`src/core/demo.js`).
- `src/main/` and `src/renderer/` form the Electron app: the window, tray, notifications, settings and the assistant.

## Sources: where devices come from (`src/core/sources/`)

| Source | macOS | Linux | Windows | Pace |
| --- | --- | --- | --- | --- |
| `usb` | `ioreg` (devices, interfaces and the drivers below them) | `/sys/bus/usb/devices` | `Get-PnpDevice` (problem codes; `&MI_xx` folded into the parent) | 2 s |
| `display` | `system_profiler SPDisplaysDataType` + `hw.model` | `/sys/class/drm` EDID + `xrandr` | WMI monitor classes | 5 s |
| `bluetooth` | `system_profiler SPBluetoothDataType` | `bluetoothctl`, `rfkill`, `systemctl` | `Get-PnpDevice -Class Bluetooth` | 10 s |
| `network` | mDNS (`src/core/net/mdns.js`) and SSDP (`src/core/net/ssdp.js`), pure Node, same everywhere | | | 60 s, in the background |

`createInventory()` combines them, paces each source, keeps the last good list when a scan fails, and lets slow scans refresh without blocking. The watcher polls the inventory and emits `attach`, `detach`, `update` and `change`. Polling avoids native modules, so the app installs anywhere without a compiler.

Network discovery treats everything it hears as untrusted. Names are cleaned and capped, packets are size-limited, and device descriptions are only fetched over plain HTTP from the private IPv4 address that answered.

## Families: diagnosis (`src/core/families/`)

Each family is a plug-in: `match(device)` scores how sure it is the device is its kind, and the highest score wins (the `generic` family catches the rest). `diagnose(device, ctx)` returns:

```js
{ status: 'ok' | 'needs-fix' | 'broken' | 'unknown' | 'idle', headline, checks[], plans[], facts{}, support? }
```

`src/core/diagnose.js` adds the generic driver and error checks, knowledge-base recipes and the **support verdict** (`src/core/support.js`: native, app, vendor driver, unsupported). `ctx.run` is injected everywhere, so every family is tested against recorded tool output (`test/fixtures/`) and demo mode reuses the same code with a simulated system. [FAMILIES.md](FAMILIES.md) has the contract.

### The printer strategy (`src/core/printer/strategy.js`)

This was the first family, and its reasoning is the project's idea written as code:

1. a community recipe for this model
2. IPP-over-USB (interface 07/01/04): no driver needed
3. an installed driver whose make-and-model contains every significant token of the model name
4. a generic driver for the best language in the printer's IEEE 1284 `CMD:` list
5. otherwise, an honest "host-based, needs model-specific software"

## Fixing (`src/core/fix/`)

A plan is a list of steps: `command` (allow-listed program + args, optional `admin`), `manual` (the person does something; the plan waits for "I've done this") or `open-url`. `runner.js` validates every step against an allow-list (a stricter one for assistant plans), wraps admin steps with the OS's elevation prompt (`elevate.js`), and stops at the first failure. Afterwards the device is always diagnosed again, so the UI shows the real state.

## The app

- **Main process** owns the watcher, diagnoses, fix execution, settings (API key encrypted with `safeStorage`) and the assistant.
- **Renderer** is sandboxed with `contextIsolation`, a strict CSP and no Node. It builds DOM without `innerHTML`, because USB descriptor strings and model output are untrusted. It can only ask for a fix by device ID and plan ID, and the main process looks the plan up again.
- **Notifications and automatic fixes** only happen for things physically plugged in (USB, a screen). A TV turning on or headphones connecting stays quiet, and network printers are never added without a click.
- **Assistant** (`src/main/assistant.js`) uses the Anthropic SDK's tool runner with strict tools: `list_devices`, `diagnose_device`, `run_probe` (named read-only commands for every source), `search_knowledge_base`, `propose_fix` (approval-gated, allow-listed) and `draft_recipe`. It can also use web search and fetch when enabled.
