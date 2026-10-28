'use strict';

const { run: defaultRun } = require('./exec');
const { className, PRINTER_PROTOCOLS } = require('./usb/classes');

/**
 * "Under the hood": everything we can learn about a device without special
 * hardware, laid out as the starting point for reverse engineering it or
 * writing a knowledge base recipe.
 */

function interfaceLine(i) {
  const proto = i.class === '07' ? ` (${PRINTER_PROTOCOLS[i.protocol] ?? 'protocol ' + i.protocol})` : '';
  return `#${i.number ?? '?'}: class ${i.class ?? '??'} ${className(i.class)} / sub ${i.subclass ?? '??'} / proto ${i.protocol ?? '??'}${proto} -> driver: ${i.driver ?? 'none'}`;
}

/** Raw descriptor dump from the OS, when a tool for it exists. */
async function rawDescriptors(device, { platform = process.platform, run = defaultRun } = {}) {
  if ((device.source ?? 'usb') !== 'usb') {
    return { tool: `${device.source} details`, text: JSON.stringify({ details: device.details ?? {}, raw: device.raw ?? {} }, null, 2) };
  }
  if (platform === 'linux') {
    const res = await run('lsusb', ['-v', '-d', `${device.vendorId}:${device.productId}`]);
    if (res.ok) return { tool: 'lsusb -v', text: res.stdout };
    return { tool: 'sysfs', text: JSON.stringify(device.raw, null, 2), note: res.missing ? 'Install usbutils for the full descriptor dump.' : res.stderr };
  }
  if (platform === 'darwin') return { tool: 'ioreg', text: JSON.stringify(device.raw?.ioreg ?? {}, null, 2) };
  if (platform === 'win32') return { tool: 'Get-PnpDevice', text: JSON.stringify(device.raw ?? {}, null, 2) };
  return { tool: 'none', text: '' };
}

const CAPTURE_GUIDE = {
  linux: [
    'sudo modprobe usbmon',
    'Open Wireshark and capture on the "usbmonN" interface for the bus this device is on.',
    `Filter: usb.idVendor == 0x{vid} && usb.idProduct == 0x{pid}  (or by usb.device_address)`,
  ],
  darwin: [
    'Install Wireshark, then: sudo ifconfig XHC20 up  (Intel Macs; Apple Silicon needs a hardware analyzer or a Linux VM with USB passthrough).',
    'Capture on XHC20 and filter by the device address.',
  ],
  win32: [
    'Install Wireshark with the USBPcap option ticked.',
    'Capture on the USBPcap interface for the root hub this device is on.',
    'Use the official vendor driver in a VM once and record what it sends: that recording is the spec.',
  ],
};

/**
 * Build a Markdown report people can paste into a GitHub issue to ask for
 * help or to contribute a recipe.
 */
function buildMarkdown(device, diagnosis, descriptors) {
  const vid = device.vendorId;
  const pid = device.productId;
  const usb = (device.source ?? 'usb') === 'usb';
  const platform = device.platform ?? process.platform;
  const lines = [
    `## Device report: ${diagnosis?.title ?? device.displayName ?? device.productName}`,
    '',
    usb ? `- USB ID: \`${vid}:${pid}\`` : `- Found via: ${device.source}`,
    `- Vendor: ${device.vendorName ?? 'unknown'}`,
    `- Product: ${device.productName ?? 'unknown'}`,
    `- Platform: ${platform}`,
    `- Category: ${diagnosis?.category ?? (device.categories ?? []).join(', ')}`,
    `- Status: ${diagnosis?.status ?? 'unknown'} - ${diagnosis?.headline ?? ''}`,
    ...(diagnosis?.support ? [`- Support: ${diagnosis.support.label}`] : []),
  ];
  if (usb) {
    lines.push('', '### Interfaces', '', ...(device.interfaces?.length ? device.interfaces.map((i) => `- ${interfaceLine(i)}`) : ['- (none reported)']));
  }
  if (diagnosis?.facts?.deviceId) {
    lines.push('', '### IEEE 1284 device ID', '', '```', diagnosis.facts.deviceId, '```');
  }
  if (diagnosis?.checks?.length) {
    lines.push('', '### Checks', '', ...diagnosis.checks.map((c) => `- [${c.status}] ${c.label}${c.detail ? ': ' + c.detail : ''}`));
  }
  if (descriptors?.text) {
    lines.push('', `<details><summary>Raw data (${descriptors.tool})</summary>`, '', '```', descriptors.text.slice(0, 20000), '```', '', '</details>');
  }
  const guide = usb ? CAPTURE_GUIDE[platform] ?? [] : [];
  if (guide.length) {
    lines.push('', '### How to capture its USB traffic', '', ...guide.map((g) => `1. ${g.replace('{vid}', vid).replace('{pid}', pid)}`));
  }
  return lines.join('\n');
}

/** Pre-filled "new issue" URL for the project's device-report template. */
function issueUrl(device, repo = 'katesaikishore/plug-doctor') {
  const id = device.vendorId ? ` (${device.vendorId}:${device.productId})` : ` (${device.source})`;
  const title = `Device: ${device.displayName ?? `${device.vendorName ?? ''} ${device.productName ?? ''}`}${id}`.replace(/\s+/g, ' ');
  const params = new URLSearchParams({ template: 'device-report.yml', title, labels: 'device-report' });
  return `https://github.com/${repo}/issues/new?${params}`;
}

module.exports = { rawDescriptors, buildMarkdown, issueUrl, interfaceLine, CAPTURE_GUIDE };
