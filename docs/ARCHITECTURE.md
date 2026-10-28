# Architecture

Plug Doctor has two halves:

- `src/core/` is plain Node.js with no Electron. It holds detection, diagnosis, fix plans and the runner. It is fully unit-tested and also drives the CLI (`bin/plug-doctor.js`).
- `src/main/` and `src/renderer/` form the Electron app: the window, tray, notifications, settings and the assistant.

## Detection (`src/core/usb/`)

| OS | Source | Why |
| --- | --- | --- |
| Linux | `/sys/bus/usb/devices` | No root, no libusb. Interface `driver` symlinks show what is bound, and child directories show device nodes (`ttyUSB0`, `lp0`). |
| macOS | `ioreg -p IOUSB -l` and `ioreg -c IOUSBHostInterface -l` | Stable across macOS versions, unlike `system_profiler` JSON keys. |
| Windows | `Get-PnpDevice` via PowerShell | Includes Device Manager problem codes (Code 28 = no driver). Composite `&MI_xx` interfaces are folded into their parent. |

Everything is normalized into one device shape (see `src/core/usb/index.js`). `UsbWatcher` polls every 2 s and emits `attach` / `detach`. Polling avoids native modules, so the app installs anywhere without a compiler.

## Diagnosis (`src/core/diagnose/`)

`diagnose(device, ctx)` picks a primary category, runs that category's checks, and returns:

```js
{ status: 'ok' | 'needs-fix' | 'broken' | 'unknown', headline, checks[], plans[], facts{}, recipes[] }
```

`ctx.run` is injected, so every module is tested against recorded tool output (`test/fixtures/`) and demo mode reuses the same code with a simulated system.

### The printer strategy (`src/core/printer/strategy.js`)

This is the core idea of the project, written as code:

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
- **Assistant** (`src/main/assistant.js`) uses the Anthropic SDK's tool runner with strict tools: `list_devices`, `diagnose_device`, `run_probe` (named read-only commands), `search_knowledge_base`, `propose_fix` (approval-gated, allow-listed) and `draft_recipe`. It can also use web search and fetch when enabled.
