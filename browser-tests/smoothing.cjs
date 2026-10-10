'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const baseUrl = process.env.PW_BASE_URL || 'http://127.0.0.1:8734';
const outputDir = path.join(__dirname, 'test-output/smoothing');
fs.mkdirSync(outputDir, {recursive: true});

async function settle(page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
}

async function capture(page) {
  await settle(page);
  return Buffer.from((await page.locator('#gl').evaluate((canvas) =>
    canvas.toDataURL())).split(',')[1], 'base64');
}

function grain(buffer) {
  const png = PNG.sync.read(buffer);
  const luma = (x, y) => {
    const i = (y * png.width + x) * 4;
    return png.data[i] * 0.2126 + png.data[i + 1] * 0.7152 +
        png.data[i + 2] * 0.0722;
  };
  let energy = 0;
  let count = 0;
  for (let y = 265; y < 360; y++) {
    for (let x = 350; x < 740; x++) {
      const center = luma(x, y);
      const residual = center - (luma(x - 1, y) + luma(x + 1, y) +
          luma(x, y - 1) + luma(x, y + 1)) / 4;
      energy += residual * residual;
      count++;
    }
  }
  return Math.sqrt(energy / count);
}

async function main() {
  const browser = await chromium.launch({headless: true,
    ...(process.env.PW_EXECUTABLE_PATH ?
      {executablePath: process.env.PW_EXECUTABLE_PATH} : {channel: 'chromium'}),
    args: process.platform === 'win32' ? ['--use-angle=d3d11'] : [],
  });
  const results = [];
  try {
    const page = await browser.newPage({viewport: {width: 1500, height: 1050},
      reducedMotion: 'no-preference'});
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.furApp?.getDiagnostics().ready);
    await page.locator('#preset').selectOption('plush');
    await page.locator('#wind').fill('0');
    await page.locator('#strength').fill('0');
    await page.locator('#smoothness').fill('0');
    const off = await capture(page);
    await page.locator('#smoothness').fill('80');
    const on = await capture(page);
    const roughness = {off: grain(off), on: grain(on)};
    assert(roughness.on < roughness.off * 0.8, JSON.stringify(roughness));
    results.push({name: 'coat-high-frequency-grain-is-reduced', evidence: roughness});
    fs.writeFileSync(path.join(outputDir, 'off.png'), off);
    fs.writeFileSync(path.join(outputDir, 'on.png'), on);
    await page.locator('#smoothness').fill('0');
    assert((await capture(page)).equals(off), 'Off image changed after a toggle');
    await page.locator('#smoothness').fill('80');
    assert((await capture(page)).equals(on), 'On image changed after a toggle');
    results.push({name: 'switch-restores-exactly-without-history'});
    await page.locator('#definition').fill('0');
    const flat = await capture(page);
    await page.locator('#definition').fill('75');
    const defined = await capture(page);
    assert(grain(defined) > grain(flat) * 1.3,
        'Body strand definition was not restored independently');
    assert(defined.equals(on), 'Definition did not restore the same image');
    assert.equal(await page.locator('#smoothness').inputValue(), '80');
    results.push({name: 'body-definition-adjusts-without-disabling-antialiasing',
      evidence: {flat: grain(flat), defined: grain(defined)}});

    // Rasterize the production shaders with one thin, slowly translating hair.
    // Compare total alpha over subpixel phases: an AA filter should conserve
    // coverage rather than make the strand flicker between dark and bright.
    const coverage = await page.evaluate(() => {
      const live = document.querySelector('#gl').getContext('webgl2');
      const sources = live.getAttachedShaders(live.getParameter(live.CURRENT_PROGRAM))
          .map((shader) => [live.getShaderParameter(shader, live.SHADER_TYPE),
            live.getShaderSource(shader)]);
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const gl = canvas.getContext('webgl2', {antialias: false, premultipliedAlpha: true});
      const program = gl.createProgram();
      for (const [type, source] of sources) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(shader));
        }
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program));
      }
      gl.useProgram(program);
      gl.bindVertexArray(gl.createVertexArray());
      [[30, 16], [0, 1], [1, 1, 1], [1, 0.4, 0, 0.3],
        [1, 1, 0], [0, 0, -1, 0]].forEach((values, index) => {
        gl[`vertexAttrib${values.length}fv`](index, values);
      });
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED,
          gl.UNSIGNED_BYTE, new Uint8Array([0]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.uniform1i(gl.getUniformLocation(program, 'protection'), 0);
      gl.uniform2f(gl.getUniformLocation(program, 'size'), 64, 64);
      for (const [name, value] of Object.entries({furLength: 24, density: 1,
        growth: 1, wind: 0, gravity: 0, strength: 0})) {
        gl.uniform1f(gl.getUniformLocation(program, name), value);
      }
      const summaries = [];
      for (const amount of [0, 1]) {
        const samples = [];
        gl.uniform1f(gl.getUniformLocation(program, 'smoothness'), amount);
        for (let phase = 0; phase < 32; phase++) {
          gl.vertexAttrib2f(0, 30 + phase / 32, 16);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 14);
          const pixels = new Uint8Array(64 * 64 * 4);
          gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          let sum = 0;
          for (let i = 3; i < pixels.length; i += 4) sum += pixels[i] / 255;
          samples.push(sum);
        }
        const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
        summaries.push({amount, mean, relativeRange:
          (Math.max(...samples) - Math.min(...samples)) / mean});
      }
      if (gl.getError()) throw new Error('GPU coverage probe failed');
      return summaries;
    });
    assert(coverage[1].relativeRange < coverage[0].relativeRange * 0.35,
        JSON.stringify(coverage));
    assert(Math.abs(coverage[1].mean / coverage[0].mean - 1) < 0.08,
        'Smoothing changed average strand coverage');
    results.push({name: 'gpu-subpixel-coverage-is-stable-and-energy-preserving', evidence: coverage});
    await page.locator('#toggle').click();
    const base = await capture(page);
    await page.locator('#smoothness').fill('0');
    assert((await capture(page)).equals(base), 'Smoothing off changed original art');
    await page.locator('#smoothness').fill('100');
    assert((await capture(page)).equals(base), 'Smoothing on changed original art');
    await page.locator('#definition').fill('100');
    assert((await capture(page)).equals(base), 'Definition changed original art');
    results.push({name: 'original-art-remains-pixel-identical'});
    await page.locator('#reset').click();
    assert.equal(await page.locator('#smoothness').inputValue(), '80');
    assert.equal(await page.locator('#definition').inputValue(), '75');
    assert.deepEqual(errors, []);
    results.push({name: 'reset-and-browser-errors'});
    fs.writeFileSync(path.join(outputDir, 'results.json'),
        JSON.stringify({baseUrl, passed: results.length, failed: 0, results}, null, 2));
    console.log(JSON.stringify({passed: results.length, results}));
  } finally {
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
