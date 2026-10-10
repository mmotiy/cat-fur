'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');

const baseUrl = process.env.PW_BASE_URL || 'http://127.0.0.1:8734';
const executablePath = process.env.PW_EXECUTABLE_PATH;
const outputDir = path.join(__dirname, 'test-output/dynamics');
fs.mkdirSync(outputDir, {recursive: true});

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

async function capture(page, name, displayedSize = false) {
  let buffer;
  if (displayedSize) {
    buffer = await page.locator('#gl').screenshot();
  } else {
    const dataUrl = await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return document.querySelector('#gl').toDataURL('image/png');
    });
    buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
  }
  fs.writeFileSync(path.join(outputDir, `${name}.png`), buffer);
  return PNG.sync.read(buffer);
}

function pixelDiff(first, second) {
  assert.equal(first.width, second.width);
  assert.equal(first.height, second.height);
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
    if (pixelDelta > 3) {
      changed++;
    }
    maxDelta = Math.max(maxDelta, pixelDelta);
  }
  return {changedFraction: changed / (first.width * first.height),
    meanChannelDelta: totalDelta / first.data.length, maxDelta};
}

function assertDifferent(difference, description) {
  assert(difference.changedFraction > 0.0001 &&
      difference.meanChannelDelta > 0.001,
  `${description}: ${JSON.stringify(difference)}`);
}

function assertSame(difference, description) {
  assert.equal(difference.maxDelta, 0,
      `${description}: ${JSON.stringify(difference)}`);
}

async function uniforms(page) {
  return page.evaluate(() => {
    const gl = document.querySelector('#gl').getContext('webgl2');
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    return Object.fromEntries(['gravity', 'wind', 'windDirection'].map((name) => {
      const location = gl.getUniformLocation(program, name);
      const value = location === null ? null : gl.getUniform(program, location);
      return [name, ArrayBuffer.isView(value) ? Array.from(value) : value];
    }));
  });
}

// Execute the exact live production vertex shader. This verifies the GPU
// geometry, independently of JavaScript diagnostics or a duplicated formula.
async function probeGeometry(page, cases) {
  return page.evaluate((inputs) => {
    const live = document.querySelector('#gl').getContext('webgl2');
    const liveProgram = live.getParameter(live.CURRENT_PROGRAM);
    const vertex = live.getAttachedShaders(liveProgram).find((shader) =>
      live.getShaderParameter(shader, live.SHADER_TYPE) === live.VERTEX_SHADER);
    const source = live.getShaderSource(vertex);
    if (!source.includes('windDirection') || !source.includes('gravity')) {
      throw new Error('The live fur vertex shader does not expose both forces');
    }
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const program = gl.createProgram();
    const shaders = [];
    for (const [type, text] of [[gl.VERTEX_SHADER, source],
      [gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;\n' +
        'out vec4 color; void main() { color = vec4(1.0); }']]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
      }
      gl.attachShader(program, shader);
      shaders.push(shader);
    }
    gl.transformFeedbackVaryings(program, ['position'], gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, buffer);
    gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, 14 * 2 * 4, gl.STREAM_READ);
    const feedback = gl.createTransformFeedback();
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
    gl.enable(gl.RASTERIZER_DISCARD);
    const results = inputs.map((input) => {
      const attributes = [[100, 100], input.direction || [0, -1],
        [0.8, 0.5, 0.2], [1, 0.3, 0, 0.3],
        [input.edgeHair ?? 1, 1, 0], [0, 0, -1, 0]];
      attributes.forEach((values, location) => {
        gl.disableVertexAttribArray(location);
        gl[`vertexAttrib${values.length}fv`](location, values);
      });
      const vectors = {size: [500, 500], mouse: [-1000, -1000], velocity: [0, 0],
        windDirection: input.windDirection || [1, 0]};
      const scalars = {time: input.time || 0, furLength: input.length || 50,
        density: 1, wind: input.wind || 0, gravity: input.gravity || 0,
        strength: 0, growth: 1, normalAmount: 0, heightAmount: 0};
      Object.entries(vectors).forEach(([name, value]) => {
        gl.uniform2fv(gl.getUniformLocation(program, name), value);
      });
      Object.entries(scalars).forEach(([name, value]) => {
        gl.uniform1f(gl.getUniformLocation(program, name), value);
      });
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, 14);
      gl.endTransformFeedback();
      const data = new Float32Array(28);
      gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, data);
      const centers = [];
      for (let offset = 0; offset < data.length; offset += 4) {
        centers.push([(data[offset] + data[offset + 2]) / 2,
          (data[offset + 1] + data[offset + 3]) / 2]);
      }
      let arcLength = 0;
      for (let i = 1; i < centers.length; i++) {
        arcLength += Math.hypot(centers[i][0] - centers[i - 1][0],
            centers[i][1] - centers[i - 1][1]);
      }
      return {name: input.name, centers, tip: centers.at(-1), arcLength};
    });
    const error = gl.getError();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.deleteTransformFeedback(feedback);
    gl.deleteBuffer(buffer);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    shaders.forEach((shader) => gl.deleteShader(shader));
    if (error !== gl.NO_ERROR) {
      throw new Error(`Transform feedback WebGL error: ${error}`);
    }
    return results;
  }, cases);
}

async function main() {
  const browser = await chromium.launch({
    headless: process.env.PW_HEADED !== '1',
    ...(executablePath ? {executablePath} : {channel: 'chromium'}),
    args: process.platform === 'win32' ? ['--use-angle=d3d11'] : [],
  });
  const context = await browser.newContext({
    viewport: {width: 1500, height: 1050}, deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  await context.tracing.start({screenshots: true, snapshots: true});
  const errors = [];
  const results = [];
  function watch(newPage) {
    newPage.on('pageerror', (error) => errors.push(error.message));
    newPage.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });
    newPage.on('requestfailed', (request) => errors.push({
      url: request.url(), failure: request.failure(),
    }));
  }
  context.on('page', watch);
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  async function check(name, operation) {
    const start = Date.now();
    try {
      const evidence = await operation();
      const glError = await page.evaluate(() =>
        document.querySelector('#gl').getContext('webgl2').getError());
      assert.equal(glError, 0, 'Live renderer WebGL error');
      results.push({name, passed: true, elapsedMs: Date.now() - start, evidence});
      console.log(`PASS ${name}`);
    } catch (error) {
      await page.screenshot({path: path.join(outputDir, `${name}-failure.png`),
        fullPage: true}).catch(() => {});
      results.push({name, passed: false, elapsedMs: Date.now() - start,
        error: error.stack || error.message});
      console.log(`FAIL ${name}: ${error.message}`);
    }
  }

  try {
    await page.goto(baseUrl, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => window.furApp?.getDiagnostics().ready);
    await setRange(page, '#strength', 0);
    await page.mouse.move(0, 0);
    await check('controls-reach-live-gpu-uniforms', async () => {
      assert.equal(await page.locator('#gravity').inputValue(), '35');
      await setRange(page, '#gravity', 100);
      await setRange(page, '#wind', 100);
      await page.locator('#wind-direction').selectOption('left');
      await waitFrames(page);
      const left = await uniforms(page);
      assert(Math.abs(left.gravity - 1) < 0.001);
      assert(Math.abs(left.wind - 1) < 0.001);
      assert.deepEqual(left.windDirection, [-1, 0]);
      await page.locator('#wind-direction').selectOption('right');
      await waitFrames(page);
      const right = await uniforms(page);
      assert.deepEqual(right.windDirection, [1, 0]);
      return {left, right};
    });

    await check('production-gpu-gravity-bends-downward', async () => {
      const [off, on] = await probeGeometry(page, [
        {name: 'gravity-off', direction: [1, 0]},
        {name: 'gravity-on', direction: [1, 0], gravity: 1},
      ]);
      assert(on.tip[1] > off.tip[1] + 5,
          `Gravity did not visibly lower the tip: ${JSON.stringify({off, on})}`);
      return {off, on, downwardPixels: on.tip[1] - off.tip[1]};
    });

    await check('production-gpu-wind-has-coherent-left-right-direction', async () => {
      const cases = [];
      for (const time of [0, 1, 3, 6]) {
        cases.push({name: `right-${time}`, time, wind: 1});
        cases.push({name: `left-${time}`, time, wind: 1, windDirection: [-1, 0]});
      }
      const samples = await probeGeometry(page, cases);
      samples.forEach((sample) => {
        const sign = sample.name.startsWith('right') ? 1 : -1;
        assert((sample.tip[0] - 100) * sign > 5,
            `Wind reversed or disappeared: ${JSON.stringify(sample)}`);
      });
      return samples;
    });

    await check('parallel-body-hair-responds-to-travelling-wind', async () => {
      const cases = [0, 0.6, 1.2, 1.8, 2.4].map((time) => ({
        name: `body-${time}`, direction: [1, 0], edgeHair: 0, wind: 1, time,
      }));
      const moving = await probeGeometry(page, cases);
      const tipY = moving.map((sample) => sample.tip[1]);
      const motion = Math.max(...tipY) - Math.min(...tipY);
      assert(motion > 15, 'Parallel body hair still ignores wind');
      const still = await probeGeometry(page, cases.map((sample) => ({...sample, wind: 0})));
      for (const sample of moving) {
        assert.deepEqual(sample.centers[0], [100, 100]);
        assert(Math.abs(sample.arcLength - 50) < 0.01);
      }
      for (const sample of still) assert.deepEqual(sample.tip, still[0].tip);
      return {motion, moving, still};
    });

    await check('body-interior-pixels-move-without-relying-on-silhouette', async () => {
      await setRange(page, '#length', 12);
      await setRange(page, '#gravity', 35);
      await setRange(page, '#wind', 100);
      const first = await capture(page, 'body-wave-first');
      await page.waitForTimeout(550);
      const second = await capture(page, 'body-wave-second');
      let changed = 0;
      let total = 0;
      for (let y = 280; y < 360; y++) {
        for (let x = 450; x < 750; x++) {
          const i = (y * first.width + x) * 4;
          const delta = Math.max(...[0, 1, 2].map((channel) =>
            Math.abs(first.data[i + channel] - second.data[i + channel])));
          if (delta > 3) changed++;
          total++;
        }
      }
      assert(changed / total > 0.20,
          `Body interior has weak wind response: ${changed / total}`);
      return {changedFraction: changed / total};
    });

    await check('production-gpu-roots-fixed-and-strands-inextensible', async () => {
      const cases = [];
      for (const direction of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
        for (const length of [12, 50, 100]) {
          cases.push({name: `${direction.join(',')}-${length}`, direction,
            length, wind: 1, gravity: 1, time: 2.3});
        }
      }
      const samples = await probeGeometry(page, cases);
      samples.forEach((sample, index) => {
        assert(Math.hypot(sample.centers[0][0] - 100,
            sample.centers[0][1] - 100) < 0.001, 'A hair root moved');
        const limit = Math.min(cases[index].length, 72);
        assert(sample.arcLength <= limit + 0.02,
            `Strand stretched beyond ${limit}: ${JSON.stringify(sample)}`);
        sample.centers.forEach(([x, y]) => {
          assert(Number.isFinite(x) && Number.isFinite(y));
          assert(Math.hypot(x - 100, y - 100) <= 72.02);
        });
      });
      return samples;
    });

    await check('zero-wind-is-still-and-strong-wind-animates', async () => {
      await setRange(page, '#wind', 0);
      await setRange(page, '#gravity', 35);
      await setRange(page, '#length', 21);
      const stillFirst = await capture(page, 'still-first');
      await page.waitForTimeout(800);
      const stillSecond = await capture(page, 'still-second');
      const still = pixelDiff(stillFirst, stillSecond);
      assertSame(still, 'Zero wind still animated');
      await setRange(page, '#wind', 100);
      const movingFirst = await capture(page, 'wind-first');
      await page.waitForTimeout(800);
      const movingSecond = await capture(page, 'wind-second');
      const moving = pixelDiff(movingFirst, movingSecond);
      assertDifferent(moving, 'Strong wind has no visible motion');
      const force = pixelDiff(stillFirst, movingFirst);
      assertDifferent(force, 'Strong wind did not change the fur shape');
      return {still, moving, force};
    });

    await check('gravity-changes-visible-fur-and-restores-exactly', async () => {
      await setRange(page, '#wind', 0);
      await setRange(page, '#gravity', 0);
      const off = await capture(page, 'gravity-off');
      await setRange(page, '#gravity', 100);
      const on = await capture(page, 'gravity-on');
      const changed = pixelDiff(off, on);
      assertDifferent(changed, 'Gravity produced no visible result');
      await setRange(page, '#gravity', 0);
      const restored = pixelDiff(off, await capture(page, 'gravity-restored'));
      assertSame(restored, 'Gravity off did not restore the same geometry');
      return {changed, restored};
    });

    await check('back-outline-undercoat-covers-pale-seam-in-wind', async () => {
      await setRange(page, '#length', 12);
      await setRange(page, '#density', 75);
      const samples = [];
      for (const wind of [0, 100]) {
        await setRange(page, '#wind', wind);
        for (const direction of ['left', 'right']) {
          await page.locator('#wind-direction').selectOption(direction);
          await waitFrames(page);
          const evidence = await page.evaluate(() => {
            const gl = document.querySelector('#gl').getContext('webgl2');
            const width = currentData.width;
            const height = currentData.height;
            const output = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, output);
            let count = 0;
            let chroma = 0;
            for (let y = 140; y < 260; y++) {
              for (let x = 400; x < 800; x++) {
                const index = y * width + x;
                const p = index * 4;
                const source = currentData.pixels;
                if (currentData.sdf[index] > -5 || currentData.sdf[index] < -12 ||
                    source[p] < 225 || source[p + 1] < 200 || source[p + 2] < 170 ||
                    source[p + 3] < 240) continue;
                const q = ((height - 1 - y) * width + x) * 4;
                chroma += (output[q] - output[q + 2]) / 255;
                count++;
              }
            }
            return {count, meanCoatChroma: chroma / count};
          });
          assert(evidence.count > 100, 'Did not sample the original pale seam');
          assert(evidence.meanCoatChroma > 0.43,
              `Pale outline still shows through the coat: ${JSON.stringify(evidence)}`);
          samples.push({wind, direction, ...evidence});
        }
      }
      return samples;
    });

    await check('maximum-forces-keep-moving-without-clipping-border', async () => {
      const maximum = await page.locator('#length').getAttribute('max');
      await setRange(page, '#length', Number(maximum));
      await setRange(page, '#gravity', 100);
      await setRange(page, '#wind', 100);
      const samples = [];
      for (const direction of ['left', 'right']) {
        await page.locator('#wind-direction').selectOption(direction);
        await waitFrames(page);
        const first = await capture(page, `maximum-${direction}-first`);
        await page.waitForTimeout(800);
        const second = await capture(page, `maximum-${direction}-second`);
        const difference = pixelDiff(first, second);
        assertDifferent(difference, 'Maximum forces made all strands stop moving');
        const borderAlphas = [first, second].map((png) => {
          let borderAlpha = 0;
          for (let y = 0; y < png.height; y++) {
            for (let x = 0; x < png.width; x++) {
              if (x < 3 || y < 3 || x >= png.width - 3 || y >= png.height - 3) {
                borderAlpha = Math.max(borderAlpha,
                    png.data[(y * png.width + x) * 4 + 3]);
              }
            }
          }
          assert.equal(borderAlpha, 0, 'Fur touches or clips the canvas border');
          return borderAlpha;
        });
        samples.push({direction, width: first.width, height: first.height,
          borderAlphas, difference});
      }
      return samples;
    });

    await check('original-art-does-not-respond-to-forces', async () => {
      await page.locator('#toggle').click();
      await waitFrames(page);
      assert.equal(await page.evaluate(() =>
        window.furApp.getDiagnostics().furEnabled), false);
      const before = await capture(page, 'original-force-on');
      await setRange(page, '#gravity', 0);
      await setRange(page, '#wind', 0);
      const difference = pixelDiff(before, await capture(page, 'original-force-off'));
      assertSame(difference, 'Forces alter original art when fur is disabled');
      await page.locator('#toggle').click();
      await waitFrames(page);
      return difference;
    });

    await check('strong-wind-is-visible-at-narrow-display-size', async () => {
      await page.setViewportSize({width: 304, height: 1000});
      await setRange(page, '#length', 21);
      await setRange(page, '#gravity', 35);
      await setRange(page, '#wind', 100);
      await page.locator('#gl').scrollIntoViewIfNeeded();
      const first = await capture(page, 'mobile-wind-first', true);
      await page.waitForTimeout(800);
      const second = await capture(page, 'mobile-wind-second', true);
      const difference = pixelDiff(first, second);
      assertDifferent(difference, 'Wind disappears at a narrow display size');
      await page.setViewportSize({width: 1500, height: 1050});
      return {width: first.width, height: first.height, difference};
    });

    await check('reduced-motion-default-is-still-but-explicit-wind-works', async () => {
      const reducedContext = await browser.newContext({
        viewport: {width: 1500, height: 1050}, reducedMotion: 'reduce',
      });
      reducedContext.on('page', watch);
      const reducedPage = await reducedContext.newPage();
      try {
        await reducedPage.goto(baseUrl, {waitUntil: 'domcontentloaded'});
        await reducedPage.waitForFunction(() => window.furApp?.getDiagnostics().ready);
        assert.equal(await reducedPage.locator('#wind').inputValue(), '0');
        await setRange(reducedPage, '#strength', 0);
        const initial = await uniforms(reducedPage);
        assert.equal(initial.wind, 0);
        const stillFirst = await capture(reducedPage, 'reduced-still-first');
        await reducedPage.waitForTimeout(600);
        const still = pixelDiff(stillFirst,
            await capture(reducedPage, 'reduced-still-second'));
        assertSame(still, 'Reduced-motion default still animates');
        await setRange(reducedPage, '#wind', 100);
        const manual = await uniforms(reducedPage);
        assert(Math.abs(manual.wind - 1) < 0.001,
            'Reduced-motion preference silently disables explicit wind input');
        const movingFirst = await capture(reducedPage, 'reduced-manual-first');
        await reducedPage.waitForTimeout(800);
        const moving = pixelDiff(movingFirst,
            await capture(reducedPage, 'reduced-manual-second'));
        assertDifferent(moving, 'Explicit manual wind does not animate');
        return {initial, manual, still, moving};
      } finally {
        await reducedContext.close();
      }
    });

    await check('no-browser-or-network-errors', async () => {
      assert.deepEqual(errors, []);
      return {errors};
    });
  } finally {
    const summary = {baseUrl, finishedAt: new Date().toISOString(),
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length, results, errors};
    fs.writeFileSync(path.join(outputDir, 'results.json'),
        JSON.stringify(summary, null, 2));
    await context.tracing.stop({path: path.join(outputDir, 'trace.zip')});
    await browser.close();
    console.log(JSON.stringify({passed: summary.passed, failed: summary.failed,
      report: path.join(outputDir, 'results.json')}));
    if (summary.failed) {
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
