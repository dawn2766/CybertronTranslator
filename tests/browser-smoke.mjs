import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE_PATH = String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
const PROJECT_DIRECTORY = fileURLToPath(new URL('../', import.meta.url));
const APP_DIRECTORY = fileURLToPath(new URL('../app/', import.meta.url));
const ARTIFACT_DIRECTORY = path.join(os.tmpdir(), 'cybertron-browser-smoke');
const DOWNLOAD_DIR = path.join(ARTIFACT_DIRECTORY, 'downloads');
const DOWNLOAD_NAME = 'cybertron-decepticon.png';
const DESKTOP_SCREENSHOT = path.join(ARTIFACT_DIRECTORY, 'editorial-desktop-1440x900.png');
const REVERSE_DESKTOP_SCREENSHOT = path.join(ARTIFACT_DIRECTORY, 'editorial-reverse-desktop-1440x900.png');
const MOBILE_SCREENSHOT = path.join(ARTIFACT_DIRECTORY, 'editorial-mobile-390x844.png');
const REVERSE_MOBILE_SCREENSHOT = path.join(ARTIFACT_DIRECTORY, 'editorial-reverse-mobile-390x844.png');
const REFERENCE_SCREENSHOT = path.join(ARTIFACT_DIRECTORY, 'concise-reference.png');
const TRANSPARENT_GLYPH_SCREENSHOT = path.join(ARTIFACT_DIRECTORY, 'black-transparent-glyph-check.png');
const PNG_SIGNATURE = '89504e470d0a1a0a';
const COMMAND_TIMEOUT_MS = 7_000;
const SESSION_TIMEOUT_MS = 45_000;

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
});

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    socket.addEventListener('message', (event) => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener('close', () => {
      const error = new Error('CDP WebSocket closed unexpectedly');
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    assert.equal(typeof WebSocket, 'function', 'Node must provide the built-in WebSocket API');
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out opening the CDP WebSocket')), COMMAND_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Failed to open the CDP WebSocket'));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  async handleMessage(data) {
    const text = typeof data === 'string'
      ? data
      : data instanceof Blob
        ? await data.text()
        : Buffer.from(data).toString('utf8');
    const message = JSON.parse(text);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    const handlers = this.listeners.get(message.method);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(message.params ?? {}, message.sessionId);
    }
  }

  request(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${COMMAND_TIMEOUT_MS} ms: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { method, reject, resolve, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) ?? new Set();
    handlers.add(handler);
    this.listeners.set(method, handlers);
    return () => handlers.delete(handler);
  }

  waitForEvent(method, sessionId, timeoutMs = COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const unsubscribe = this.on(method, (params, eventSessionId) => {
        if (sessionId && eventSessionId !== sessionId) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(params);
      });
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${method}`));
      }, timeoutMs);
    });
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(check, description, timeoutMs = COMMAND_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const staticRoot = relativePath.startsWith('assets/') ? APP_DIRECTORY : PROJECT_DIRECTORY;
      const filePath = path.resolve(staticRoot, relativePath);
      const resolvedRoot = path.resolve(staticRoot);
      if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}${path.sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const contents = await readFile(filePath);
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      });
      response.end(contents);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForDevTools(port) {
  return waitUntil(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(750),
      });
      if (!response.ok) return false;
      const version = await response.json();
      return version.webSocketDebuggerUrl ? version : false;
    } catch {
      return false;
    }
  }, 'Edge DevTools endpoint', 10_000);
}

async function waitForTarget(port, targetId) {
  return waitUntil(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(750),
      });
      if (!response.ok) return false;
      const targets = await response.json();
      return targets.find((target) => target.id === targetId && target.webSocketDebuggerUrl) ?? false;
    } catch {
      return false;
    }
  }, `Edge page target ${targetId}`, 10_000);
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.request('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId);
  if (result.exceptionDetails) {
    const exception = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.exception?.value
      ?? result.exceptionDetails.text;
    throw new Error(`Runtime.evaluate failed: ${exception}`);
  }
  return result.result?.value;
}

async function dispatchKey(cdp, sessionId, key, code, virtualKeyCode, text = '') {
  const keyParams = {
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  };
  await cdp.request('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    ...keyParams,
    ...(text ? { text, unmodifiedText: text } : {}),
  }, sessionId);
  await cdp.request('Input.dispatchKeyEvent', { type: 'keyUp', ...keyParams }, sessionId);
}

async function captureScreenshot(cdp, sessionId, filePath, clip) {
  const { data } = await cdp.request('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  }, sessionId);
  await writeFile(filePath, Buffer.from(data, 'base64'));
  const fileStats = await stat(filePath);
  assert.ok(fileStats.size > 0, `${filePath} must be a non-empty screenshot`);
  return { path: filePath, bytes: fileStats.size };
}

async function captureFullPage(cdp, sessionId, filePath) {
  const { cssContentSize } = await cdp.request('Page.getLayoutMetrics', {}, sessionId);
  return captureScreenshot(cdp, sessionId, filePath, {
    x: 0,
    y: 0,
    width: cssContentSize.width,
    height: cssContentSize.height,
  });
}

async function collectLayout(cdp, sessionId, width, height, mobile) {
  await cdp.request('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: width,
    screenHeight: height,
  }, sessionId);
  await evaluate(cdp, sessionId, 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  return evaluate(cdp, sessionId, `(() => {
    const visibleButtons = [...document.querySelectorAll('button')]
      .filter((button) => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
          && rect.width > 0 && rect.height > 0;
      })
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return { id: button.id, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });
    const overlaps = [];
    for (let first = 0; first < visibleButtons.length; first += 1) {
      for (let second = first + 1; second < visibleButtons.length; second += 1) {
        const a = visibleButtons[first];
        const b = visibleButtons[second];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) {
          overlaps.push([a.id, b.id]);
        }
      }
    }
    const documentElement = document.documentElement;
    const body = document.body;
    const scrollWidth = Math.max(documentElement.scrollWidth, body.scrollWidth);
    const scrollHeight = Math.max(documentElement.scrollHeight, body.scrollHeight);
    const clippedControls = ['#sample-button', '#glyph-count', '#export-button']
      .map((selector) => document.querySelector(selector))
      .filter((element) => element && getComputedStyle(element).display !== 'none')
      .filter((element) => element.scrollWidth > element.clientWidth + 1
        || element.scrollHeight > element.clientHeight + 1)
      .map((element) => element.id);
    const sections = [...document.querySelectorAll('.product-header, .language-bar, .source-pane, .target-pane, .action-bar, .privacy-note')]
      .map((section) => {
        const rect = section.getBoundingClientRect();
        return { className: section.className, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });
    const sectionOverlaps = [];
    for (let first = 0; first < sections.length; first += 1) {
      for (let second = first + 1; second < sections.length; second += 1) {
        const a = sections[first];
        const b = sections[second];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) {
          sectionOverlaps.push([a.className, b.className]);
        }
      }
    }
    const outOfBounds = visibleButtons
      .filter((button) => button.left < -0.5 || button.right > innerWidth + 0.5)
      .map((button) => button.id);
    const output = document.querySelector('#output');
    const sourcePane = document.querySelector('.source-pane').getBoundingClientRect();
    const targetPane = document.querySelector('.target-pane').getBoundingClientRect();
    const sourceLanguage = document.querySelector('.source-language').getBoundingClientRect();
    const targetLanguage = document.querySelector('.target-language').getBoundingClientRect();
    const directionButton = document.querySelector('#direction-button').getBoundingClientRect();
    const alphabetSelector = document.querySelector('#alphabet-selector').getBoundingClientRect();
    const targetStyle = getComputedStyle(document.querySelector('.target-pane'));
    const targetChannels = targetStyle.backgroundColor.match(/[0-9]+/g)?.map(Number) ?? [];
    const primaryStyle = getComputedStyle(document.querySelector('#export-button'));
    const sampleStyle = getComputedStyle(document.querySelector('#sample-button'));
    const sampleBeforeStyle = getComputedStyle(document.querySelector('#sample-button'), '::before');
    const sampleAfterStyle = getComputedStyle(document.querySelector('#sample-button'), '::after');
    const sourceWatermarkStyle = getComputedStyle(document.querySelector('.source-pane'), '::before');
    const brandMarkRect = document.querySelector('.brand-mark').getBoundingClientRect();
    const brandImageRect = document.querySelector('#brand-glyph').getBoundingClientRect();
    const parseRgb = (color) => {
      if (/^#[0-9a-f]{6}$/i.test(color)) {
        return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
      }
      return color.match(/[0-9]+(?:\.[0-9]+)?/g)?.slice(0, 3).map(Number) ?? [];
    };
    const luminance = (color) => {
      const channels = parseRgb(color).map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return channels.length === 3 ? channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 : 0;
    };
    const primaryBackgroundLuminance = luminance(primaryStyle.backgroundColor);
    const primaryColorLuminance = luminance(primaryStyle.color);
    const factionSignal = getComputedStyle(document.documentElement)
      .getPropertyValue('--signal').trim();
    return {
      requested: { width: ${width}, height: ${height}, mobile: ${mobile} },
      innerWidth,
      innerHeight,
      clientWidth: documentElement.clientWidth,
      scrollWidth,
      scrollHeight,
      clippedControls,
      visibleButtonCount: visibleButtons.length,
      overlaps,
      outOfBounds,
      sectionOverlaps,
      outputOverflow: output.scrollWidth > output.clientWidth + 0.5,
      workspace: {
        sourcePane: { left: sourcePane.left, top: sourcePane.top, width: sourcePane.width, height: sourcePane.height, bottom: sourcePane.bottom },
        targetPane: { left: targetPane.left, top: targetPane.top, width: targetPane.width, height: targetPane.height, bottom: targetPane.bottom },
        sourceLanguage: { left: sourceLanguage.left, top: sourceLanguage.top, width: sourceLanguage.width },
        targetLanguage: { left: targetLanguage.left, top: targetLanguage.top, width: targetLanguage.width },
        directionSelectorOverlap: Math.max(0,
          Math.min(directionButton.right, alphabetSelector.right)
            - Math.max(directionButton.left, alphabetSelector.left)),
        targetBackground: targetStyle.backgroundColor,
        targetNearWhite: targetChannels.length >= 3 && targetChannels.slice(0, 3).every((channel) => channel >= 250),
      },
      visualSystem: {
        primaryBackground: primaryStyle.backgroundColor,
        primaryColor: primaryStyle.color,
        primaryContrast: (Math.max(primaryBackgroundLuminance, primaryColorLuminance) + 0.05)
          / (Math.min(primaryBackgroundLuminance, primaryColorLuminance) + 0.05),
        primaryMatchesFaction: primaryStyle.backgroundColor === 'rgb(' + parseRgb(factionSignal).join(', ') + ')',
        sampleClipPath: sampleStyle.clipPath,
        sampleBeforeDisplay: sampleBeforeStyle.display,
        sampleAfterDisplay: sampleAfterStyle.display,
        watermarkSize: sourceWatermarkStyle.backgroundSize,
        watermarkPosition: sourceWatermarkStyle.backgroundPosition,
        watermarkImage: sourceWatermarkStyle.backgroundImage,
        brandContained: brandImageRect.left >= brandMarkRect.left + 3
          && brandImageRect.top >= brandMarkRect.top + 3
          && brandImageRect.right <= brandMarkRect.right - 3
          && brandImageRect.bottom <= brandMarkRect.bottom - 3,
      },
    };
  })()`);
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killer.kill();
      resolve();
    }, 5_000);
    killer.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    killer.once('error', () => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve();
    });
  });
}

async function removeProfile(profileDirectory) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(profileDirectory, { force: true, recursive: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await delay(100 * (attempt + 1));
    }
  }
}

async function runSmoke() {
  const staticServer = await startStaticServer();
  const appUrl = staticServer.url;
  const serverResponse = await fetch(appUrl, { cache: 'no-store', signal: AbortSignal.timeout(3_000) });
  assert.equal(serverResponse.ok, true, `Static server must respond at ${appUrl}`);
  await serverResponse.arrayBuffer();

  await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
  await rm(DOWNLOAD_DIR, { force: true, recursive: true });
  await mkdir(DOWNLOAD_DIR, { recursive: true });

  const glyphHashes = [];
  for (const family of ['autobot', 'decepticon']) {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const contents = await readFile(path.join(APP_DIRECTORY, 'assets', 'glyphs', family, `${letter}.png`));
      glyphHashes.push(createHash('sha256').update(contents).digest('hex'));
    }
  }
  assert.equal(new Set(glyphHashes).size, 52, 'All 52 glyph PNG hashes must be unique');
  const fontFiles = await Promise.all(['autobot', 'decepticon'].map(async (family) => {
    const filePath = path.join(APP_DIRECTORY, 'assets', 'fonts', `cybertron-${family}.woff2`);
    const contents = await readFile(filePath);
    assert.equal(contents.subarray(0, 4).toString('ascii'), 'wOF2');
    return { family, bytes: contents.length, hash: createHash('sha256').update(contents).digest('hex') };
  }));
  assert.notEqual(fontFiles[0].hash, fontFiles[1].hash);

  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'cybertron-edge-'));
  const debuggingPort = await getFreePort();
  const edgeOutput = [];
  let edgeProcess;
  let browserCdp;
  let pageCdp;

  try {
    edgeProcess = spawn(EDGE_PATH, [
      '--headless=new',
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${profileDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      'about:blank',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    edgeProcess.stdout.on('data', (chunk) => edgeOutput.push(chunk.toString()));
    edgeProcess.stderr.on('data', (chunk) => edgeOutput.push(chunk.toString()));

    const version = await waitForDevTools(debuggingPort);
    browserCdp = await CdpClient.connect(version.webSocketDebuggerUrl);
    const { targetId } = await browserCdp.request('Target.createTarget', { url: 'about:blank' });
    await browserCdp.request('Target.activateTarget', { targetId });
    const target = await waitForTarget(debuggingPort, targetId);
    pageCdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    const cdp = pageCdp;
    const sessionId = undefined;
    await Promise.all([
      cdp.request('Page.enable'),
      cdp.request('Runtime.enable'),
      cdp.request('Network.enable'),
    ]);
    await cdp.request('Page.bringToFront');

    const consoleErrors = [];
    const pageExceptions = [];
    const browserRequests = [];
    const downloadEvents = [];
    cdp.on('Runtime.consoleAPICalled', (params, eventSessionId) => {
      if (eventSessionId === sessionId && ['error', 'assert'].includes(params.type)) consoleErrors.push(params);
    });
    cdp.on('Runtime.exceptionThrown', (params, eventSessionId) => {
      if (eventSessionId === sessionId) pageExceptions.push(params.exceptionDetails);
    });
    cdp.on('Network.requestWillBeSent', (params, eventSessionId) => {
      if (eventSessionId === sessionId) browserRequests.push(params.request.url);
    });
    browserCdp.on('Browser.downloadWillBegin', (params) => downloadEvents.push({ method: 'downloadWillBegin', ...params }));
    browserCdp.on('Browser.downloadProgress', (params) => downloadEvents.push({ method: 'downloadProgress', ...params }));

    let downloadBehaviorApi = 'Browser.setDownloadBehavior';
    try {
      await browserCdp.request('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: DOWNLOAD_DIR,
        eventsEnabled: true,
      });
    } catch {
      downloadBehaviorApi = 'Page.setDownloadBehavior';
      await cdp.request('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: DOWNLOAD_DIR,
      }, sessionId);
    }

    const loaded = cdp.waitForEvent('Page.loadEventFired', sessionId, 10_000);
    await cdp.request('Page.navigate', { url: appUrl });
    await loaded;
    const pageState = await waitUntil(
      () => evaluate(cdp, sessionId, `(() => {
        const state = {
          readyState: document.readyState,
          visibilityState: document.visibilityState,
          referenceEntries: document.querySelectorAll('.reference-item').length,
          title: document.title,
        };
        return state.readyState === 'complete' && state.referenceEntries === 26 ? state : false;
      })()`),
      'application initialization',
    );
    assert.equal(pageState.readyState, 'complete');
    assert.equal(pageState.referenceEntries, 26);

    const defaultSize = await evaluate(cdp, sessionId, `(() => {
      const slider = document.querySelector('#target-size');
      return {
        value: slider.value,
        displayed: document.querySelector('#target-size-value').textContent,
        glyphSize: getComputedStyle(document.documentElement).getPropertyValue('--glyph-size').trim(),
      };
    })()`);
    assert.deepEqual(defaultSize, { value: '16', displayed: '16 px', glyphSize: '16px' });

    const viewportContract = await evaluate(cdp, sessionId, `(() => ({
      content: document.querySelector('meta[name="viewport"]')?.content,
      touchAction: getComputedStyle(document.documentElement).touchAction,
      overscrollBehaviorX: getComputedStyle(document.documentElement).overscrollBehaviorX,
    }))()`);
    assert.match(viewportContract.content, /minimum-scale=1/);
    assert.match(viewportContract.content, /maximum-scale=1/);
    assert.match(viewportContract.content, /user-scalable=no/);
    assert.equal(viewportContract.touchAction, 'pan-y');
    assert.equal(viewportContract.overscrollBehaviorX, 'none');

    await evaluate(cdp, sessionId, `(() => {
      const autobot = document.querySelector('input[name="alphabet"][value="autobot"]');
      autobot.checked = true;
      autobot.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);

    const referenceContract = await evaluate(cdp, sessionId, `(() => {
      const dialog = document.querySelector('#reference-dialog');
      const items = [...dialog.querySelectorAll('.reference-item')];
      return {
        titleCount: dialog.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
        title: document.querySelector('#reference-title')?.textContent.trim(),
        redundantCountCopy: dialog.textContent.includes('A-Z / 26'),
        items: items.map((item) => ({
          childTags: [...item.children].map((child) => child.tagName),
          letter: item.querySelector('strong')?.textContent,
          imageAlt: item.querySelector('img')?.alt,
          imageCount: item.querySelectorAll('img').length,
          strongCount: item.querySelectorAll('strong').length,
          text: item.textContent.trim(),
        })),
      };
    })()`);
    assert.equal(referenceContract.titleCount, 1);
    assert.equal(referenceContract.title, '汽车人字表');
    assert.equal(referenceContract.redundantCountCopy, false);
    assert.equal(referenceContract.items.length, 26);
    assert.deepEqual(referenceContract.items.map((item) => item.letter), [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']);
    for (const [index, item] of referenceContract.items.entries()) {
      const letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[index];
      assert.deepEqual(item.childTags, ['STRONG', 'IMG'], `${letter} reference item must contain only strong + img`);
      assert.equal(item.strongCount, 1);
      assert.equal(item.imageCount, 1);
      assert.equal(item.text, letter);
      assert.equal(item.imageAlt, `汽车人 ${letter} 字形`);
    }

    const alphaEvidence = await evaluate(cdp, sessionId, `(async () => {
      const images = [...document.querySelectorAll('.reference-item img')];
      await Promise.all(images.map((image) => image.decode()));
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const assets = [];
      for (const image of images) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        let minAlpha = 255;
        let maxAlpha = 0;
        let transparent = 0;
        let visible = 0;
        let mixed = 0;
        let nonBlackVisible = 0;
        let firstVisibleColumn = image.naturalWidth;
        let lastVisibleColumn = -1;
        for (let y = 0; y < image.naturalHeight; y += 1) {
          for (let x = 0; x < image.naturalWidth; x += 1) {
            const index = (y * image.naturalWidth + x) * 4;
            const alpha = data[index + 3];
            minAlpha = Math.min(minAlpha, alpha);
            maxAlpha = Math.max(maxAlpha, alpha);
            if (alpha === 0) transparent += 1;
            if (alpha > 0) {
              visible += 1;
              firstVisibleColumn = Math.min(firstVisibleColumn, x);
              lastVisibleColumn = Math.max(lastVisibleColumn, x);
              if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 0) nonBlackVisible += 1;
            }
            if (alpha > 0 && alpha < 255) mixed += 1;
          }
        }
        assets.push({
          letter: image.closest('.reference-item').querySelector('strong').textContent,
          width: image.naturalWidth,
          height: image.naturalHeight,
          minAlpha,
          maxAlpha,
          transparent,
          visible,
          mixed,
          nonBlackVisible,
          leftMargin: firstVisibleColumn,
          rightMargin: image.naturalWidth - 1 - lastVisibleColumn,
        });
      }
      return { assets, mixed: assets.reduce((sum, asset) => sum + asset.mixed, 0) };
    })()`);
    assert.equal(alphaEvidence.assets.length, 26);
    assert.deepEqual(alphaEvidence.assets.map((asset) => asset.letter), [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']);
    for (const asset of alphaEvidence.assets) {
      assert.equal(asset.minAlpha, 0, `${asset.letter} must have fully transparent pixels`);
      assert.ok(asset.maxAlpha > 0, `${asset.letter} must have visible pixels`);
      assert.ok(asset.transparent > 0, `${asset.letter} transparent pixel count must be positive`);
      assert.ok(asset.visible > 0, `${asset.letter} visible pixel count must be positive`);
      assert.ok(asset.mixed > 0, `${asset.letter} mixed-alpha pixel count must be positive`);
      assert.equal(asset.nonBlackVisible, 0, `${asset.letter} visible pixels must be pure black`);
      assert.equal(asset.leftMargin, 0, `${asset.letter} left transparent margin must be 0px`);
      assert.equal(asset.rightMargin, 0, `${asset.letter} right transparent margin must be 0px`);
      assert.ok(asset.width > 0 && asset.height > 0, `${asset.letter} dimensions must be positive`);
    }
    assert.ok(alphaEvidence.mixed > 0, 'Glyph set must retain mixed-alpha anti-aliased edges');

    const alphaProofClip = await evaluate(cdp, sessionId, `(async () => {
      const proof = document.createElement('section');
      proof.id = 'alpha-proof';
      proof.style.cssText = 'position:absolute;left:0;top:0;width:720px;padding:24px;background:#f7f7f2;color:#182422;z-index:2147483647;font:700 16px sans-serif';
      const title = document.createElement('div');
      title.textContent = 'TRANSPARENT GLYPH CHECK // A M Z';
      title.style.marginBottom = '14px';
      proof.append(title);
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:16px';
      for (const [label, background] of [['LIGHT', '#f4f2e9'], ['DARK', '#737b82']]) {
        const panel = document.createElement('div');
        panel.style.cssText = 'height:150px;display:flex;align-items:center;justify-content:space-evenly;background:' + background + ';border:1px solid #87928b';
        panel.setAttribute('aria-label', label);
        for (const letter of ['A', 'M', 'Z']) {
          const image = document.createElement('img');
          image.src = './assets/glyphs/autobot/' + letter + '.png';
          image.alt = letter;
          image.style.cssText = 'width:auto;height:92px;object-fit:contain';
          panel.append(image);
        }
        row.append(panel);
      }
      proof.append(row);
      document.body.append(proof);
      await Promise.all([...proof.querySelectorAll('img')].map((image) => image.decode()));
      const rect = proof.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    })()`);
    const transparentGlyphScreenshot = await captureScreenshot(
      cdp,
      sessionId,
      TRANSPARENT_GLYPH_SCREENSHOT,
      alphaProofClip,
    );
    await evaluate(cdp, sessionId, `document.querySelector('#alpha-proof').remove()`);

    const unlimitedInput = await evaluate(cdp, sessionId, `(() => {
      const input = document.querySelector('#source-input');
      input.value = 'A'.repeat(600);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'A'.repeat(600), inputType: 'insertText' }));
      return {
        valueLength: input.value.length,
        maxLength: input.maxLength,
        hasMaxLengthAttribute: input.hasAttribute('maxlength'),
        glyphCount: document.querySelectorAll('.glyph-token').length,
        characterCount: document.querySelector('#character-count').textContent,
        tokenOrder: [...document.querySelectorAll('.glyph-token, .space-token, .newline-token, .literal-token')]
          .map((token) => token.dataset.source).join(''),
      };
    })()`);
    assert.equal(unlimitedInput.valueLength, 600);
    assert.equal(unlimitedInput.maxLength, -1);
    assert.equal(unlimitedInput.hasMaxLengthAttribute, false);
    assert.equal(unlimitedInput.glyphCount, 600);
    assert.equal(unlimitedInput.characterCount, '600 字符');
    assert.equal(unlimitedInput.tokenOrder, 'A'.repeat(600));

    await evaluate(cdp, sessionId, `(() => {
      const input = document.querySelector('#source-input');
      input.value = 'Cybertron';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Cybertron', inputType: 'insertText' }));
    })()`);
    const conversion = await waitUntil(
      () => evaluate(cdp, sessionId, `(async () => {
        await document.fonts.load('16px "Cybertron Autobot"', 'CYBERTRON');
        const glyphs = [...document.querySelectorAll('.glyph-token')];
        const rectangles = glyphs.map((glyph) => glyph.getBoundingClientRect());
        const referenceImages = new Map([...document.querySelectorAll('.reference-item')].map((item) => [
          item.querySelector('strong').textContent,
          item.querySelector('img'),
        ]));
        const sameLineGaps = rectangles.slice(1).map((rect, index) => ({
          previous: rectangles[index],
          current: rect,
        })).filter(({ previous, current }) => Math.abs(previous.top - current.top) < 1)
          .map(({ previous, current }) => current.left - previous.right);
        const state = {
          count: glyphs.length,
          letters: glyphs.map((glyph) => glyph.textContent.toUpperCase()).join(''),
          loaded: document.fonts.check('16px "Cybertron Autobot"', 'CYBERTRON'),
          ariaLabels: glyphs.map((glyph) => glyph.getAttribute('aria-label')),
          imageCount: document.querySelectorAll('.glyph-token img').length,
          smallCount: document.querySelectorAll('.glyph-token small').length,
          widths: rectangles.map((rect) => rect.width),
          naturalWidths: glyphs.map((glyph) => {
            const image = referenceImages.get(glyph.textContent.toUpperCase());
            return image.naturalWidth * 16 / image.naturalHeight;
          }),
          heights: rectangles.map((rect) => rect.height),
          sameLineGaps,
          styles: glyphs.map((glyph) => {
            const style = getComputedStyle(glyph);
            return {
              backgroundColor: style.backgroundColor,
              borderStyle: style.borderStyle,
              padding: style.padding,
              width: style.width,
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              lineHeight: style.lineHeight,
            };
          }),
        };
        return state.count === 9 && state.letters === 'CYBERTRON' && state.loaded ? state : false;
      })()`),
      'Cybertron glyph rendering',
    );
    assert.equal(conversion.count, 9);
    assert.equal(conversion.letters, 'CYBERTRON');
    assert.equal(conversion.imageCount, 0);
    assert.equal(conversion.smallCount, 0);
    assert.ok(conversion.ariaLabels.every((label) => /^汽车人 AUTOBOT [A-Z] 字形$/.test(label)));
    assert.ok(new Set(conversion.widths.map((width) => width.toFixed(2))).size > 1, 'Font glyph widths must vary naturally');
    const compressionRatios = conversion.widths.map((width, index) => width / conversion.naturalWidths[index]);
    assert.ok(compressionRatios.every((ratio) => ratio >= 0.68 && ratio <= 0.74), `Unexpected font compression: ${compressionRatios}`);
    assert.ok(conversion.heights.every((height) => Math.abs(height - 16) < 0.1));
    assert.ok(conversion.sameLineGaps.length > 0);
    assert.ok(conversion.sameLineGaps.every((gap) => gap >= 0 && gap <= 3), `Glyph gaps exceed 3px: ${conversion.sameLineGaps}`);
    assert.ok(conversion.styles.every((style) => style.backgroundColor === 'rgba(0, 0, 0, 0)'
      && style.borderStyle === 'none' && style.padding === '0px'));
    assert.ok(conversion.styles.every((style) => style.fontFamily.includes('Cybertron Autobot')
      && Math.abs(Number.parseFloat(style.fontSize) - 16) < 0.1
      && Math.abs(Number.parseFloat(style.lineHeight) - 16) < 0.1));

    const familySwitch = await evaluate(cdp, sessionId, `(async () => {
      const beforeWidths = [...document.querySelectorAll('.glyph-token')]
        .map((glyph) => glyph.getBoundingClientRect().width);
      const radio = document.querySelector('input[value="decepticon"]');
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      await document.fonts.load('16px "Cybertron Decepticon"', 'CYBERTRON');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const glyphs = [...document.querySelectorAll('.glyph-token')];
      return {
        checked: radio.checked,
        familyLabel: document.querySelector('#target-family-label').textContent,
        referenceTitle: document.querySelector('#reference-title').textContent,
        fontLoaded: document.fonts.check('16px "Cybertron Decepticon"', 'CYBERTRON'),
        fontFamilies: [...new Set(glyphs.map((glyph) => getComputedStyle(glyph).fontFamily))],
        ariaLabels: glyphs.map((glyph) => glyph.getAttribute('aria-label')),
        beforeWidths,
        afterWidths: glyphs.map((glyph) => glyph.getBoundingClientRect().width),
      };
    })()`);
    assert.equal(familySwitch.checked, true);
    assert.equal(familySwitch.familyLabel, '霸天虎字形');
    assert.equal(familySwitch.referenceTitle, '霸天虎字表');
    assert.equal(familySwitch.fontLoaded, true);
    assert.ok(familySwitch.fontFamilies.every((family) => family.includes('Cybertron Decepticon')));
    assert.ok(familySwitch.ariaLabels.every((label) => /^霸天虎 DECEPTICON [A-Z] 字形$/.test(label)));
    assert.notDeepEqual(familySwitch.afterWidths, familySwitch.beforeWidths);

    const factionLogos = await evaluate(cdp, sessionId, `(async () => {
      const coverage = {};
      for (const family of ['autobot', 'decepticon']) {
        const image = new Image();
        image.src = \`./assets/\${family}-logo.png\`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let visiblePixels = 0;
        for (let offset = 3; offset < pixels.length; offset += 4) {
          if (pixels[offset] > 8) visiblePixels += 1;
        }
        coverage[family] = visiblePixels / (pixels.length / 4);
      }
      return {
        coverage,
        alphabet: document.documentElement.dataset.alphabet,
        brandImage: getComputedStyle(document.querySelector('#brand-glyph'), '::before').backgroundImage,
        watermarkImage: getComputedStyle(document.querySelector('.source-pane'), '::before').backgroundImage,
        referenceBorder: getComputedStyle(document.querySelector('#reference-dialog')).borderColor,
        referenceLogo: getComputedStyle(document.querySelector('.dialog-heading'), '::before').backgroundImage,
        brandAccent: getComputedStyle(document.querySelector('.brand-mark'), '::after').backgroundColor,
      };
    })()`);
    assert.ok(factionLogos.coverage.autobot > 0.2, 'Autobot logo must contain visible subject pixels');
    assert.ok(factionLogos.coverage.decepticon > 0.2, 'Decepticon logo must contain visible subject pixels');
    assert.equal(factionLogos.alphabet, 'decepticon');
    assert.match(factionLogos.brandImage, /decepticon-logo\.png/);
    assert.match(factionLogos.watermarkImage, /decepticon-logo\.png/);
    assert.match(factionLogos.referenceLogo, /decepticon-logo\.png/);
    assert.match(factionLogos.referenceBorder, /143, 83, 196/);
    assert.match(factionLogos.brandAccent, /143, 83, 196/);

    const focusedReference = await evaluate(cdp, sessionId, `(() => {
      window.__browserSmokeKeys = [];
      for (const type of ['keydown', 'keyup']) {
        document.addEventListener(type, (event) => window.__browserSmokeKeys.push({
          type: event.type,
          key: event.key,
          code: event.code,
          isTrusted: event.isTrusted,
          target: event.target?.id,
        }), true);
      }
      document.querySelector('#reference-button').focus();
      return document.activeElement?.id;
    })()`);
    assert.equal(focusedReference, 'reference-button');
    await dispatchKey(cdp, sessionId, 'Enter', 'Enter', 13, '\r');
    await delay(100);
    const enterDispatch = await evaluate(cdp, sessionId, `(() => ({
      activeElement: document.activeElement?.id,
      dialogOpen: document.querySelector('#reference-dialog').open,
      documentHasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      events: window.__browserSmokeKeys,
    }))()`);
    assert.ok(
      enterDispatch.events.some((event) => event.type === 'keydown' && event.key === 'Enter' && event.isTrusted),
      `CDP Enter was not delivered as a trusted keydown: ${JSON.stringify(enterDispatch)}`,
    );
    const dialogOpen = await waitUntil(
      () => evaluate(cdp, sessionId, `(() => {
        const state = {
          open: document.querySelector('#reference-dialog').open,
          entries: document.querySelectorAll('#reference-dialog .reference-item').length,
        };
        return state.open && state.entries === 26 ? state : false;
      })()`),
      `reference dialog to open from Enter; dispatch=${JSON.stringify(enterDispatch)}`,
    );
    assert.equal(dialogOpen.open, true);
    assert.equal(dialogOpen.entries, 26);
    await cdp.request('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1440,
      screenHeight: 900,
    }, sessionId);
    await evaluate(cdp, sessionId, 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const referenceScreenshot = await captureScreenshot(cdp, sessionId, REFERENCE_SCREENSHOT, {
      x: 0, y: 0, width: 1440, height: 900,
    });

    await dispatchKey(cdp, sessionId, 'Escape', 'Escape', 27);
    const dialogClosed = await waitUntil(
      () => evaluate(cdp, sessionId, `(() => {
        const state = {
          open: document.querySelector('#reference-dialog').open,
          activeElement: document.activeElement?.id,
        };
        return !state.open && state.activeElement === 'reference-button' ? state : false;
      })()`),
      'reference dialog to close from Escape',
    );
    assert.equal(dialogClosed.open, false);
    assert.equal(dialogClosed.activeElement, 'reference-button');

    await dispatchKey(cdp, sessionId, 'Tab', 'Tab', 9);
    const tabResult = await evaluate(cdp, sessionId, `(() => {
      const active = document.activeElement;
      const style = getComputedStyle(active);
      return {
        id: active?.id,
        tagName: active?.tagName,
        accessibleName: active?.getAttribute('aria-label') || active?.textContent.trim(),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    })()`);
    assert.equal(tabResult.tagName, 'BUTTON');
    assert.notEqual(tabResult.id, 'reference-button');
    assert.ok(tabResult.accessibleName);
    assert.notEqual(tabResult.outlineStyle, 'none');
    assert.ok(Number.parseFloat(tabResult.outlineWidth) > 0);

    await evaluate(cdp, sessionId, `(() => {
      const slider = document.querySelector('#target-size');
      slider.value = '28';
      slider.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
      document.querySelector('#sample-button').click();
    })()`);
    const sampleSource = 'Peace through tyranny!\nDecepticons, transform and rise up!';
    const exportSource = '“Hello,” we\'re\nhere.';
    const sizeEvidence = [];
    for (const size of [8, 28, 52]) {
      const evidence = await evaluate(cdp, sessionId, `(async () => {
        const slider = document.querySelector('#target-size');
        slider.value = '${size}';
        slider.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const tokens = [...document.querySelectorAll('.glyph-token, .space-token, .newline-token, .literal-token')];
        const literals = [...document.querySelectorAll('.literal-token')];
        const literalMetrics = literals.map((literal) => {
          const style = getComputedStyle(literal);
          const rect = literal.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(literal);
          const textRect = range.getBoundingClientRect();
          return {
            value: literal.textContent,
            placement: literal.dataset.placement,
            className: literal.className,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            top: rect.top,
            bottom: rect.bottom,
            textTop: textRect.top,
            textBottom: textRect.bottom,
            backgroundColor: style.backgroundColor,
            borderStyle: style.borderStyle,
            boxShadow: style.boxShadow,
            padding: style.padding,
          };
        });
        const glyphs = [...document.querySelectorAll('.glyph-token')];
        const flowStyle = getComputedStyle(document.querySelector('.token-flow'));
        const rootStyle = getComputedStyle(document.documentElement);
        return {
          slider: { min: slider.min, max: slider.max, step: slider.step, value: slider.value },
          sizeValue: document.querySelector('#target-size-value').textContent,
          value: document.querySelector('#source-input').value,
          glyphs: glyphs.length,
          reconstructed: tokens.map((token) => token.dataset.source).join(''),
          tokenOrder: tokens.map((token) => token.dataset.source).join(''),
          literalOrder: literals.map((literal) => literal.textContent).join(''),
          glyphHeights: glyphs.map((glyph) => glyph.getBoundingClientRect().height),
          literalMetrics,
          lineHeight: flowStyle.lineHeight,
          variables: {
            glyphSize: rootStyle.getPropertyValue('--glyph-size').trim(),
            literalSize: rootStyle.getPropertyValue('--literal-size').trim(),
            lineSize: rootStyle.getPropertyValue('--line-size').trim(),
            glyphGap: rootStyle.getPropertyValue('--glyph-gap').trim(),
            wordGap: rootStyle.getPropertyValue('--word-gap').trim(),
            punctuationLift: rootStyle.getPropertyValue('--punctuation-lift').trim(),
          },
          spaceWidths: [...document.querySelectorAll('.space-token')]
            .map((space) => space.getBoundingClientRect().width),
          buttonBounds: [...document.querySelectorAll('.action-bar button')].map((button) => {
            const rect = button.getBoundingClientRect();
            return { id: button.id, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
          }),
          unsupported: document.querySelectorAll('.unsupported-token').length,
          warningCopy: document.body.innerText.match(/unsupported|不支持|警告/gi) ?? [],
        };
      })()`);
      sizeEvidence.push(evidence);
    }

    const sample = sizeEvidence[1];
    assert.equal(sample.value, sampleSource);
    assert.equal(sample.glyphs, 48);
    assert.equal(sample.reconstructed, sampleSource);
    assert.equal(sample.literalOrder, '!,!');
    assert.equal(sample.unsupported, 0);
    assert.deepEqual(sample.warningCopy, []);
    const expectedPlacements = ['baseline', 'baseline', 'baseline'];
    assert.deepEqual(sample.literalMetrics.map((literal) => literal.placement), expectedPlacements);
    assert.ok(sample.literalMetrics.every((literal) => literal.className.includes(`literal-${literal.placement}`)));
    assert.ok(sample.literalMetrics.every((literal) => literal.backgroundColor === 'rgba(0, 0, 0, 0)'
      && literal.borderStyle === 'none' && literal.boxShadow === 'none' && literal.padding === '0px'));

    for (const [index, size] of [8, 28, 52].entries()) {
      const evidence = sizeEvidence[index];
      assert.deepEqual(evidence.slider, { min: '8', max: '52', step: '1', value: String(size) });
      assert.equal(evidence.sizeValue, `${size} px`);
      assert.equal(evidence.tokenOrder, sampleSource);
      assert.ok(evidence.glyphHeights.every((height) => Math.abs(height - size) < 0.1));
      assert.ok(evidence.literalMetrics.every((literal) => Math.abs(Number.parseFloat(literal.fontSize) - size) < 0.1));
      assert.equal(Number.parseFloat(evidence.lineHeight), Math.round(size * 1.3));
      assert.equal(evidence.variables.glyphSize, `${size}px`);
      assert.equal(evidence.variables.literalSize, `${size}px`);
      assert.equal(evidence.variables.lineSize, `${Math.round(size * 1.3)}px`);
      assert.ok(Number.parseFloat(evidence.variables.glyphGap) >= 1);
      assert.ok(Number.parseFloat(evidence.variables.wordGap) > Number.parseFloat(evidence.variables.glyphGap));
      assert.equal(evidence.variables.punctuationLift, `${Math.max(2, Math.round(size * 0.1))}px`);
      assert.ok(evidence.spaceWidths.every((width) => Math.abs(width - Math.round(size * 0.35)) < 0.1));
      const topLiterals = evidence.literalMetrics.filter((literal) => literal.placement === 'top');
      const baselineLiterals = evidence.literalMetrics.filter((literal) => literal.placement === 'baseline');
      assert.ok(Math.max(...topLiterals.map((literal) => literal.textTop))
        < Math.min(...baselineLiterals.map((literal) => literal.textTop)));
      assert.ok(Math.min(...baselineLiterals.map((literal) => literal.textBottom))
        > Math.max(...topLiterals.map((literal) => literal.textBottom)));
      assert.deepEqual(
        evidence.buttonBounds.map(({ id }) => id),
        sample.buttonBounds.map(({ id }) => id),
        `Action button order must stay stable at ${size}px`,
      );
      for (const [buttonIndex, bounds] of evidence.buttonBounds.entries()) {
        const expected = sample.buttonBounds[buttonIndex];
        for (const property of ['left', 'top', 'width', 'height']) {
          assert.ok(
            Math.abs(bounds[property] - expected[property]) < 0.1,
            `${bounds.id} ${property} must stay stable at ${size}px`,
          );
        }
      }
    }

    await evaluate(cdp, sessionId, `(() => {
      const createObjectURL = URL.createObjectURL.bind(URL);
      window.__browserSmokeBlob = null;
      window.__browserSmokeBlobObject = null;
      window.__browserSmokeFillText = [];
      window.__browserSmokeStrokeRects = [];
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      const strokeRect = CanvasRenderingContext2D.prototype.strokeRect;
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
        window.__browserSmokeFillText.push(String(text));
        return fillText.call(this, text, ...args);
      };
      CanvasRenderingContext2D.prototype.strokeRect = function (...args) {
        window.__browserSmokeStrokeRects.push(args);
        return strokeRect.call(this, ...args);
      };
      URL.createObjectURL = (blob) => {
        window.__browserSmokeBlob = { type: blob.type, size: blob.size };
        window.__browserSmokeBlobObject = blob;
        return createObjectURL(blob);
      };
      const slider = document.querySelector('#target-size');
      slider.value = '16';
      slider.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
      const input = document.querySelector('#source-input');
      input.value = '“Hello,” we\\'re\\nhere.';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      document.querySelector('#export-button').click();
    })()`);

    const downloadPath = path.join(DOWNLOAD_DIR, DOWNLOAD_NAME);
    const downloadEvidence = await waitUntil(async () => {
      const files = await readdir(DOWNLOAD_DIR);
      const begin = downloadEvents.find((event) => event.method === 'downloadWillBegin'
        && event.suggestedFilename === DOWNLOAD_NAME);
      const completed = begin && downloadEvents.find((event) => event.method === 'downloadProgress'
        && event.guid === begin.guid && event.state === 'completed');
      if (!begin || !completed || !files.includes(DOWNLOAD_NAME)
        || files.some((file) => file.endsWith('.crdownload'))) return false;
      const fileStats = await stat(downloadPath);
      return fileStats.size > 0 ? { begin, completed, files, bytes: fileStats.size } : false;
    }, 'completed browser download and final PNG file', 12_000);
    assert.equal(downloadEvidence.begin.suggestedFilename, DOWNLOAD_NAME);

    const png = await readFile(downloadPath);
    const signature = png.subarray(0, 8).toString('hex');
    assert.equal(signature, PNG_SIGNATURE);
    assert.ok(png.length > 0);
    const blobEvidence = await waitUntil(
      () => evaluate(cdp, sessionId, 'window.__browserSmokeBlob'),
      'export Blob evidence',
    );
    assert.equal(blobEvidence.type, 'image/png');
    assert.equal(blobEvidence.size, png.length);
    const exportLayout = await evaluate(cdp, sessionId, `({
      layout: window.__lastExportLayout,
      fillText: window.__browserSmokeFillText,
      strokeRects: window.__browserSmokeStrokeRects,
    })`);
    assert.equal(exportLayout.layout.tokenOrder, exportSource);
    assert.equal(exportLayout.layout.selectedSize, 16);
    assert.equal(exportLayout.layout.glyphHeight, 16);
    assert.equal(exportLayout.layout.literalSize, 16);
    assert.equal(exportLayout.layout.literalFont.startsWith('16px '), true);
    assert.equal(exportLayout.layout.alphabetId, 'decepticon');
    assert.equal(exportLayout.layout.glyphFont, '16px "Cybertron Decepticon"');
    assert.equal(exportLayout.layout.glyphGap, 1);
    assert.equal(exportLayout.layout.wordGap, 6);
    assert.equal(exportLayout.layout.punctuationLift, 2);
    assert.equal(exportLayout.layout.lineHeight, 21);
    assert.equal(exportLayout.layout.background, '#fdfdfb');
    assert.equal(exportLayout.layout.recognitionMarker, 'CYIMG1');
    assert.equal(exportLayout.layout.entries.filter((entry) => entry.type === 'glyph').length, 13);
    const exportedLiterals = exportLayout.layout.entries.filter((entry) => entry.type === 'literal');
    assert.equal(exportedLiterals.map((entry) => entry.value).join(''), '“,”\'.');
    assert.deepEqual(
      exportedLiterals.map((entry) => entry.placement),
      ['top', 'baseline', 'top', 'top', 'baseline'],
    );
    assert.deepEqual(
      exportLayout.fillText,
      [...exportSource].filter((character) => character !== ' ' && character !== '\n'),
    );
    assert.equal(exportLayout.strokeRects.length, 0, 'Export must not draw warning boxes or decorative frames');
    const newlineIndex = exportLayout.layout.entries.findIndex((entry) => entry.type === 'newline');
    assert.ok(newlineIndex >= 0, 'Export layout must retain the explicit newline token');
    assert.equal(
      exportLayout.layout.entries[newlineIndex + 1].lineIndex,
      exportLayout.layout.entries[newlineIndex].lineIndex + 1,
    );

    await evaluate(cdp, sessionId, `(() => {
      document.querySelector('#direction-button').click();
      const file = new File([window.__browserSmokeBlobObject], 'cybertron-decepticon.png', { type: 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const recognitionInput = document.querySelector('#recognition-input');
      recognitionInput.files = transfer.files;
      recognitionInput.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const reverseRecognition = await waitUntil(
      () => evaluate(cdp, sessionId, `(() => {
        const recognition = window.__lastRecognition;
        if (!recognition || recognition.source !== 'verified-marker') return false;
        const input = document.querySelector('#source-input');
        return {
          ...recognition,
          output: document.querySelector('.english-output')?.textContent,
          status: document.querySelector('#recognition-status').textContent,
          direction: document.documentElement.dataset.direction,
          inputHidden: input.hidden,
          inputDisabled: input.disabled,
          enabledTextareas: document.querySelectorAll('textarea:not([disabled])').length,
          recognitionPanelHidden: document.querySelector('#recognition-panel').hidden,
          recognitionInputValue: document.querySelector('#recognition-input').value,
          selectorParent: document.querySelector('#alphabet-selector').parentElement.id,
          glyphCount: document.querySelector('#glyph-count').textContent,
          sampleLabel: document.querySelector('#sample-action-label').textContent,
          primaryLabel: document.querySelector('#primary-action-label').textContent,
          clearVisible: !document.querySelector('#clear-button').hidden,
          sizeVisible: getComputedStyle(document.querySelector('.size-control')).visibility !== 'hidden',
          referenceVisible: !document.querySelector('#reference-button').hidden,
          primaryVisible: !document.querySelector('#export-button').hidden,
          visibleActionIcons: document.querySelectorAll('.action-bar .button-icon:not([hidden])').length,
          copyIconHidden: document.querySelector('[data-icon="copy"]').hasAttribute('hidden'),
          downloadIconHidden: document.querySelector('[data-icon="download"]').hasAttribute('hidden'),
          outputFontSize: getComputedStyle(document.querySelector('.english-output')).fontSize,
          outputLineHeight: getComputedStyle(document.querySelector('.english-output')).lineHeight,
        };
      })()`),
      'verified image marker recognition',
      12_000,
    );
    assert.equal(reverseRecognition.source, 'verified-marker');
    assert.equal(reverseRecognition.rawText, exportSource);
    assert.equal(reverseRecognition.text, '“Hello,” we\'re\nHere.');
    assert.equal(reverseRecognition.output, reverseRecognition.text);
    assert.equal(reverseRecognition.lineCount, 2);
    assert.equal(reverseRecognition.size, 16);
    assert.equal(reverseRecognition.confidence, 1);
    assert.equal(reverseRecognition.uncertainCount, 0);
    assert.equal(reverseRecognition.status, '已精确恢复 18 个字符，校验通过');
    assert.equal(reverseRecognition.direction, 'cybertron-to-english');
    assert.equal(reverseRecognition.inputHidden, true);
    assert.equal(reverseRecognition.inputDisabled, true);
    assert.equal(reverseRecognition.enabledTextareas, 0);
    assert.equal(reverseRecognition.recognitionPanelHidden, false);
    assert.equal(reverseRecognition.recognitionInputValue, '');
    assert.equal(reverseRecognition.selectorParent, 'source-language');
    assert.equal(reverseRecognition.glyphCount, '18 个字形');
    assert.equal(reverseRecognition.sampleLabel, '示例');
    assert.equal(reverseRecognition.primaryLabel, '复制译文');
    assert.equal(reverseRecognition.clearVisible, true);
    assert.equal(reverseRecognition.sizeVisible, true);
    assert.equal(reverseRecognition.referenceVisible, true);
    assert.equal(reverseRecognition.primaryVisible, true);
    assert.equal(reverseRecognition.visibleActionIcons, 4);
    assert.equal(reverseRecognition.copyIconHidden, false);
    assert.equal(reverseRecognition.downloadIconHidden, true);
    assert.equal(reverseRecognition.outputFontSize, '16px');
    assert.equal(reverseRecognition.outputLineHeight, '25.6px');

    const cycledRecognition = await evaluate(cdp, sessionId, `(() => {
      document.querySelector('#direction-button').click();
      document.querySelector('#direction-button').click();
      return {
        direction: document.documentElement.dataset.direction,
        output: document.querySelector('.english-output')?.textContent,
      };
    })()`);
    assert.equal(cycledRecognition.direction, 'cybertron-to-english');
    assert.equal(cycledRecognition.output, reverseRecognition.text);

    await evaluate(cdp, sessionId, `document.querySelector('#sample-button').click()`);
    const decepticonSample = await waitUntil(
      () => evaluate(cdp, sessionId, `(() => {
        const recognition = window.__lastRecognition;
        return recognition?.rawText === 'Peace through tyranny!\\nDecepticons, transform and rise up!'
          ? recognition
          : false;
      })()`),
      'Decepticon reverse-translation sample',
      12_000,
    );
    assert.equal(decepticonSample.source, 'verified-marker');
    assert.equal(decepticonSample.lineCount, 2);
    assert.equal(decepticonSample.text, 'Peace through tyranny!\nDecepticons, transform and rise up!');

    await evaluate(cdp, sessionId, `(() => {
      const autobot = document.querySelector('input[name="alphabet"][value="autobot"]');
      autobot.checked = true;
      autobot.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#sample-button').click();
    })()`);
    const autobotSample = await waitUntil(
      () => evaluate(cdp, sessionId, `(() => {
        const recognition = window.__lastRecognition;
        return recognition?.rawText === 'Freedom is the right of all sentient beings.\\nAutobots, roll out!'
          ? recognition
          : false;
      })()`),
      'Autobot reverse-translation sample',
      12_000,
    );
    assert.equal(autobotSample.source, 'verified-marker');
    assert.equal(autobotSample.lineCount, 2);
    assert.equal(autobotSample.text, 'Freedom is the right of all sentient beings.\nAutobots, roll out!');

    await evaluate(cdp, sessionId, `(() => {
      const decepticon = document.querySelector('input[name="alphabet"][value="decepticon"]');
      decepticon.checked = true;
      decepticon.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);

    const softWrapSource = 'THIS IS A LONG SENTENCE THAT WRAPS AUTOMATICALLY.';
    await evaluate(cdp, sessionId, `(() => {
      document.querySelector('#direction-button').click();
      const output = document.querySelector('#output');
      output.style.width = '180px';
      const input = document.querySelector('#source-input');
      input.value = '${softWrapSource}';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: input.value, inputType: 'insertText' }));
      window.__browserSmokeBlobObject = null;
      window.__browserSmokeAnchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = () => {};
      document.querySelector('#export-button').click();
    })()`);
    const softWrapExport = await waitUntil(
      () => evaluate(cdp, sessionId, `(() => {
        const layout = window.__lastExportLayout;
        const blob = window.__browserSmokeBlobObject;
        if (!blob || layout?.tokenOrder !== '${softWrapSource}') return false;
        return {
          visualLines: Math.max(...layout.entries.map((entry) => entry.lineIndex)) + 1,
          logicalText: layout.tokenOrder,
          containsLogicalNewline: layout.tokenOrder.includes('\\n'),
        };
      })()`),
      'soft-wrapped export Blob',
    );
    assert.ok(softWrapExport.visualLines > 1, 'Soft-wrap test must span multiple visual lines');
    assert.equal(softWrapExport.logicalText, softWrapSource);
    assert.equal(softWrapExport.containsLogicalNewline, false);

    await evaluate(cdp, sessionId, `(() => {
      HTMLAnchorElement.prototype.click = window.__browserSmokeAnchorClick;
      document.querySelector('#direction-button').click();
      const file = new File([window.__browserSmokeBlobObject], 'soft-wrap.png', { type: 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const recognitionInput = document.querySelector('#recognition-input');
      recognitionInput.files = transfer.files;
      recognitionInput.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const softWrapRecognition = await waitUntil(
      () => evaluate(cdp, sessionId, `(() => {
        const recognition = window.__lastRecognition;
        return recognition?.rawText === '${softWrapSource}' ? recognition : false;
      })()`),
      'soft-wrapped image recognition',
      12_000,
    );
    assert.equal(softWrapRecognition.source, 'verified-marker');
    assert.equal(softWrapRecognition.rawText, softWrapSource);
    assert.equal(softWrapRecognition.text, 'This is a long sentence that wraps automatically.');
    assert.equal(softWrapRecognition.rawText.includes('\n'), false);
    assert.equal(softWrapRecognition.lineCount, 1);

    await evaluate(cdp, sessionId, `(() => {
      document.querySelector('#direction-button').click();
      document.querySelector('#output').style.width = '';
    })()`);

    await evaluate(cdp, sessionId, `document.querySelector('#clear-button').click()`);
    const emptyState = await waitUntil(
      () => evaluate(cdp, sessionId, `(() => {
        const state = {
          value: document.querySelector('#source-input').value,
          glyphs: document.querySelectorAll('.glyph-token').length,
          hasEmptyMessage: Boolean(document.querySelector('.empty-output')),
          characterCount: document.querySelector('#character-count').textContent,
          literalCount: document.querySelectorAll('.literal-token').length,
        };
        return state.value === '' && state.glyphs === 0 && state.hasEmptyMessage
          && state.characterCount === '0 字符' && state.literalCount === 0
          ? state
          : false;
      })()`),
      'clear and empty state',
    );
    assert.equal(emptyState.value, '');
    assert.equal(emptyState.glyphs, 0);
    assert.equal(emptyState.hasEmptyMessage, true);
    assert.equal(emptyState.characterCount, '0 字符');
    assert.equal(emptyState.literalCount, 0);

    await evaluate(cdp, sessionId, `(() => {
      const slider = document.querySelector('#target-size');
      slider.value = '28';
      slider.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
      document.querySelector('#sample-button').click();
    })()`);
    await waitUntil(
      () => evaluate(cdp, sessionId, `!document.querySelector('#toast').classList.contains('is-visible')`),
      'toast to clear before README screenshots',
    );
    const desktop = await collectLayout(cdp, sessionId, 1440, 900, false);
    const desktopScreenshot = await captureScreenshot(cdp, sessionId, DESKTOP_SCREENSHOT, {
      x: 0, y: 0, width: 1440, height: 900,
    });
    await evaluate(cdp, sessionId, `(() => {
      document.querySelector('#direction-button').click();
      document.querySelector('#sample-button').click();
    })()`);
    await waitUntil(
      () => evaluate(cdp, sessionId, `window.__lastRecognition?.rawText === 'Peace through tyranny!\\nDecepticons, transform and rise up!'`),
      'reverse README sample',
      12_000,
    );
    await collectLayout(cdp, sessionId, 1440, 900, false);
    const reverseDesktopScreenshot = await captureScreenshot(cdp, sessionId, REVERSE_DESKTOP_SCREENSHOT, {
      x: 0, y: 0, width: 1440, height: 900,
    });
    await evaluate(cdp, sessionId, `(() => {
      document.querySelector('#direction-button').click();
      document.querySelector('#sample-button').click();
    })()`);
    const mobile = await collectLayout(cdp, sessionId, 390, 844, true);
    const mobileScreenshot = await captureScreenshot(cdp, sessionId, MOBILE_SCREENSHOT, {
      x: 0, y: 0, width: 390, height: 844,
    });
    await evaluate(cdp, sessionId, `(() => {
      document.querySelector('#direction-button').click();
      document.querySelector('#sample-button').click();
    })()`);
    await waitUntil(
      () => evaluate(cdp, sessionId, `window.__lastRecognition?.rawText === 'Peace through tyranny!\\nDecepticons, transform and rise up!'`),
      'reverse mobile README sample',
      12_000,
    );
    const reverseMobileScreenshot = await captureScreenshot(cdp, sessionId, REVERSE_MOBILE_SCREENSHOT, {
      x: 0, y: 0, width: 390, height: 844,
    });
    await evaluate(cdp, sessionId, `document.querySelector('#direction-button').click()`);
    const compactDesktop = await collectLayout(cdp, sessionId, 1366, 768, false);
    const narrowMobile = await collectLayout(cdp, sessionId, 320, 720, true);
    const iphone14ProMax = await collectLayout(cdp, sessionId, 430, 932, true);
    for (const metrics of [desktop, compactDesktop, mobile, narrowMobile, iphone14ProMax]) {
      assert.ok(metrics.scrollWidth <= metrics.clientWidth, `Horizontal overflow at ${metrics.requested.width}x${metrics.requested.height}`);
      assert.deepEqual(metrics.clippedControls, [], `Clipped controls at ${metrics.requested.width}x${metrics.requested.height}`);
      assert.deepEqual(metrics.overlaps, [], `Visible button overlap at ${metrics.requested.width}x${metrics.requested.height}`);
      assert.deepEqual(metrics.outOfBounds, [], `Visible button outside viewport at ${metrics.requested.width}x${metrics.requested.height}`);
      assert.deepEqual(metrics.sectionOverlaps, [], `Layout section overlap at ${metrics.requested.width}x${metrics.requested.height}`);
      assert.equal(metrics.outputOverflow, false, `Output overflow at ${metrics.requested.width}x${metrics.requested.height}`);
      assert.equal(metrics.visualSystem.sampleClipPath, 'none', `Sample button must not use a clipped hit area at ${metrics.requested.width}x${metrics.requested.height}`);
      assert.equal(metrics.visualSystem.sampleBeforeDisplay, 'none', `Sample button must not have a covering before layer at ${metrics.requested.width}x${metrics.requested.height}`);
      assert.equal(metrics.visualSystem.sampleAfterDisplay, 'none', `Sample button must not have a covering after layer at ${metrics.requested.width}x${metrics.requested.height}`);
      assert.equal(metrics.visualSystem.watermarkPosition, '50% 50%', `Faction watermark must be centered at ${metrics.requested.width}x${metrics.requested.height}`);
      assert.equal(metrics.visualSystem.brandContained, true, `Brand logo must remain inside its frame at ${metrics.requested.width}x${metrics.requested.height}`);
      assert.equal(metrics.workspace.targetNearWhite, true, `Target must be near-white at ${metrics.requested.width}x${metrics.requested.height}`);
      assert.equal(metrics.visualSystem.primaryMatchesFaction, true, `Primary action must match the faction accent at ${metrics.requested.width}x${metrics.requested.height}`);
      assert.ok(metrics.visualSystem.primaryContrast >= 4.5, `Primary action contrast must be >= 4.5 at ${metrics.requested.width}x${metrics.requested.height}`);
    }
    assert.ok(desktop.scrollHeight <= desktop.innerHeight, 'Page must fit within a 1440x900 desktop viewport');
    assert.ok(compactDesktop.scrollHeight <= compactDesktop.innerHeight, 'Page must fit within a 1366x768 desktop viewport');
    assert.ok(desktop.workspace.sourcePane.height > compactDesktop.workspace.sourcePane.height, 'Desktop panes must grow with available viewport height');
    assert.ok(Math.abs(desktop.workspace.sourcePane.top - desktop.workspace.targetPane.top) < 0.5);
    assert.ok(Math.abs(desktop.workspace.sourcePane.width - desktop.workspace.targetPane.width) < 0.5);
    assert.ok(Math.abs(desktop.workspace.sourcePane.height - desktop.workspace.targetPane.height) < 0.5);
    assert.ok(desktop.workspace.sourcePane.left < desktop.workspace.targetPane.left);
    assert.ok(desktop.workspace.sourceLanguage.left < desktop.workspace.targetLanguage.left);
    assert.ok(mobile.workspace.targetPane.top >= mobile.workspace.sourcePane.bottom - 0.5);
    assert.ok(Math.abs(mobile.workspace.sourcePane.width - mobile.workspace.targetPane.width) < 0.5);
    assert.match(mobile.visualSystem.watermarkSize, /^auto /, 'Stacked layout watermark must be constrained by pane height');
    assert.ok(narrowMobile.workspace.targetPane.top >= narrowMobile.workspace.sourcePane.bottom - 0.5);

    const directionChrome = await evaluate(cdp, sessionId, `(() => ({
      primaryLabel: document.querySelector('#primary-action-label').textContent,
      targetBorderLeftWidth: getComputedStyle(document.querySelector('.target-language')).borderLeftWidth,
    }))()`);
    assert.equal(directionChrome.primaryLabel, '导出图片');
    assert.equal(directionChrome.targetBorderLeftWidth, '0px');

    await evaluate(cdp, sessionId, `document.querySelector('#direction-button').click()`);
    const reverseNarrow = await collectLayout(cdp, sessionId, 560, 760, true);
    const reverseSmallest = await collectLayout(cdp, sessionId, 320, 720, true);
    for (const metrics of [reverseNarrow, reverseSmallest]) {
      assert.equal(
        metrics.workspace.directionSelectorOverlap,
        0,
        `Direction control must not overlap the alphabet selector at ${metrics.requested.width}px`,
      );
      assert.deepEqual(metrics.clippedControls, [], `Reverse controls clipped at ${metrics.requested.width}px`);
      assert.deepEqual(metrics.overlaps, [], `Reverse buttons overlap at ${metrics.requested.width}px`);
      assert.deepEqual(metrics.outOfBounds, [], `Reverse button outside viewport at ${metrics.requested.width}px`);
    }

    await delay(250);
    const externalRequests = browserRequests.filter((url) => {
      try {
        const requestUrl = new URL(url);
        return ['http:', 'https:'].includes(requestUrl.protocol) && requestUrl.origin !== new URL(appUrl).origin;
      } catch {
        return false;
      }
    });
    assert.deepEqual(externalRequests, []);
    assert.equal(consoleErrors.length, 0, 'Expected no console errors or failed assertions');
    assert.equal(pageExceptions.length, 0, 'Expected no page exceptions');

    return {
      result: 'PASS',
      edge: { path: EDGE_PATH, version: version.Browser },
      server: { url: appUrl, root: APP_DIRECTORY },
      page: {
        url: appUrl,
        title: pageState.title,
        visibilityState: pageState.visibilityState,
        consoleErrors: consoleErrors.length,
        pageExceptions: pageExceptions.length,
        externalRequests: externalRequests.length,
        localRequests: browserRequests.length,
      },
      alpha: {
        assets: alphaEvidence.assets.length,
        uniqueHashes: new Set(glyphHashes).size,
        mixedPixels: alphaEvidence.mixed,
        representative: alphaEvidence.assets.filter((asset) => ['A', 'M', 'Z'].includes(asset.letter)),
      },
      unlimitedInput,
      conversion,
      familySwitch,
      recognition: {
        explicitNewline: reverseRecognition,
        softWrapExport,
        softWrap: softWrapRecognition,
      },
      fonts: fontFiles,
      prose: sample,
      typography: sizeEvidence,
      keyboard: {
        enterOpenedDialog: dialogOpen.open,
        referenceEntries: dialogOpen.entries,
        escapeClosedDialog: !dialogClosed.open,
        focusReturnedTo: dialogClosed.activeElement,
        tab: tabResult,
        trustedEvents: await evaluate(cdp, sessionId, 'window.__browserSmokeKeys'),
      },
      download: {
        api: downloadBehaviorApi,
        path: downloadPath,
        filename: downloadEvidence.begin.suggestedFilename,
        bytes: png.length,
        signature,
        mime: blobEvidence.type,
        eventStates: downloadEvents
          .filter((event) => event.guid === downloadEvidence.begin.guid)
          .map((event) => event.state ?? event.method),
        temporaryFiles: downloadEvidence.files.filter((file) => file.endsWith('.crdownload')),
        layout: exportLayout,
      },
      emptyState,
      viewports: { desktop, mobile },
      screenshots: {
        desktop: desktopScreenshot,
        mobile: mobileScreenshot,
        reverseDesktop: reverseDesktopScreenshot,
        reverseMobile: reverseMobileScreenshot,
        reference: referenceScreenshot,
        transparentGlyph: transparentGlyphScreenshot,
      },
    };
  } catch (error) {
    const output = edgeOutput.join('').trim();
    if (output) error.message += `\nEdge output:\n${output.slice(-4_000)}`;
    throw error;
  } finally {
    pageCdp?.close();
    browserCdp?.close();
    await terminateProcessTree(edgeProcess);
    await removeProfile(profileDirectory);
    await closeServer(staticServer.server);
  }
}

try {
  const summary = await withTimeout(runSmoke(), SESSION_TIMEOUT_MS, 'browser smoke session');
  const output = process.env.BROWSER_SMOKE_COMPACT === '1'
    ? {
        result: summary.result,
        fonts: summary.fonts.map(({ family, bytes }) => ({ family, bytes })),
        familySwitch: {
          familyLabel: summary.familySwitch.familyLabel,
          fontLoaded: summary.familySwitch.fontLoaded,
        },
        download: {
          filename: summary.download.filename,
          bytes: summary.download.bytes,
          signature: summary.download.signature,
        },
        runtime: {
          consoleErrors: summary.page.consoleErrors,
          pageExceptions: summary.page.pageExceptions,
          externalRequests: summary.page.externalRequests,
        },
        overflow: {
          desktop: summary.viewports.desktop.outputOverflow,
          mobile: summary.viewports.mobile.outputOverflow,
        },
      }
    : summary;
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error('browser-smoke: FAIL');
  console.error(error?.stack ?? error);
  process.exitCode = 1;
}