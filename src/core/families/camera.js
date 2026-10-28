'use strict';

const os = require('node:os');
const { installStep } = require('../fix/packages');
const { check, plan } = require('./helpers');
const { linuxFileManager } = require('./phone');

/**
 * Webcams (USB Video Class) and still cameras (PTP). Webcams work everywhere
 * without a driver; what goes wrong is permission (the `video` group on
 * Linux, per-app camera privacy on macOS and Windows) or another app holding
 * the camera. Still cameras are opened by a photo app, not a driver.
 */

const hasVideo = (d) => d.deviceClass === '0e' || (d.interfaces ?? []).some((i) => i.class === '0e');
const hasPtp = (d) => d.deviceClass === '06' || (d.interfaces ?? []).some((i) => i.class === '06');
const CAMERA_NAME = /\bweb ?cam|\bcam(era)?\b/i;

/** 'webcam', 'still' or 'vendor' (its own protocol). */
function cameraKind(d) {
  if (hasVideo(d)) return 'webcam';
  if (hasPtp(d)) return 'still';
  return 'vendor';
}

function matchCamera(d) {
  if (hasVideo(d)) return 75;
  if (hasPtp(d)) return 65;
  const itfs = d.interfaces ?? [];
  const vendorSpecific = itfs.length > 0 && itfs.every((i) => i.class === 'ff');
  return vendorSpecific && CAMERA_NAME.test(d.productName ?? '') ? 40 : 0;
}

/** /dev/videoN nodes, lowest first. A UVC camera usually has two (picture + metadata). */
function videoNodes(device) {
  const all = [...(device.nodes ?? []), ...(device.interfaces ?? []).flatMap((i) => i.nodes ?? [])];
  return [...new Set(all.filter((n) => /^video\d+$/.test(n)))].sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
}

const rescanPlan = (what) =>
  plan({
    id: 'windows-rescan',
    title: 'Ask Windows to set the camera up again',
    why: `Windows has built-in support for ${what}; re-scanning usually reinstalls it.`,
    confidence: 0.6,
    auto: true,
    steps: [{ kind: 'command', title: 'Re-scan devices', explain: 'Asks Windows to re-detect hardware and fetch a driver.', cmd: 'pnputil', args: ['/scan-devices'], admin: true, safe: true }],
  });

async function linuxWebcam(device, ctx) {
  const { run } = ctx;
  const checks = [];
  const plans = [];
  const nodes = videoNodes(device);
  const facts = { kind: 'webcam', nodes: nodes.map((n) => `/dev/${n}`) };

  if (nodes.length === 0) {
    const videoBound = (device.interfaces ?? []).some((i) => i.class === '0e' && i.driver);
    checks.push(check('node', 'Video device created', 'fail', 'No /dev/video* appeared for this camera.'));
    if (!videoBound) {
      checks.push(check('driver', 'Webcam driver (uvcvideo) loaded', 'fail', 'The built-in webcam driver did not claim the camera.'));
      plans.push(
        plan({
          id: 'load-uvcvideo',
          title: 'Load the webcam driver',
          why: 'Linux has a built-in driver for standard webcams (uvcvideo); it just was not loaded.',
          confidence: 0.7,
          auto: true,
          steps: [{ kind: 'command', title: 'Load uvcvideo', explain: 'Loads the standard webcam driver.', cmd: 'modprobe', args: ['uvcvideo'], admin: true, safe: true }],
        }),
      );
    }
    return { status: 'broken', headline: 'The camera is connected but no video device appeared.', checks, plans, facts };
  }
  const node = `/dev/${nodes[0]}`;
  checks.push(check('node', 'Video device created', 'pass', facts.nodes.join(', ')));

  const groupRes = await run('stat', ['-c', '%G', node]);
  const group = groupRes.ok ? groupRes.stdout.trim() : null;
  const mine = (await run('id', ['-nG'])).stdout.trim().split(/\s+/);
  facts.nodeGroup = group;
  if (group === 'video' && !mine.includes('video') && !mine.includes('root')) {
    // Desktop sessions usually get access through an ACL even outside the group.
    const access = await run('test', ['-w', node]);
    if (access.ok) {
      checks.push(check('permission', 'You are allowed to use the camera', 'pass', 'Your login session has access.'));
    } else {
      const user = os.userInfo().username;
      checks.push(check('permission', 'You are allowed to use the camera', 'fail', `${node} belongs to the "video" group and your account is not in it.`));
      plans.push(
        plan({
          id: 'join-video-group',
          title: 'Give your account access to cameras',
          why: `Adds "${user}" to the "video" group, the standard way to allow camera access on Linux.`,
          confidence: 0.85,
          steps: [
            { kind: 'command', title: `Add ${user} to video`, explain: 'One-time permission change.', cmd: 'usermod', args: ['-aG', 'video', user], admin: true, safe: true },
            { kind: 'manual', title: 'Log out and back in', explain: 'Group changes apply after you sign in again.' },
          ],
        }),
      );
      return { status: 'needs-fix', headline: 'The camera works but your account is not allowed to use it.', checks, plans, facts };
    }
  } else {
    checks.push(check('permission', 'You are allowed to use the camera', 'pass'));
  }

  const users = await run('fuser', [node]);
  const pids = users.ok ? users.stdout.match(/\d+/g) ?? [] : [];
  facts.inUseBy = pids;
  if (pids.length) {
    checks.push(check('in-use', 'Camera is free', 'info', `Another program (process ${pids.join(', ')}) is using the camera right now. If your video app shows a black picture, close the other one.`));
  }
  return { status: 'ok', headline: `Ready on ${node}.`, checks, plans, facts };
}

async function macWebcam() {
  return {
    status: 'ok',
    headline: 'macOS supports this camera directly. Each app needs your permission to use it.',
    checks: [
      check('privacy', 'Apps are allowed to use the camera', 'info', 'macOS asks once per app. If an app shows no camera or a black picture, allow it in System Settings > Privacy & Security > Camera.'),
      check('in-use', 'Camera is free', 'info', 'If the picture stays black, quit other video apps (FaceTime, Zoom, Teams) and try again.'),
    ],
    plans: [
      plan({
        id: 'camera-privacy',
        title: 'Open the camera privacy settings',
        why: 'Turn on the switch next to the app that should use the camera.',
        confidence: 0.5,
        steps: [{ kind: 'command', title: 'Open Privacy & Security > Camera', explain: 'Opens the list of apps allowed to use the camera.', cmd: 'open', args: ['x-apple.systempreferences:com.apple.preference.security?Privacy_Camera'], admin: false, safe: true }],
      }),
    ],
    facts: { kind: 'webcam' },
    support: { level: 'native' },
  };
}

async function windowsWebcam(device) {
  const checks = [];
  const plans = [];
  const facts = { kind: 'webcam' };
  if (device.problem) {
    facts.problemCode = device.problem.code;
    checks.push(check('driver', 'Windows has a driver', 'fail', device.problem.message));
    plans.push(rescanPlan('standard webcams'));
    return { status: 'broken', headline: 'Windows could not set up this camera.', checks, plans, facts };
  }
  checks.push(check('privacy', 'Apps are allowed to use the camera', 'info', 'If an app shows no camera, check Settings > Privacy & security > Camera.'));
  checks.push(check('in-use', 'Camera is free', 'info', 'Usually only one app can use the camera at a time. If the picture is black, close other video apps.'));
  plans.push(
    plan({
      id: 'camera-privacy',
      title: 'Open the camera privacy settings',
      why: 'Make sure camera access is on, both for Windows and for the app you use.',
      confidence: 0.5,
      steps: [{ kind: 'command', title: 'Open Privacy & security > Camera', explain: 'Opens the camera permission settings.', cmd: 'explorer.exe', args: ['ms-settings:privacy-webcam'], admin: false, safe: true }],
    }),
  );
  return { status: 'ok', headline: 'Windows supports this camera directly.', checks, plans, facts };
}

async function linuxStill(device, ctx) {
  const checks = [];
  const plans = [];
  const facts = { kind: 'still' };

  const fm = await linuxFileManager('gphoto2', ctx);
  checks.push(fm.check);
  facts.fileManager = fm.state;
  if (fm.plan) plans.push(fm.plan);

  const detect = await ctx.run('gphoto2', ['--auto-detect']);
  if (detect.missing) {
    checks.push(check('gphoto2', 'Camera tools (gphoto2)', 'info', 'gphoto2 is not installed. You only need it for tethered shooting or scripts.'));
    const step = installStep({ apt: ['gphoto2'], dnf: ['gphoto2'], pacman: ['gphoto2'] }, ctx.manager);
    plans.push(plan({ id: 'install-gphoto2', title: 'Install the gphoto2 camera tools', why: 'Optional: lets photo apps and scripts control the camera.', confidence: 0.3, steps: [step] }));
  } else {
    const rows = detect.stdout.split(/\r?\n/).filter((l) => /\busb:/.test(l));
    const port = device.busnum && device.devnum ? `usb:${String(device.busnum).padStart(3, '0')},${String(device.devnum).padStart(3, '0')}` : null;
    // Without a bus address to compare, a lone camera is assumed to be this one.
    const mine = port ? rows.find((l) => l.includes(port)) : rows.length === 1 ? rows[0] : null;
    facts.gphoto2 = mine ? mine.replace(/\s{2,}/g, ' ').trim() : null;
    checks.push(check('gphoto2', 'Camera tools (gphoto2) can see it', mine ? 'pass' : 'warn', mine ? facts.gphoto2 : 'gphoto2 did not list this camera. Some cameras must be set to "PTP" or "PC" in their USB menu.'));
  }
  checks.push(check('busy', 'Only one app at a time', 'info', 'When the file manager shows the camera, it keeps it open and other photo apps cannot use it. Eject the camera in the file manager sidebar first.'));

  if (fm.plan) return { status: 'needs-fix', headline: 'The camera is connected, but your file manager cannot open cameras yet.', checks, plans, facts };
  return { status: 'ok', headline: 'Ready: import photos from your file manager or a photo app.', checks, plans, facts };
}

async function macStill() {
  return {
    status: 'ok',
    headline: 'macOS supports this camera directly: import photos with Image Capture or Photos.',
    checks: [check('usb-mode', 'Camera USB mode', 'info', 'If the camera does not show up, set its USB mode to "PTP" or "PC" in the camera\'s menu.')],
    plans: [
      plan({
        id: 'open-image-capture',
        title: 'Open Image Capture',
        why: 'Image Capture, built into macOS, lists connected cameras and imports their photos.',
        confidence: 0.8,
        steps: [{ kind: 'command', title: 'Open Image Capture', explain: 'Opens Apple\'s photo import app.', cmd: 'open', args: ['-a', 'Image Capture'], admin: false, safe: true }],
      }),
    ],
    facts: { kind: 'still' },
  };
}

async function windowsStill(device) {
  if (device.problem) {
    return {
      status: 'broken',
      headline: 'Windows could not set up this camera.',
      checks: [check('driver', 'Windows has a driver', 'fail', device.problem.message)],
      plans: [rescanPlan('cameras')],
      facts: { kind: 'still', problemCode: device.problem.code },
    };
  }
  return { status: 'ok', headline: 'Ready: the camera is in File Explorer and the Photos app can import from it.', checks: [], plans: [], facts: { kind: 'still' } };
}

async function vendorCamera(device, ctx) {
  const facts = { kind: 'vendor' };
  const note = 'This camera uses its own protocol. It needs software from its maker, or a USB mode change in the camera\'s menu.';
  if (device.driver?.bound || (ctx.platform === 'win32' && !device.problem)) {
    return { status: 'ok', headline: 'Connected, and a driver is handling the camera.', checks: [], plans: [], facts, support: { level: 'vendor-driver', note } };
  }
  return {
    status: 'broken',
    headline: 'This camera uses its own protocol, so the computer cannot open it by itself.',
    checks: [check('protocol', 'Standard camera protocol', 'fail', 'The camera does not present itself as a standard webcam (UVC) or photo camera (PTP).')],
    plans: [
      plan({
        id: 'camera-usb-mode',
        title: 'Switch the camera\'s USB mode',
        why: 'Many cameras have a USB setting ("PTP", "PC", "Webcam" or "Mass storage"). The standard modes work without a driver.',
        confidence: 0.4,
        steps: [{ kind: 'manual', title: 'Change the USB mode on the camera', explain: 'Look in the camera\'s setup menu for USB or connection settings, choose PTP, PC or Webcam, then reconnect.' }],
      }),
    ],
    facts,
    support: { level: 'vendor-driver', note },
  };
}

async function diagnoseCamera(device, ctx) {
  const kind = cameraKind(device);
  if (kind === 'vendor') return vendorCamera(device, ctx);
  if (kind === 'webcam') {
    if (ctx.platform === 'linux') return linuxWebcam(device, ctx);
    if (ctx.platform === 'darwin') return macWebcam(device, ctx);
    return windowsWebcam(device, ctx);
  }
  if (ctx.platform === 'linux') return linuxStill(device, ctx);
  if (ctx.platform === 'darwin') return macStill(device, ctx);
  return windowsStill(device, ctx);
}

/** @type {import('./index').Family} */
const family = {
  id: 'camera',
  label: 'Camera',
  icon: 'camera',
  sources: ['usb'],
  match: matchCamera,
  // Photo cameras are opened from user space (Image Capture, libgphoto2) and
  // macOS runs webcams in user space too. Linux webcams need uvcvideo.
  userspace: (platform, device) => {
    const kind = cameraKind(device);
    if (kind === 'still') return platform !== 'win32';
    return kind === 'webcam' && platform === 'darwin';
  },
  diagnose: diagnoseCamera,
};

module.exports = { family, diagnoseCamera, cameraKind, videoNodes };
