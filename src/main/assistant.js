'use strict';

const fs = require('node:fs/promises');
const Anthropic = require('@anthropic-ai/sdk').default;
const { betaTool } = require('@anthropic-ai/sdk/helpers/beta/json-schema');
const { run } = require('../core/exec');
const kb = require('../core/kb');
const { validateStep, AI_ALLOWED_PROGRAMS } = require('../core/fix/runner');
const { PNP_SCRIPT } = require('../core/usb/windows');

const MODEL = 'claude-opus-5-5';
const MAX_OUTPUT = 12000;

/**
 * Read-only probes the assistant may run, by name. It never gets a free-form
 * shell: anything that changes the system goes through propose_fix and the
 * person's approval.
 */
const PROBES = {
  linux: {
    usb_tree: (d) => ['lsusb', ['-t']],
    usb_descriptors: (d) => ['lsusb', d ? ['-v', '-d', `${d.vendorId}:${d.productId}`] : ['-v']],
    kernel_log: () => ['journalctl', ['-k', '-n', '300', '--no-pager']],
    kernel_modules: () => ['lsmod', []],
    printers: () => ['lpstat', ['-t']],
    printer_devices: () => ['lpinfo', ['--include-schemes', 'usb', '-l', '-v']],
    printer_drivers: () => ['lpinfo', ['-m']],
    disks: () => ['lsblk', ['-o', 'NAME,TRAN,FSTYPE,MOUNTPOINT,SIZE,MODEL,SERIAL,LABEL']],
    os_version: () => ['cat', ['/etc/os-release']],
    displays: () => ['xrandr', ['--query']],
    bluetooth: () => ['bluetoothctl', ['show']],
    radio_switches: () => ['rfkill', ['list']],
    audio_devices: () => ['aplay', ['-l']],
    scanners: () => ['scanimage', ['-L']],
    network_interfaces: () => ['ip', ['-o', 'addr']],
    installed_packages: () => ['sh', ['-c', 'dpkg -l 2>/dev/null || rpm -qa 2>/dev/null || pacman -Q 2>/dev/null']],
  },
  darwin: {
    usb_tree: () => ['ioreg', ['-p', 'IOUSB', '-w0']],
    usb_descriptors: () => ['ioreg', ['-p', 'IOUSB', '-l', '-w0']],
    usb_system_report: () => ['system_profiler', ['SPUSBDataType', 'SPUSBHostDataType']],
    kernel_extensions: () => ['kmutil', ['showloaded', '--list-only']],
    printers: () => ['lpstat', ['-t']],
    printer_devices: () => ['lpinfo', ['--include-schemes', 'usb', '-l', '-v']],
    printer_drivers: () => ['lpinfo', ['-m']],
    disks: () => ['diskutil', ['list', 'external']],
    os_version: () => ['sw_vers', []],
    hardware: () => ['system_profiler', ['SPHardwareDataType']],
    displays: () => ['system_profiler', ['SPDisplaysDataType']],
    bluetooth: () => ['system_profiler', ['SPBluetoothDataType']],
    audio_devices: () => ['system_profiler', ['SPAudioDataType']],
    network_interfaces: () => ['ifconfig', []],
  },
  win32: {
    pnp_devices: () => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PNP_SCRIPT]],
    printers: () => ['powershell.exe', ['-NoProfile', '-Command', 'Get-Printer | Format-List Name,DriverName,PortName,PrinterStatus; Get-PrinterDriver | Format-List Name,Manufacturer']],
    driver_store: () => ['pnputil', ['/enum-drivers']],
    os_version: () => ['powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem) | Format-List Caption,Version,OSArchitecture']],
    displays: () => ['powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Format-List Name,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate']],
    bluetooth: () => ['powershell.exe', ['-NoProfile', '-Command', 'Get-PnpDevice -Class Bluetooth | Format-List FriendlyName,Status,InstanceId']],
    audio_devices: () => ['powershell.exe', ['-NoProfile', '-Command', 'Get-PnpDevice -Class AudioEndpoint,MEDIA | Format-List FriendlyName,Status']],
    network_interfaces: () => ['powershell.exe', ['-NoProfile', '-Command', 'Get-NetAdapter | Format-List Name,InterfaceDescription,Status,LinkSpeed']],
  },
};

const ALL_PROBES = [...new Set(Object.values(PROBES).flatMap((p) => Object.keys(p)))];

function clip(text, filter) {
  let out = String(text);
  if (filter) {
    const f = filter.toLowerCase();
    out = out.split('\n').filter((l) => l.toLowerCase().includes(f)).join('\n') || `(no lines contain "${filter}")`;
  }
  return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n... [${out.length - MAX_OUTPUT} more characters cut]` : out;
}

function systemPrompt(platform, webResearch = true) {
  const os = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[platform] ?? platform;
  return `You are the troubleshooting assistant inside Plug Doctor, a free, open-source desktop app whose promise is: plug a device in (USB, a screen or TV, Bluetooth, something on the home network) and it just works. You are running on the person's own ${os} computer.

The people you help are usually not technical. They plugged in a printer, a phone, a screen or TV, headphones, a drive or a gadget and it does not work. Write plainly, in short paragraphs, and explain any jargon you cannot avoid. Lead with what you found and what you will do; keep the investigation details brief unless they ask.

How to work:
- Start from facts, not guesses. Use diagnose_device and run_probe to see what the operating system sees: USB IDs, interface classes, which driver claimed it, the printer's IEEE 1284 command set, display modes, Bluetooth state, kernel messages. Each diagnosis includes a support verdict (native, app, vendor-driver, unsupported).
- Be honest about hard limits. On Macs with Apple silicon, third-party kernel drivers only load after lowering the Mac's security: never suggest that. Prefer what works without it (built-in support, software that runs as a normal app, user-space drivers); when nothing does, say so and suggest a device that works.
- Think like a reverse engineer. The vendor:product ID identifies the chip or model; the interface class says what kind of device it claims to be; a printer's command set says which generic driver can drive it. Many "unsupported" devices work with a generic or open-source driver once you know what they really are.
${webResearch ? "- Use web search to find drivers, known issues and community fixes when the local facts are not enough. Prefer official vendor pages, OpenPrinting, distribution wikis and the projects' own repositories.\n" : ''}- To change anything, call propose_fix. The person sees every command and must approve it, and the operating system asks for their password when a step needs administrator rights. You may only use these programs: ${[...AI_ALLOWED_PROGRAMS].join(', ')}. Choose the least invasive fix that will work; never remove software.
- If the fix needs something outside that list (a vendor installer, a firmware download, a setting in System Settings), give clear numbered steps for the person to do themselves.
- Never ask for passwords or API keys.
- When a fix works, call draft_recipe so the fix can be shared with the next person who owns this device.
- If you cannot make the device work, say so honestly, explain why in one or two sentences, and suggest the "Under the hood" tab's device report for asking the community.`;
}

/**
 * One assistant conversation. The Electron main process owns it and wires
 * its callbacks to the UI.
 */
class Assistant {
  /**
   * @param {object} deps
   * @param {string} deps.apiKey
   * @param {() => any[]} deps.getDevices
   * @param {(id: string) => Promise<any>} deps.diagnoseDevice
   * @param {(plan: any) => Promise<{ approved: boolean, outcome?: any }>} deps.proposeFix  shows the plan, runs it if approved
   * @param {(event: any) => void} deps.onEvent
   * @param {boolean} [deps.webResearch]
   * @param {NodeJS.Platform} [deps.platform]
   */
  constructor(deps) {
    this.deps = { platform: process.platform, webResearch: true, ...deps };
    this.client = new Anthropic({ apiKey: deps.apiKey });
    this.messages = [];
    this.busy = false;
    this.abort = null;
  }

  reset() {
    this.abort?.abort();
    this.messages = [];
  }

  findDevice(id) {
    return this.deps.getDevices().find((d) => d.id === id) ?? null;
  }

  tools() {
    const { platform } = this.deps;
    const probes = Object.keys(PROBES[platform] ?? {});
    const strict = (tool) => ({ ...tool, strict: true });
    const tools = [
      strict(
        betaTool({
          name: 'list_devices',
          description: 'List the devices Plug Doctor can see right now (USB, screens, Bluetooth, home network), with their IDs, names, categories and driver status.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          run: async () =>
            JSON.stringify(
              this.deps.getDevices().map((d) => ({
                device_id: d.id,
                source: d.source ?? 'usb',
                usb_id: d.vendorId ? `${d.vendorId}:${d.productId}` : undefined,
                details: d.details,
                vendor: d.vendorName,
                product: d.productName,
                categories: d.categories,
                driver: d.driver,
                problem: d.problem,
                interfaces: (d.interfaces ?? []).map(({ nodes, ...i }) => i),
              })),
            ),
        }),
      ),
      strict(
        betaTool({
          name: 'diagnose_device',
          description: "Run Plug Doctor's built-in checks on one device. Returns the checks, the facts found (for printers: the IEEE 1284 device ID, command set, candidate drivers) and the fix plans Plug Doctor already knows.",
          inputSchema: {
            type: 'object',
            properties: { device_id: { type: 'string', description: 'device_id from list_devices' } },
            required: ['device_id'],
            additionalProperties: false,
          },
          run: async ({ device_id }) => {
            if (!this.findDevice(device_id)) return `No device with id ${device_id}. Call list_devices.`;
            return JSON.stringify(await this.deps.diagnoseDevice(device_id));
          },
        }),
      ),
      strict(
        betaTool({
          name: 'run_probe',
          description: `Run one read-only system probe and get its output. Available on this computer: ${probes.join(', ')}. Use filter to keep only lines containing a word (case-insensitive), e.g. a model name in printer_drivers.`,
          inputSchema: {
            type: 'object',
            properties: {
              probe: { type: 'string', enum: ALL_PROBES },
              device_id: { type: 'string', description: 'Device the probe is about, or "" if none.' },
              filter: { type: 'string', description: 'Only return lines containing this text, or "" for everything.' },
            },
            required: ['probe', 'device_id', 'filter'],
            additionalProperties: false,
          },
          run: async ({ probe, device_id, filter }) => {
            const make = PROBES[platform]?.[probe];
            if (!make) return `The probe "${probe}" is not available on ${platform}. Available: ${probes.join(', ')}.`;
            const [cmd, args] = make(device_id ? this.findDevice(device_id) : null);
            this.deps.onEvent({ type: 'activity', text: `Looking at ${probe.replace(/_/g, ' ')}` });
            const res = cmd === 'cat' ? await readFileProbe(args[0]) : await run(cmd, args, { timeout: 60000 });
            if (res.missing) return `${cmd} is not installed on this computer.`;
            return clip(res.stdout || res.stderr || '(no output)', filter);
          },
        }),
      ),
      strict(
        betaTool({
          name: 'search_knowledge_base',
          description: "Search Plug Doctor's community knowledge base of device recipes (known fixes per device).",
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
          run: async ({ query }) => {
            const hits = kb.search(query);
            return hits.length ? JSON.stringify(hits) : 'No recipes matched.';
          },
        }),
      ),
      strict(
        betaTool({
          name: 'propose_fix',
          description:
            'Propose a fix. The person sees the title, explanation and every command, and decides whether to run it. Steps run in order and stop at the first failure. Returns what happened, including each command\'s output, or that the person declined.',
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short, plain-language title, e.g. "Set up your printer with the generic PCL 6 driver".' },
              explanation: { type: 'string', description: 'Why this should work and what it changes, in two or three plain sentences.' },
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    explain: { type: 'string', description: 'One sentence a non-technical person understands.' },
                    program: { type: 'string', enum: [...AI_ALLOWED_PROGRAMS] },
                    args: { type: 'array', items: { type: 'string' } },
                    admin: { type: 'boolean', description: 'Needs administrator rights.' },
                  },
                  required: ['title', 'explain', 'program', 'args', 'admin'],
                  additionalProperties: false,
                },
              },
            },
            required: ['title', 'explanation', 'steps'],
            additionalProperties: false,
          },
          run: async ({ title, explanation, steps }) => {
            const plan = {
              id: `ai-${Date.now()}`,
              title,
              why: explanation,
              confidence: null,
              source: 'ai',
              steps: steps.map((s) => ({ kind: 'command', title: s.title, explain: s.explain, cmd: s.program, args: s.args, admin: s.admin, safe: false })),
            };
            if (plan.steps.length === 0) return 'A fix needs at least one step.';
            for (const step of plan.steps) {
              const check = validateStep(step, { source: 'ai' });
              if (!check.ok) return `Rejected before showing it to the person: ${check.reason} Allowed programs: ${[...AI_ALLOWED_PROGRAMS].join(', ')}. Give manual instructions for anything else.`;
            }
            const { approved, outcome } = await this.deps.proposeFix(plan);
            if (!approved) return 'The person declined this fix. Ask what they would prefer, or suggest an alternative.';
            return JSON.stringify({
              ok: outcome.ok,
              steps: outcome.results.map((r, i) => ({ step: plan.steps[i].title, ok: r.ok, exit_code: r.code, stdout: clip(r.stdout ?? '', ''), stderr: clip(r.stderr ?? r.error ?? '', '') })),
            });
          },
        }),
      ),
      strict(
        betaTool({
          name: 'draft_recipe',
          description:
            'After a fix worked, write it down as a knowledge base recipe so the next owner of this device gets it in one click. Pass the recipe as a JSON string following docs/ADDING_A_DEVICE.md: id, name, category, match {usb: ["vvvv:pppp"]}, summary, platforms {<linux|darwin|win32>: {packages?, steps?, notes}}, sources.',
          inputSchema: {
            type: 'object',
            properties: { recipe_json: { type: 'string' } },
            required: ['recipe_json'],
            additionalProperties: false,
          },
          run: async ({ recipe_json }) => {
            let recipe;
            try {
              recipe = JSON.parse(recipe_json);
            } catch (err) {
              return `That is not valid JSON: ${err.message}`;
            }
            this.deps.onEvent({ type: 'recipe-draft', recipe });
            return 'Draft shown to the person with a button to share it with the project.';
          },
        }),
      ),
    ];
    if (this.deps.webResearch) {
      tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 6 });
      tools.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 });
    }
    return tools;
  }

  /**
   * Send a message. Resolves when the assistant has finished its turn,
   * including all tool calls. Progress arrives through onEvent.
   * @param {string} text
   * @param {string|null} deviceId  the device the person is looking at
   */
  async send(text, deviceId = null) {
    if (this.busy) throw new Error('The assistant is still working on the last message.');
    this.busy = true;
    this.abort = new AbortController();
    const { onEvent } = this.deps;

    let content = text;
    const device = deviceId ? this.findDevice(deviceId) : null;
    if (device) {
      const diagnosis = await this.deps.diagnoseDevice(device.id).catch(() => null);
      const where = device.vendorId ? `USB ${device.vendorId}:${device.productId}` : `found via ${device.source}`;
      content = `[The person is looking at device ${device.id}: ${device.displayName ?? device.productName ?? ''} (${where}). Latest Plug Doctor diagnosis: ${JSON.stringify(diagnosis)}]\n\n${text}`;
    }
    const history = [...this.messages, { role: 'user', content }];

    try {
      const runner = this.client.beta.messages.toolRunner(
        {
          model: MODEL,
          max_tokens: 16000,
          output_config: { effort: 'high' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          cache_control: { type: 'ephemeral' },
          system: systemPrompt(this.deps.platform, this.deps.webResearch),
          tools: this.tools(),
          messages: history,
          max_iterations: 25,
        },
        { signal: this.abort.signal },
      );

      let last = null;
      for await (const message of runner) {
        last = message;
        for (const block of message.content) {
          if (block.type === 'text' && block.text.trim()) onEvent({ type: 'text', text: block.text });
          else if (block.type === 'server_tool_use' && block.name === 'web_search') onEvent({ type: 'activity', text: `Searching the web: ${block.input?.query ?? ''}` });
          else if (block.type === 'server_tool_use' && block.name === 'web_fetch') onEvent({ type: 'activity', text: `Reading ${block.input?.url ?? 'a web page'}` });
          else if (block.type === 'tool_use' && block.name !== 'run_probe') onEvent({ type: 'activity', text: activityLabel(block.name) });
        }
      }
      // The runner keeps the full transcript, including tool results.
      this.messages = [...runner.params.messages];
      if (last?.stop_reason === 'refusal') {
        onEvent({ type: 'error', text: 'The assistant could not help with that request. Try describing the problem differently.' });
      } else if (last?.stop_reason === 'max_tokens') {
        onEvent({ type: 'error', text: 'The answer was cut off. Ask the assistant to continue.' });
      }
      onEvent({ type: 'done' });
    } catch (err) {
      onEvent({ type: 'error', text: explainError(err) });
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }
}

function activityLabel(name) {
  return {
    list_devices: 'Checking what is plugged in',
    diagnose_device: 'Running Plug Doctor checks',
    search_knowledge_base: 'Searching the knowledge base',
    propose_fix: 'Proposing a fix',
    draft_recipe: 'Writing down the fix for others',
  }[name] ?? name;
}

async function readFileProbe(file) {
  try {
    return { ok: true, stdout: await fs.readFile(file, 'utf8'), stderr: '', missing: false };
  } catch (err) {
    return { ok: false, stdout: '', stderr: err.message, missing: false };
  }
}

function explainError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The API key was not accepted. Check it in Settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use the assistant model or one of its tools. If web research is the problem, turn it off in Settings.';
  if (err instanceof Anthropic.RateLimitError) return 'Too many requests right now. Wait a minute and try again.';
  if (err instanceof Anthropic.BadRequestError) return `The request was rejected: ${err.message}. If it mentions web search, turn off web research in Settings.`;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the assistant. Check your internet connection. (Plug Doctor\'s own checks and fixes work offline.)';
  if (err instanceof Anthropic.APIError) return `The assistant service had a problem (${err.status}). Try again in a moment.`;
  if (err?.name === 'AbortError' || err instanceof Anthropic.APIUserAbortError) return 'Stopped.';
  return `Something went wrong: ${err?.message ?? err}`;
}

module.exports = { Assistant, PROBES, systemPrompt, clip };
