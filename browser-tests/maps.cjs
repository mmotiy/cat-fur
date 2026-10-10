'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');

const baseUrl = process.env.PW_BASE_URL || 'http://127.0.0.1:8734';
const sourceFile = process.env.PW_FILE_PATH ||
    path.join(__dirname, '../index.html');
const outputDir = path.join(__dirname, 'test-output/maps');
const executablePath = process.env.PW_EXECUTABLE_PATH;
fs.mkdirSync(outputDir, {recursive: true});

function pixelDiff(first, second) {
  assert.equal(first.width, second.width, 'Canvas pixel width changed');
  assert.equal(first.height, second.height, 'Canvas pixel height changed');
  let changed = 0;
  let totalDelta = 0;
  let maxDelta = 0;
  for (let offset = 0; offset < first.data.length; offset += 4) {
    let pixelDelta = 0;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(first.data[offset + channel] -
          second.data[offset + channel]);
      totalDelta += delta;
      pixelDelta = Math.max(pixelDelta, delta);
    }
    if (pixelDelta > 3) changed++;
    maxDelta = Math.max(maxDelta, pixelDelta);
  }
  return {
    changedFraction: changed / (first.width * first.height),
    meanChannelDelta: totalDelta / first.data.length,
    maxDelta,
  };
}

function assertDifferent(difference, description) {
  assert(difference.changedFraction > 0.0001 &&
      difference.meanChannelDelta > 0.001,
  `${description}: ${JSON.stringify(difference)}`);
}

function assertSame(difference, description) {
  assert(difference.changedFraction < 0.00001 &&
      difference.meanChannelDelta < 0.001,
  `${description}: ${JSON.stringify(difference)}`);
}

async function diagnostics(page) {
  return page.evaluate(() => window.furApp.getDiagnostics());
}

async function waitFrames(page, count = 3) {
  await page.evaluate(async (frames) => {
    for (let i = 0; i < frames; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, count);
}

async function setRange(page, selector, value) {
  await page.locator(selector).evaluate((input, next) => {
    input.value = String(next);
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  }, value);
  await waitFrames(page);
}

async function setMaps(page, enabled) {
  await page.locator('#maps').selectOption(enabled ? 'on' : 'off');
  await page.waitForFunction((next) =>
    window.furApp.getDiagnostics().mapsEnabled === next, enabled);
  await waitFrames(page);
}

async function setFur(page, enabled) {
  if ((await diagnostics(page)).furEnabled !== enabled) {
    await page.locator('#toggle').click();
  }
  await page.waitForFunction((next) =>
    window.furApp.getDiagnostics().furEnabled === next, enabled);
  await waitFrames(page);
}

async function freezeMotion(page) {
  await setRange(page, '#wind', 0);
  await setRange(page, '#strength', 0);
  const maximum = await page.locator('#grow').getAttribute('max');
  await setRange(page, '#grow', maximum === null ? 1 : Number(maximum));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(350);
  await waitFrames(page);
}

async function capture(page, name) {
  const dataUrl = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return document.querySelector('#gl').toDataURL('image/png');
  });
  const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(path.join(outputDir, `${name}.png`), buffer);
  return PNG.sync.read(buffer);
}

async function glState(page) {
  return page.evaluate(() => {
    const gl = document.querySelector('#gl').getContext('webgl2');
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: gl.getParameter(extension ?
        extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      error: gl.getError(),
      contextLost: gl.isContextLost(),
    };
  });
}

function assertAvailable(state) {
  assert.equal(state.mapsAvailable, true, 'Default material maps are unavailable');
  assert.equal(state.mapsEnabled, true, 'Default material maps are disabled');
  assert.deepEqual(state.mapSources?.normal, [1400, 1749]);
  assert.deepEqual(state.mapSources?.height, [1400, 1749]);
  assert(state.strands > 100, 'No visible fur strands');
  assert(state.mappedStrands > 100, 'Maps were not sampled on fur strands');
  assert(state.mappedStrands <= state.strands, 'Mapped count exceeds strand count');
  assert(!state.lastError, 'Application reported an error');
}

function createTransparentFixture() {
  const width = 257;
  const height = 241;
  const png = new PNG({width, height});
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x > 84 && x < 173 && y > 73 && y < 168;
      png.data.set(inside ? [187, 81, 48, 255] : [12, 240, 196, 0],
          (y * width + x) * 4);
    }
  }
  return {name: 'map-isolation-transparent.png', mimeType: 'image/png',
    buffer: PNG.sync.write(png)};
}

async function main() {
  const browser = await chromium.launch({
    headless: process.env.PW_HEADED !== '1',
    ...(executablePath ? {executablePath} : {channel: 'chromium'}),
    args: process.platform === 'win32' ? ['--use-angle=d3d11'] : [],
  });
  const context = await browser.newContext({
    viewport: {width: 1500, height: 1050}, deviceScaleFactor: 1,
  });
  await context.tracing.start({screenshots: true, snapshots: true});
  const results = [];
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const failedResponses = [];
  const glErrors = [];
  const requests = [];
  context.on('page', (newPage) => {
    newPage.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    newPage.on('pageerror', (error) => pageErrors.push(error.message));
    newPage.on('request', (request) => requests.push(request.url()));
    newPage.on('requestfailed', (request) => requestFailures.push({
      url: request.url(), error: request.failure()?.errorText,
    }));
    newPage.on('response', (response) => {
      if (response.status() >= 500) {
        failedResponses.push({url: response.url(), status: response.status()});
      }
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  let originalMapped;

  async function check(name, operation) {
    const start = Date.now();
    try {
      const evidence = await operation();
      const gl = await glState(page);
      if (gl.error || gl.contextLost) glErrors.push({name, ...gl});
      assert.equal(gl.error, 0, 'WebGL reported an error');
      assert.equal(gl.contextLost, false, 'WebGL context was lost');
      results.push({name, passed: true, elapsedMs: Date.now() - start, evidence});
      console.log(`PASS ${name}`);
    } catch (error) {
      const screenshot = `${name}-failure.png`;
      await page.screenshot({path: path.join(outputDir, screenshot), fullPage: true})
          .catch(() => {});
      results.push({name, passed: false, elapsedMs: Date.now() - start,
        error: error.stack || error.message, screenshot});
      console.log(`FAIL ${name}: ${error.message}`);
    }
  }

  try {
    await page.goto(baseUrl, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => window.furApp?.getDiagnostics().ready);

    await check('default-maps-loaded-and-hardware-rendered', async () => {
      const state = await diagnostics(page);
      assertAvailable(state);
      assert.equal(await page.locator('#maps').inputValue(), 'on');
      assert.equal(state.normalStrength, 0.65);
      assert.equal(state.heightStrength, 0.65);
      for (const selector of ['#maps', '#normal-strength', '#height-strength']) {
        assert(await page.locator(selector).isEnabled(), `${selector} is disabled`);
      }
      const gl = await glState(page);
      assert(/D3D11/i.test(gl.renderer), `Not hardware D3D11: ${gl.renderer}`);
      assert(!/SwiftShader|Microsoft Basic Render/i.test(gl.renderer),
          `Software renderer: ${gl.renderer}`);
      await freezeMotion(page);
      originalMapped = await capture(page, 'default-maps-on');
      await page.screenshot({path: path.join(outputDir, 'default-page.png')});
      return {diagnostics: state, gl};
    });

    await check('maps-switch-changes-pixels-and-restores-exactly', async () => {
      await setMaps(page, false);
      const procedural = await capture(page, 'maps-off');
      const difference = pixelDiff(originalMapped, procedural);
      assertDifferent(difference, 'Map switch has no visible effect');
      await setMaps(page, true);
      const restored = await capture(page, 'maps-on-restored');
      const restoredDifference = pixelDiff(originalMapped, restored);
      assertSame(restoredDifference, 'Switching back changes the stable seed');
      return {difference, restoredDifference};
    });

    await check('normal-map-alone-changes-visible-pixels', async () => {
      await setRange(page, '#height-strength', 0);
      await setRange(page, '#normal-strength', 0);
      const zero = await capture(page, 'both-strengths-zero');
      await setRange(page, '#normal-strength', 100);
      const normal = await capture(page, 'normal-only-full');
      const difference = pixelDiff(zero, normal);
      assertDifferent(difference, 'Normal influence is inert');
      return {difference, diagnostics: await diagnostics(page)};
    });

    await check('height-map-alone-changes-visible-pixels', async () => {
      await setRange(page, '#normal-strength', 0);
      await setRange(page, '#height-strength', 0);
      const zero = await capture(page, 'height-zero');
      await setRange(page, '#height-strength', 100);
      const height = await capture(page, 'height-only-full');
      const difference = pixelDiff(zero, height);
      assertDifferent(difference, 'Height influence is inert');
      return {difference, diagnostics: await diagnostics(page)};
    });

    await check('disabled-maps-match-zero-map-strengths', async () => {
      await setRange(page, '#normal-strength', 0);
      await setRange(page, '#height-strength', 0);
      const zero = await capture(page, 'zero-map-strengths');
      await setRange(page, '#normal-strength', 100);
      await setRange(page, '#height-strength', 100);
      await setMaps(page, false);
      const disabled = await capture(page, 'disabled-maps-full-controls');
      const difference = pixelDiff(zero, disabled);
      assertSame(difference, 'Disabled maps differ from the procedural baseline');
      return difference;
    });

    await check('original-image-is-unaffected-by-material-maps', async () => {
      await setFur(page, false);
      const off = await capture(page, 'original-maps-off');
      await setMaps(page, true);
      const on = await capture(page, 'original-maps-on');
      const difference = pixelDiff(off, on);
      assertSame(difference, 'Maps alter the original-image view');
      await setFur(page, true);
      return difference;
    });

    await check('atlas-and-focus-crops-have-valid-map-sampling', async () => {
      await setRange(page, '#normal-strength', 65);
      await setRange(page, '#height-strength', 65);
      await page.locator('#view').selectOption('atlas');
      await waitFrames(page, 5);
      const atlasState = await diagnostics(page);
      assertAvailable(atlasState);
      const atlasOn = await capture(page, 'atlas-maps-on');
      await setMaps(page, false);
      const atlasOff = await capture(page, 'atlas-maps-off');
      const difference = pixelDiff(atlasOn, atlasOff);
      assertDifferent(difference, 'Maps disappear or misload in atlas view');
      await setMaps(page, true);
      await page.locator('#view').selectOption('focus');
      await waitFrames(page, 5);
      assertAvailable(await diagnostics(page));
      const restored = await capture(page, 'focus-after-atlas');
      const restoredDifference = pixelDiff(originalMapped, restored);
      assertSame(restoredDifference, 'Atlas/focus switching changes focus alignment');
      return {atlasState, difference, restoredDifference};
    });

    await check('uploaded-image-has-no-default-cat-map-leakage', async () => {
      await page.locator('#file').setInputFiles(createTransparentFixture());
      await page.waitForFunction(() => {
        const state = window.furApp.getDiagnostics();
        return state.ready && state.width === 425 && state.height === 409;
      });
      await freezeMotion(page);
      const state = await diagnostics(page);
      assert.equal(state.mapsAvailable, false);
      assert.equal(state.mapsEnabled, false);
      assert.equal(state.mappedStrands, 0, 'Default maps were sampled on upload');
      assert.equal(state.backgroundAlpha, 0);
      assert(state.strands > 100, 'Upload lost procedural fur');
      for (const selector of ['#maps', '#normal-strength', '#height-strength']) {
        assert(await page.locator(selector).isDisabled(), `${selector} is enabled`);
      }
      const before = await capture(page, 'uploaded-procedural');
      await setRange(page, '#normal-strength', 100);
      await setRange(page, '#height-strength', 100);
      const after = await capture(page, 'uploaded-disabled-map-controls');
      const difference = pixelDiff(before, after);
      assertSame(difference, 'Cat map strengths affect an unrelated uploaded image');
      let farOutside = 0;
      for (let y = 0; y < after.height; y++) {
        for (let x = 0; x < after.width; x++) {
          if (x >= 140 && x <= 290 && y >= 125 && y <= 285) continue;
          if (after.data[(y * after.width + x) * 4 + 3] > 12) farOutside++;
        }
      }
      assert.equal(farOutside, 0, 'False silhouette appears outside uploaded subject');
      return {diagnostics: state, difference, farOutside};
    });

    await check('reset-restores-default-material-and-strengths', async () => {
      await page.locator('#reset').click();
      await page.waitForFunction(() => {
        const state = window.furApp.getDiagnostics();
        return state.ready && state.mapsAvailable && state.mapsEnabled;
      });
      const state = await diagnostics(page);
      assertAvailable(state);
      assert.equal(await page.locator('#maps').inputValue(), 'on');
      assert.equal(await page.locator('#normal-strength').inputValue(), '65');
      assert.equal(await page.locator('#height-strength').inputValue(), '65');
      assert.equal(state.normalStrength, 0.65);
      assert.equal(state.heightStrength, 0.65);
      await freezeMotion(page);
      const reset = await capture(page, 'reset-default');
      const difference = pixelDiff(originalMapped, reset);
      assertSame(difference, 'Reset does not restore the default rendered result');
      return {diagnostics: state, difference};
    });

    await check('single-html-file-loads-both-maps-without-sidecars', async () => {
      const isolatedFile = path.join(outputDir, 'isolated-single-file.html');
      fs.copyFileSync(sourceFile, isolatedFile);
      const filePage = await context.newPage();
      const fileRequests = [];
      filePage.on('request', (request) => fileRequests.push(request.url()));
      try {
        await filePage.goto(pathToFileURL(isolatedFile).href,
            {waitUntil: 'domcontentloaded'});
        await filePage.waitForFunction(() =>
          window.furApp?.getDiagnostics().ready, null, {timeout: 30000});
        const state = await diagnostics(filePage);
        assertAvailable(state);
        await freezeMotion(filePage);
        const on = await capture(filePage, 'isolated-file-maps-on');
        await setMaps(filePage, false);
        const off = await capture(filePage, 'isolated-file-maps-off');
        const difference = pixelDiff(on, off);
        assertDifferent(difference, 'Embedded material maps have no visible effect');
        const externalRequests = fileRequests.filter((url) =>
          !url.startsWith('data:') && url !== pathToFileURL(isolatedFile).href);
        assert.deepEqual(externalRequests, [], 'Standalone HTML loads sidecar assets');
        const gl = await glState(filePage);
        assert.equal(gl.error, 0);
        assert.equal(gl.contextLost, false);
        return {diagnostics: state, difference, gl, externalRequests};
      } finally {
        await filePage.close();
      }
    });

    await check('invalid-normal-samples-preserve-procedural-fur', async () => {
      const invalidPage = await context.newPage();
      const blackNormal = new PNG({width: 1400, height: 1749});
      for (let offset = 3; offset < blackNormal.data.length; offset += 4) {
        blackNormal.data[offset] = 255;
      }
      const normalUri = 'data:image/png;base64,' +
          PNG.sync.write(blackNormal).toString('base64');
      let replacements = 0;
      let heightPreserved = false;
      await invalidPage.route('**/*', async (route) => {
        if (!route.request().isNavigationRequest()) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        const originalBody = await response.text();
        const heightDeclaration = originalBody.match(
            /const DEFAULT_HEIGHT\s*=\s*'[^']*';/)[0];
        const modifiedBody = originalBody.replace(
            /(const DEFAULT_NORMAL\s*=\s*)'[^']*'/,
            (match, declaration) => {
              replacements++;
              return `${declaration}'${normalUri}'`;
            });
        heightPreserved = modifiedBody.includes(heightDeclaration);
        await route.fulfill({response, body: modifiedBody});
      });
      try {
        await invalidPage.goto(baseUrl, {waitUntil: 'domcontentloaded'});
        await invalidPage.waitForFunction(() =>
          window.furApp?.getDiagnostics().ready, null, {timeout: 30000});
        assert.equal(replacements, 1, 'Normal fixture was not injected exactly once');
        assert.equal(heightPreserved, true, 'Height map was accidentally replaced');
        await freezeMotion(invalidPage);
        await setRange(invalidPage, '#normal-strength', 100);
        await setRange(invalidPage, '#height-strength', 100);
        const state = await diagnostics(invalidPage);
        assert.equal(state.mapsAvailable, true, 'Black PNG failed to decode');
        assert.equal(state.mapsEnabled, true);
        assert.equal(state.normalStrength, 1);
        assert.equal(state.heightStrength, 1);
        assert.equal(state.mappedStrands, 0, 'Black normal contains valid samples');
        assert.deepEqual(state.mapSources.normal, [1400, 1749]);
        assert.deepEqual(state.mapSources.height, [1400, 1749]);
        assert(state.strands > 100, 'Invalid normal erased procedural fur');
        assert(!state.lastError);
        const on = await capture(invalidPage, 'invalid-normal-maps-on');
        await setMaps(invalidPage, false);
        const off = await capture(invalidPage, 'invalid-normal-maps-off');
        const difference = pixelDiff(on, off);
        assertSame(difference,
            'Invalid normal samples still alter hair length or shading');
        const gl = await glState(invalidPage);
        assert.equal(gl.error, 0);
        assert.equal(gl.contextLost, false);
        return {diagnostics: state, replacements, heightPreserved, difference, gl};
      } finally {
        await invalidPage.close();
      }
    });

    await check('no-browser-network-or-webgl-errors', async () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(requestFailures, []);
      assert.deepEqual(failedResponses, []);
      assert.deepEqual(glErrors, []);
      return {pageErrors, consoleErrors, requestFailures, failedResponses, glErrors};
    });
  } finally {
    const summary = {baseUrl, sourceFile, finishedAt: new Date().toISOString(),
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
      results, consoleErrors, pageErrors, requestFailures, failedResponses, glErrors};
    fs.writeFileSync(path.join(outputDir, 'results.json'),
        JSON.stringify(summary, null, 2));
    await context.tracing.stop({path: path.join(outputDir, 'trace.zip')});
    await browser.close();
    console.log(JSON.stringify({passed: summary.passed, failed: summary.failed,
      report: path.join(outputDir, 'results.json')}));
    if (summary.failed) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
