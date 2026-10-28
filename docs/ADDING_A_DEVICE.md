# Adding a device recipe

A recipe teaches Plug Doctor how to make one device, or one family of devices, work. It is a JSON file in `knowledge/devices/` named `<id>.json`.

## The shape

```json
{
  "id": "brand-model",
  "name": "Brand Model 1234",
  "category": "printer",
  "match": {
    "usb": ["abcd:1234"],
    "models": ["Model 1234"],
    "vendors": ["abcd"]
  },
  "summary": "One or two sentences on what this device is and why it needs help.",
  "confidence": 0.9,
  "platforms": {
    "linux": {
      "packages": { "apt": ["pkg"], "dnf": ["pkg"], "pacman": ["pkg"], "zypper": ["pkg"] },
      "ppd": "drv:///some.drv/model.ppd",
      "ppdMatch": "Model 1234",
      "steps": [
        { "kind": "manual", "title": "Do a thing", "explain": "Exactly what to do, in plain language." }
      ],
      "notes": "Shown to the person on the Fix it tab."
    },
    "darwin": { "notes": "..." },
    "win32": { "notes": "..." }
  },
  "sources": ["https://where-you-learned-this.example"]
}
```

| Field | Meaning |
| --- | --- |
| `match.usb` | Exact `vendor:product` IDs in lowercase hex. Find them in Plug Doctor's *Under the hood* tab, with `lsusb` on Linux, or in System Information on macOS. Best match. |
| `match.models` | For printers, the `MDL:` name from the IEEE 1284 ID. |
| `match.vendors` | Vendor-wide advice. Used only when no model-specific recipe matches. |
| `category` | `printer`, `serial`, `storage`, ... The recipe is only applied to devices diagnosed as this. |
| `confidence` | 0 to 1. Recipes at 0.7 or above can run automatically when *Fix automatically* is on. Default 0.95. |
| `packages` | Installed with the system package manager. |
| `ppd` / `ppdMatch` | Printers: the driver to use (`lpinfo -m` lists names), or a regex for its make-and-model. Leave both out if the package install is enough: Plug Doctor then finds the exact driver itself on the next check. |
| `steps` | Extra steps. `kind` is `manual` (the person does it), `open-url` (with `"url": "https://..."`) or `command` (`cmd`, `args`, `admin`). Commands must use a program on the allow-list in `src/core/fix/runner.js`. |
| `notes` | Anything worth knowing, even with no automated fix. "HP never made a driver for this on macOS, here is what works" helps people. |

## Checklist

- [ ] `npm test` passes. The knowledge base tests validate every recipe.
- [ ] You tested it on the OS you wrote steps for, or you say clearly in `notes` that it is untested.
- [ ] `sources` links to where the fix comes from (vendor page, OpenPrinting, distro wiki, forum thread).
- [ ] Nothing in it removes software or overwrites a person's settings.

The assistant can draft a recipe for you after it fixes a device. Click **Share on GitHub** on the draft and a maintainer will turn it into a pull request.
