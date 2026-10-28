# Contributing to Plug Doctor

Thank you! Plug Doctor exists to save people from fighting their computers, and every contribution counts.

## Ways to help

- **Add a device recipe.** See [docs/ADDING_A_DEVICE.md](docs/ADDING_A_DEVICE.md). It is the most useful contribution and needs no JavaScript.
- **Report a device that does not work.** Open *Under the hood* and click **Ask the community on GitHub**.
- **Add checks for a new kind of device.** Add a family file in `src/core/families/` and register it in `src/core/families/index.js`. [docs/FAMILIES.md](docs/FAMILIES.md) explains how.
- **Improve a platform.** Windows and macOS have the most room to grow.
- **Translate.** Not wired up yet. If you want to lead it, open an issue.

## Development

```sh
npm install
npm test            # unit tests, no hardware needed
npm run demo        # the app with simulated devices
npm start           # the app against your real USB ports
npm run cli -- diagnose
```

Guidelines:

- Code in `src/core/` must not import Electron, and every command it runs goes through an injected `run`, so tests can fake it.
- Add a test with real tool output when you add a parser. Put the output in `test/fixtures/`.
- Plans only add things. Anything that removes or overwrites must not be offered automatically.
- Write user-facing text for someone who has never opened a terminal.

## Pull requests

Keep them focused, make sure `npm test` passes, and describe what you tested on which OS.
