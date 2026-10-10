'use strict';

// Browser acceptance checks for rendering, interaction, and image uploads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');

const baseUrl = process.env.PW_BASE_URL || 'http://127.0.0.1:8734';
const outputDir = path.resolve(__dirname, 'test-output/playwright');
const executablePath = process.env.PW_EXECUTABLE_PATH;

fs.mkdirSync(outputDir, {recursive: true});

function makeFixture(name, width, height, transparent, color) {
  const png = new PNG({width, height});
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const inside = x > width * 0.32 && x < width * 0.68 &&
          y > height * 0.3 && y < height * 0.7;
      const rgba = inside ? [...color, 255] :
          transparent ? [233, 27, 212, 0] : [255, 255, 255, 255];
      png.data.set(rgba, offset);
    }
  }
  const buffer = PNG.sync.write(png);
  const filePath = path.join(outputDir, name);
  fs.writeFileSync(filePath, buffer);
  return {name, mimeType: 'image/png', buffer, width, height, filePath};
}

const transparentFixture = makeFixture(
    'transparent-red.png', 257, 241, true, [187, 81, 48]);
const blackFixture = makeFixture(
    'transparent-black.png', 263, 251, true, [0, 0, 0]);
const opaqueFixture = makeFixture(
    'white-background-dark.png', 269, 257, false, [16, 21, 28]);

function makeSolidFixture(name, width, height, color, clearFirstPixel = false) {
  const png = new PNG({width, height});
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data.set(color, offset);
  }
  if (clearFirstPixel) png.data[3] = 0;
  const buffer = PNG.sync.write(png);
  const filePath = path.join(outputDir, name);
  fs.writeFileSync(filePath, buffer);
  return {name, mimeType: 'image/png', buffer, width, height, filePath};
}

const sparseAlphaFixture = makeSolidFixture(
    'white-one-transparent-pixel.png', 30, 30, [255, 255, 255, 255], true);
const translucentFixture = makeSolidFixture(
    'half-transparent-color.png', 33, 29, [204, 100, 52, 128]);

function imageStats(png) {
  let visible = 0;
  let opaque = 0;
  let transparent = 0;
  let dark = 0;
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4;
      const alpha = png.data[offset + 3];
      if (alpha < 2) transparent++;
      if (alpha <= 12) continue;
      visible++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (alpha > 230) opaque++;
      if (alpha > 180 && Math.max(...png.data.subarray(offset, offset + 3)) < 40) {
        dark++;
      }
    }
  }
  const area = png.width * png.height;
  return {
    width: png.width, height: png.height, visible, opaque, dark,
    transparentFraction: transparent / area,
    visibleFraction: visible / area,
    bounds: {minX, minY, maxX, maxY},
  };
}

function imageDiff(first, second) {
  assert.equal(first.width, second.width, 'Pixel widths changed');
  assert.equal(first.height, second.height, 'Pixel heights changed');
  let changed = 0;
  let totalDelta = 0;
  let maxDelta = 0;
  for (let index = 0; index < first.data.length; index += 4) {
    let pixelDelta = 0;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(first.data[index + channel] -
          second.data[index + channel]);
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

function countOutsideBounds(png, bounds, padding) {
  let outside = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (x >= bounds.minX - padding && x <= bounds.maxX + padding &&
          y >= bounds.minY - padding && y <= bounds.maxY + padding) continue;
      if (png.data[(y * png.width + x) * 4 + 3] > 12) outside++;
    }
  }
  return outside;
}

async function diagnostics(page) {
  return page.evaluate(() => window.furApp.getDiagnostics());
}

async function waitFrames(page, count = 2) {
  await page.evaluate(async (frames) => {
    for (let i = 0; i < frames; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, count);
}

async function setRange(page, selector, value) {
  await page.locator(selector).evaluate((input, nextValue) => {
    input.value = String(nextValue);
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  }, value);
  await waitFrames(page);
}

async function setFullGrowth(page) {
  const maximum = await page.locator('#grow').getAttribute('max');
  await setRange(page, '#grow', maximum === null ? 1 : Number(maximum));
}

async function setFurEnabled(page, enabled) {
  if ((await diagnostics(page)).furEnabled !== enabled) {
    await page.locator('#toggle').click();
  }
  await page.waitForFunction(
      (next) => window.furApp.getDiagnostics().furEnabled === next, enabled);
  await waitFrames(page);
}

async function captureCanvas(page, name) {
  const dataUrl = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return document.querySelector('#gl').toDataURL('image/png');
  });
  const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(path.join(outputDir, `${name}-canvas.png`), buffer);
  await page.locator('#gl').screenshot({
    path: path.join(outputDir, `${name}-visible.png`),
  });
  return PNG.sync.read(buffer);
}

async function uploadFixture(page, fixture) {
  await page.locator('#file').setInputFiles({
    name: fixture.name, mimeType: fixture.mimeType, buffer: fixture.buffer,
  });
  await page.waitForFunction(({width, height}) => {
    const state = window.furApp.getDiagnostics();
    return state.ready && state.width === width && state.height === height &&
        !state.lastError;
  }, {width: fixture.width + 168, height: fixture.height + 168}, {timeout: 30000});
  if (await page.locator('#view').isEnabled()) {
    await page.locator('#view').selectOption('atlas');
  }
  await setRange(page, '#wind', 0);
  await setRange(page, '#strength', 0);
  await setFullGrowth(page);
  await setFurEnabled(page, true);
  await waitFrames(page, 4);
}

async function main() {
  const browser = await chromium.launch({
    headless: process.env.PW_HEADED !== '1',
    ...(executablePath ? {executablePath} : {channel: 'chromium'}),
    args: process.platform === 'win32' ? ['--use-angle=d3d11'] : [],
  });
  const context = await browser.newContext({
    viewport: {width: 1500, height: 950}, deviceScaleFactor: 1,
  });
  await context.tracing.start({screenshots: true, snapshots: true});
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const failedResponses = [];
  const results = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => requestFailures.push({
    url: request.url(), error: request.failure()?.errorText,
  }));
  page.on('response', (response) => {
    if (response.status() >= 500) {
      failedResponses.push({url: response.url(), status: response.status()});
    }
  });

  async function check(name, operation) {
    const start = Date.now();
    try {
      const evidence = await operation();
      results.push({name, passed: true, elapsedMs: Date.now() - start, evidence});
      console.log(`PASS ${name}`);
    } catch (error) {
      const screenshot = `${name.replace(/[^a-z0-9]+/gi, '-')}-failure.png`;
      await page.screenshot({path: path.join(outputDir, screenshot), fullPage: true})
          .catch(() => {});
      results.push({
        name, passed: false, elapsedMs: Date.now() - start,
        error: error.stack || error.message, screenshot,
      });
      console.log(`FAIL ${name}: ${error.message}`);
    }
  }

  try {
    await page.goto(baseUrl, {waitUntil: 'domcontentloaded'});
    await check('default-ready-and-rendering', async () => {
      await page.waitForFunction(() =>
        window.furApp?.getDiagnostics().ready, null, {timeout: 30000});
      const before = await diagnostics(page);
      await waitFrames(page, 5);
      const after = await diagnostics(page);
      assert(after.strands > 100, 'Default image has too few strands');
      assert(after.frameCount > before.frameCount, 'Render loop is not advancing');
      assert(!after.lastError, 'Initial render reported an error');
      assert.equal(pageErrors.length, 0, 'Uncaught errors on initial render');
      assert.equal(consoleErrors.length, 0, 'Console errors on initial render');
      await page.screenshot({path: path.join(outputDir, 'default-desktop.png')});
      return {diagnostics: after, status: await page.locator('#status').innerText()};
    });

    await check('fur-toggle-changes-visible-pixels', async () => {
      await setRange(page, '#wind', 0);
      await setRange(page, '#strength', 0);
      await page.mouse.move(0, 0);
      await setFullGrowth(page);
      await setFurEnabled(page, true);
      const withFur = await captureCanvas(page, 'default-with-fur');
      await setFurEnabled(page, false);
      const withoutFur = await captureCanvas(page, 'default-original');
      const difference = imageDiff(withFur, withoutFur);
      assert(difference.changedFraction > 0.001,
          `Fur toggle has no meaningful visible change: ${JSON.stringify(difference)}`);
      return difference;
    });

    await check('zero-growth-matches-original', async () => {
      await setFurEnabled(page, false);
      const original = await captureCanvas(page, 'growth-original');
      await setRange(page, '#grow', 0);
      await setFurEnabled(page, true);
      await page.waitForFunction(() =>
        Math.abs(window.furApp.getDiagnostics().growth) < 0.0001);
      const zeroGrowth = await captureCanvas(page, 'zero-growth');
      const difference = imageDiff(original, zeroGrowth);
      assert(difference.changedFraction < 0.0001 &&
          difference.meanChannelDelta < 0.02,
      `Zero growth differs from original: ${JSON.stringify(difference)}`);
      return difference;
    });

    await check('pointer-bends-fur-and-leave-restores-it', async () => {
      await setFullGrowth(page);
      await setFurEnabled(page, true);
      await setRange(page, '#wind', 0);
      await setRange(page, '#strength', 100);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(1100);
      const resting = await captureCanvas(page, 'pointer-resting');
      const box = await page.locator('#gl').boundingBox();
      assert(box, 'Interactive canvas has no visible bounding box');
      await page.mouse.move(box.x + box.width * 0.34,
          box.y + box.height * 0.52);
      await page.mouse.move(box.x + box.width * 0.47,
          box.y + box.height * 0.56, {steps: 10});
      await page.waitForTimeout(180);
      const touched = await captureCanvas(page, 'pointer-bent');
      const activeDifference = imageDiff(resting, touched);
      assert(activeDifference.changedFraction > 0.0002,
          `Pointer did not visibly bend fur: ${JSON.stringify(activeDifference)}`);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(1300);
      const restored = await captureCanvas(page, 'pointer-restored');
      const returnDifference = imageDiff(resting, restored);
      assert(returnDifference.meanChannelDelta <
          activeDifference.meanChannelDelta * 0.1 + 0.002 &&
          returnDifference.changedFraction <
          activeDifference.changedFraction * 0.1 + 0.00001,
      `Fur did not settle after pointer leave: ${JSON.stringify(returnDifference)}`);
      return {activeDifference, returnDifference};
    });

    await check('transparent-upload-has-no-false-surrounding-shape', async () => {
      await uploadFixture(page, transparentFixture);
      await setFurEnabled(page, false);
      const original = await captureCanvas(page, 'transparent-original');
      const originalStats = imageStats(original);
      assert(originalStats.visible > 100, 'Transparent subject is absent');
      await setFurEnabled(page, true);
      const withFur = await captureCanvas(page, 'transparent-with-fur');
      const furStats = imageStats(withFur);
      const state = await diagnostics(page);
      assert.equal(state.backgroundAlpha, 0, 'Transparent background became opaque');
      assert(furStats.transparentFraction > 0.4,
          'Transparent image unexpectedly fills most of the canvas');
      const padding = Math.max(withFur.width, withFur.height) * 0.08;
      const outsidePixels = countOutsideBounds(withFur, originalStats.bounds, padding);
      assert.equal(outsidePixels, 0,
          'Pixels appear far outside the uploaded subject (false silhouette)');
      assert(state.strands > 100, 'Uploaded subject produced no useful fur');
      return {diagnostics: state, originalStats, furStats, outsidePixels};
    });

    await check('pure-black-transparent-subject-is-preserved', async () => {
      await uploadFixture(page, blackFixture);
      await setFurEnabled(page, false);
      const original = await captureCanvas(page, 'black-original');
      const originalStats = imageStats(original);
      assert(originalStats.dark > 100, 'Pure-black subject was erased');
      assert(originalStats.transparentFraction > 0.4, 'Transparent area was filled');
      await setFurEnabled(page, true);
      const fur = await captureCanvas(page, 'black-with-fur');
      const furStats = imageStats(fur);
      const state = await diagnostics(page);
      assert(state.strands > 100, 'Black subject was not included in the fur mask');
      assert(furStats.visible >= originalStats.visible * 0.85,
          'Enabling fur erases the black subject');
      assert.equal(state.backgroundAlpha, 0);
      return {diagnostics: state, originalStats, furStats};
    });

    await check('opaque-white-background-keeps-dark-subject', async () => {
      await uploadFixture(page, opaqueFixture);
      const state = await diagnostics(page);
      assert(state.strands > 100, 'Dark foreground has no fur strands');
      const rendered = await captureCanvas(page, 'white-background-dark-subject');
      const stats = imageStats(rendered);
      assert(stats.dark > 100, 'Dark foreground on white was removed');
      return {diagnostics: state, stats};
    });

    await check('single-transparent-pixel-preserves-white-image', async () => {
      await uploadFixture(page, sparseAlphaFixture);
      await setFurEnabled(page, false);
      const original = await captureCanvas(page, 'sparse-alpha-white-original');
      const stats = imageStats(original);
      assert.equal(stats.opaque, 899,
          'White pixels were incorrectly discarded as an opaque background');
      assert.equal(stats.visible, 899,
          'The one transparent pixel or 899 opaque pixels were not preserved');
      const state = await diagnostics(page);
      assert.equal(state.backgroundAlpha, 0);
      return {diagnostics: state, stats};
    });

    await check('half-transparent-color-retains-rgb-and-alpha', async () => {
      await uploadFixture(page, translucentFixture);
      await setFurEnabled(page, false);
      const original = await captureCanvas(page, 'half-transparent-original');
      const offset = (Math.floor(original.height / 2) * original.width +
          Math.floor(original.width / 2)) * 4;
      const actual = [...original.data.subarray(offset, offset + 4)];
      const expected = [204, 100, 52, 128];
      for (let channel = 0; channel < 3; channel++) {
        assert(Math.abs(actual[channel] - expected[channel]) <= 3,
            `Semi-transparent RGB darkened or shifted: ${JSON.stringify(actual)}`);
      }
      assert(Math.abs(actual[3] - expected[3]) <= 1,
          `Semi-transparent alpha changed: ${JSON.stringify(actual)}`);
      const stats = imageStats(original);
      assert.equal(stats.visible, translucentFixture.width * translucentFixture.height,
          'Semi-transparent image coverage changed');
      return {expected, actual, stats, diagnostics: await diagnostics(page)};
    });

    await check('controls-presets-views-and-backgrounds', async () => {
      await page.locator('#reset').click();
      await page.waitForFunction(() => window.furApp.getDiagnostics().ready &&
          !document.querySelector('#view').disabled);
      for (const preset of ['soft', 'plush']) {
        await page.locator('#preset').selectOption(preset);
        await waitFrames(page, 4);
        assert((await diagnostics(page)).strands > 0, `${preset} has no strands`);
      }
      for (const view of ['focus', 'atlas']) {
        await page.locator('#view').selectOption(view);
        await waitFrames(page, 3);
      }
      for (const background of ['light', 'dark']) {
        await page.locator('#background').selectOption(background);
        await waitFrames(page, 3);
      }
      await setRange(page, '#grow', 0);
      await page.locator('#regrow').click();
      await page.waitForFunction(() =>
        window.furApp.getDiagnostics().growth > 0.01, null, {timeout: 10000});
      return await diagnostics(page);
    });

    await check('mobile-width-has-no-horizontal-overflow', async () => {
      await page.setViewportSize({width: 390, height: 844});
      await waitFrames(page, 6);
      const dimensions = await page.evaluate(() => ({
        viewport: innerWidth,
        htmlWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        canvas: document.querySelector('#gl').getBoundingClientRect().toJSON(),
      }));
      assert(dimensions.htmlWidth <= dimensions.viewport + 1,
          `Document overflows: ${JSON.stringify(dimensions)}`);
      assert(dimensions.bodyWidth <= dimensions.viewport + 1,
          `Body overflows: ${JSON.stringify(dimensions)}`);
      assert(dimensions.canvas.width > 100 && dimensions.canvas.height > 100,
          'Mobile canvas has collapsed');
      await page.locator('#toggle').click();
      await waitFrames(page);
      await page.screenshot({path: path.join(outputDir, 'mobile-390px.png'), fullPage: true});
      return dimensions;
    });

    await check('invalid-upload-is-visible-and-recoverable', async () => {
      await page.setViewportSize({width: 1500, height: 950});
      const oldStatus = await page.locator('#status').innerText();
      await page.locator('#file').setInputFiles({
        name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a PNG'),
      });
      await page.waitForFunction(() => Boolean(window.furApp.getDiagnostics().lastError),
          null, {timeout: 10000});
      await page.waitForFunction((previous) => {
        const status = document.querySelector('#status');
        return status && status.textContent.trim() &&
            status.textContent.trim() !== previous.trim();
      }, oldStatus, {timeout: 10000});
      const errorStatus = await page.locator('#status').innerText();
      assert(await page.locator('#status').isVisible(), 'Error status is hidden');
      const errorMessage = (await diagnostics(page)).lastError;
      assert(await page.getByText(errorMessage, {exact: true}).isVisible(),
          `Upload error is not visible: ${errorMessage}`);
      assert(/失败|错误|无法|不支持|损坏|error|fail|invalid|could not|unable/i.test(errorMessage),
          `Message does not communicate a failed upload: ${errorMessage}`);
      await page.screenshot({path: path.join(outputDir, 'invalid-upload.png')});
      await uploadFixture(page, transparentFixture);
      const recovered = await diagnostics(page);
      assert(recovered.ready && !recovered.lastError, 'Valid upload did not recover');
      return {errorStatus, errorMessage, recovered};
    });

    await check('no-unhandled-browser-or-server-errors', async () => {
      assert.deepEqual(pageErrors, [], 'Uncaught browser errors');
      assert.deepEqual(consoleErrors, [], 'Browser console errors');
      assert.deepEqual(failedResponses, [], 'Server 5xx responses');
      assert.deepEqual(requestFailures, [], 'Network failures');
      return {consoleErrors, pageErrors, requestFailures, failedResponses};
    });
  } finally {
    const summary = {
      baseUrl, finishedAt: new Date().toISOString(),
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
      results, consoleErrors, pageErrors, requestFailures, failedResponses,
    };
    fs.writeFileSync(path.join(outputDir, 'results.json'),
        JSON.stringify(summary, null, 2));
    await context.tracing.stop({path: path.join(outputDir, 'trace.zip')});
    await browser.close();
    console.log(JSON.stringify({
      passed: summary.passed, failed: summary.failed,
      report: path.join(outputDir, 'results.json'),
    }));
    if (summary.failed) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
