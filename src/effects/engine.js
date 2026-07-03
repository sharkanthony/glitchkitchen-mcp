// GlitchKitchen MCP — native effects engine
// All effects operate on a raw RGBA buffer { data: Buffer, width, height }
// and are pure-ish: they mutate/replace data and return the image object,
// so they can be chained in a pipeline.

// ---------- seeded RNG (mulberry32) ----------
export function makeRng(seed = 1337) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo = 0, hi = 255) => (v < lo ? lo : v > hi ? hi : v);
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// sRGB <-> linear for gamma-correct dithering
const srgbToLin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const linToSrgb = (c) => {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp(Math.round(v * 255));
};

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------- pixel sort ----------
export function pixelSort(img, { direction = 'horizontal', lowThreshold = 60, highThreshold = 200, sortBy = 'brightness', reverse = false } = {}) {
  const { data, width, height } = img;
  const key =
    sortBy === 'hue'
      ? (r, g, b) => Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b)
      : sortBy === 'red' ? (r) => r
      : sortBy === 'green' ? (_, g) => g
      : sortBy === 'blue' ? (_, __, b) => b
      : lum;

  const lineCount = direction === 'horizontal' ? height : width;
  const lineLen = direction === 'horizontal' ? width : height;
  const idx = direction === 'horizontal'
    ? (line, i) => (line * width + i) * 4
    : (line, i) => (i * width + line) * 4;

  for (let line = 0; line < lineCount; line++) {
    let i = 0;
    while (i < lineLen) {
      // find start of a sortable span (brightness within [low, high])
      let start = i;
      while (start < lineLen) {
        const p = idx(line, start);
        const L = lum(data[p], data[p + 1], data[p + 2]);
        if (L >= lowThreshold && L <= highThreshold) break;
        start++;
      }
      let end = start;
      while (end < lineLen) {
        const p = idx(line, end);
        const L = lum(data[p], data[p + 1], data[p + 2]);
        if (L < lowThreshold || L > highThreshold) break;
        end++;
      }
      if (end - start > 1) {
        const span = [];
        for (let j = start; j < end; j++) {
          const p = idx(line, j);
          span.push([data[p], data[p + 1], data[p + 2], data[p + 3]]);
        }
        span.sort((a, b) => key(a[0], a[1], a[2]) - key(b[0], b[1], b[2]));
        if (reverse) span.reverse();
        for (let j = start; j < end; j++) {
          const p = idx(line, j);
          const px = span[j - start];
          data[p] = px[0]; data[p + 1] = px[1]; data[p + 2] = px[2]; data[p + 3] = px[3];
        }
      }
      i = end + 1;
    }
  }
  return img;
}

// ---------- dithering ----------
const KERNELS = {
  'floyd-steinberg': { div: 16, taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  atkinson: { div: 8, taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
  burkes: { div: 32, taps: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]] },
};

const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
];

export function dither(img, { algorithm = 'floyd-steinberg', palette = ['#000000', '#ffffff'], gammaCorrect = true, pixelSize = 1 } = {}) {
  const { width, height } = img;
  let { data } = img;

  if (pixelSize > 1) downsample(img, pixelSize);

  const pal = palette.map(hexToRgb);
  const palLin = pal.map(([r, g, b]) => [srgbToLin(r), srgbToLin(g), srgbToLin(b)]);

  const toLin = gammaCorrect ? srgbToLin : (c) => c / 255;
  const fromLin = gammaCorrect ? linToSrgb : (c) => clamp(Math.round(c * 255));
  const workPal = gammaCorrect ? palLin : pal.map(([r, g, b]) => [r / 255, g / 255, b / 255]);

  const nearest = (r, g, b) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < workPal.length; i++) {
      const [pr, pg, pb] = workPal[i];
      const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  data = img.data;
  const w = img.width, h = img.height;

  if (algorithm === 'bayer') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const t = (BAYER_8[y % 8][x % 8] / 64 - 0.5) * 0.6;
        const r = toLin(data[p]) + t, g = toLin(data[p + 1]) + t, b = toLin(data[p + 2]) + t;
        const [nr, ng, nb] = pal[nearest(r, g, b)];
        data[p] = nr; data[p + 1] = ng; data[p + 2] = nb;
      }
    }
  } else {
    const kernel = KERNELS[algorithm] || KERNELS['floyd-steinberg'];
    // float working buffer in (possibly linear) space
    const buf = new Float32Array(w * h * 3);
    for (let i = 0, j = 0; i < w * h * 4; i += 4, j += 3) {
      buf[j] = toLin(data[i]); buf[j + 1] = toLin(data[i + 1]); buf[j + 2] = toLin(data[i + 2]);
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 3;
        const r = buf[j], g = buf[j + 1], b = buf[j + 2];
        const pi = nearest(r, g, b);
        const [qr, qg, qb] = workPal[pi];
        const er = r - qr, eg = g - qg, eb = b - qb;
        for (const [dx, dy, wgt] of kernel.taps) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const nj = (ny * w + nx) * 3;
          const f = wgt / kernel.div;
          buf[nj] += er * f; buf[nj + 1] += eg * f; buf[nj + 2] += eb * f;
        }
        const p = (y * w + x) * 4;
        const [sr, sg, sb] = pal[pi];
        data[p] = sr; data[p + 1] = sg; data[p + 2] = sb;
      }
    }
  }

  if (pixelSize > 1) upsample(img, pixelSize);
  return img;
}

function downsample(img, factor) {
  const { data, width, height } = img;
  const w = Math.max(1, Math.floor(width / factor));
  const h = Math.max(1, Math.floor(height / factor));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sp = (Math.min(height - 1, y * factor) * width + Math.min(width - 1, x * factor)) * 4;
      const dp = (y * w + x) * 4;
      out[dp] = data[sp]; out[dp + 1] = data[sp + 1]; out[dp + 2] = data[sp + 2]; out[dp + 3] = data[sp + 3];
    }
  }
  img.data = out; img._origW = width; img._origH = height; img.width = w; img.height = h;
}

function upsample(img, factor) {
  const { data, width, height, _origW, _origH } = img;
  const out = Buffer.alloc(_origW * _origH * 4);
  for (let y = 0; y < _origH; y++) {
    for (let x = 0; x < _origW; x++) {
      const sx = Math.min(width - 1, Math.floor(x / factor));
      const sy = Math.min(height - 1, Math.floor(y / factor));
      const sp = (sy * width + sx) * 4;
      const dp = (y * _origW + x) * 4;
      out[dp] = data[sp]; out[dp + 1] = data[sp + 1]; out[dp + 2] = data[sp + 2]; out[dp + 3] = data[sp + 3];
    }
  }
  img.data = out; img.width = _origW; img.height = _origH;
  delete img._origW; delete img._origH;
}

// ---------- RGB channel shift ----------
export function rgbShift(img, { redX = 6, redY = 0, blueX = -6, blueY = 0 } = {}) {
  const { data, width, height } = img;
  const src = Buffer.from(data);
  const at = (x, y) => (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      data[p] = src[at(x - redX, y - redY)];
      data[p + 2] = src[at(x - blueX, y - blueY) + 2];
    }
  }
  return img;
}

// ---------- scanlines ----------
export function scanlines(img, { spacing = 2, thickness = 1, intensity = 0.35 } = {}) {
  const { data, width, height } = img;
  const k = 1 - intensity;
  for (let y = 0; y < height; y++) {
    if (y % spacing >= thickness) continue;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      data[p] = Math.round(data[p] * k);
      data[p + 1] = Math.round(data[p + 1] * k);
      data[p + 2] = Math.round(data[p + 2] * k);
    }
  }
  return img;
}

// ---------- slice shift (horizontal displacement bands) ----------
export function sliceShift(img, { slices = 12, maxShift = 0.15, seed = 1337, wrap = true } = {}) {
  const { data, width, height } = img;
  const rng = makeRng(seed);
  const src = Buffer.from(data);
  for (let s = 0; s < slices; s++) {
    const y0 = Math.floor(rng() * height);
    const sh = 1 + Math.floor(rng() * (height / slices) * 0.8);
    const shift = Math.floor((rng() * 2 - 1) * maxShift * width);
    if (!shift) continue;
    for (let y = y0; y < Math.min(height, y0 + sh); y++) {
      for (let x = 0; x < width; x++) {
        let sx = x - shift;
        if (wrap) sx = ((sx % width) + width) % width;
        else sx = clamp(sx, 0, width - 1);
        const dp = (y * width + x) * 4;
        const sp = (y * width + sx) * 4;
        data[dp] = src[sp]; data[dp + 1] = src[sp + 1]; data[dp + 2] = src[sp + 2]; data[dp + 3] = src[sp + 3];
      }
    }
  }
  return img;
}

// ---------- databend (byte-offset channel smear) ----------
export function databend(img, { blocks = 6, maxOffset = 512, seed = 1337 } = {}) {
  const { data } = img;
  const rng = makeRng(seed * 7 + 1);
  const n = data.length;
  for (let b = 0; b < blocks; b++) {
    const start = Math.floor(rng() * n);
    const len = Math.floor(rng() * n * 0.05) + 256;
    const off = (1 + Math.floor(rng() * maxOffset)) * (rng() > 0.5 ? 1 : -1);
    for (let i = start; i < Math.min(n, start + len); i++) {
      const j = i + off;
      if (j >= 0 && j < n && (i + 1) % 4 !== 0) data[i] = data[j]; // preserve alpha bytes
    }
  }
  return img;
}

// ---------- noise ----------
export function noise(img, { amount = 24, monochrome = true, seed = 1337 } = {}) {
  const { data } = img;
  const rng = makeRng(seed * 13 + 5);
  for (let i = 0; i < data.length; i += 4) {
    if (monochrome) {
      const nz = (rng() * 2 - 1) * amount;
      data[i] = clamp(data[i] + nz); data[i + 1] = clamp(data[i + 1] + nz); data[i + 2] = clamp(data[i + 2] + nz);
    } else {
      data[i] = clamp(data[i] + (rng() * 2 - 1) * amount);
      data[i + 1] = clamp(data[i + 1] + (rng() * 2 - 1) * amount);
      data[i + 2] = clamp(data[i + 2] + (rng() * 2 - 1) * amount);
    }
  }
  return img;
}

// ---------- posterize ----------
export function posterize(img, { levels = 4 } = {}) {
  const { data } = img;
  const step = 255 / (levels - 1);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(Math.round(data[i] / step) * step);
    data[i + 1] = Math.round(Math.round(data[i + 1] / step) * step);
    data[i + 2] = Math.round(Math.round(data[i + 2] / step) * step);
  }
  return img;
}

// ---------- vignette ----------
export function vignette(img, { strength = 0.5, radius = 0.75 } = {}) {
  const { data, width, height } = img;
  const cx = width / 2, cy = height / 2;
  const maxD = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxD;
      const f = d < radius ? 1 : 1 - strength * ((d - radius) / (1 - radius));
      if (f >= 1) continue;
      const p = (y * width + x) * 4;
      data[p] = Math.round(data[p] * f);
      data[p + 1] = Math.round(data[p + 1] * f);
      data[p + 2] = Math.round(data[p + 2] * f);
    }
  }
  return img;
}

// ---------- invert ----------
export function invert(img) {
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i]; data[i + 1] = 255 - data[i + 1]; data[i + 2] = 255 - data[i + 2];
  }
  return img;
}

// ---------- effect registry ----------
export const EFFECTS = {
  pixel_sort: {
    fn: pixelSort,
    description: 'Threshold-based pixel sorting along rows or columns',
    params: {
      direction: "『horizontal』 or 『vertical』 (default horizontal)",
      lowThreshold: 'brightness floor 0-255 (default 60)',
      highThreshold: 'brightness ceiling 0-255 (default 200)',
      sortBy: 'brightness | hue | red | green | blue (default brightness)',
      reverse: 'boolean (default false)',
    },
  },
  dither: {
    fn: dither,
    description: 'Error-diffusion or ordered dithering with custom palettes, gamma-correct by default',
    params: {
      algorithm: 'floyd-steinberg | atkinson | burkes | bayer (default floyd-steinberg)',
      palette: "array of hex colors (default ['#000000','#ffffff'])",
      gammaCorrect: 'boolean, diffuse error in linear light (default true)',
      pixelSize: 'integer chunky-pixel factor, 1 = native res (default 1)',
    },
  },
  rgb_shift: {
    fn: rgbShift,
    description: 'Chromatic aberration — offset red and blue channels',
    params: { redX: 'px (default 6)', redY: 'px (default 0)', blueX: 'px (default -6)', blueY: 'px (default 0)' },
  },
  scanlines: {
    fn: scanlines,
    description: 'CRT-style horizontal scanlines',
    params: { spacing: 'px between lines (default 2)', thickness: 'px (default 1)', intensity: '0-1 darkness (default 0.35)' },
  },
  slice_shift: {
    fn: sliceShift,
    description: 'Random horizontal band displacement, classic glitch tear',
    params: { slices: 'count (default 12)', maxShift: 'fraction of width 0-1 (default 0.15)', seed: 'int for reproducibility', wrap: 'boolean (default true)' },
  },
  databend: {
    fn: databend,
    description: 'Byte-offset corruption smear across the pixel buffer (alpha-safe)',
    params: { blocks: 'corruption regions (default 6)', maxOffset: 'max byte offset (default 512)', seed: 'int' },
  },
  noise: {
    fn: noise,
    description: 'Film/VHS grain',
    params: { amount: '0-128 (default 24)', monochrome: 'boolean (default true)', seed: 'int' },
  },
  posterize: {
    fn: posterize,
    description: 'Reduce color levels per channel',
    params: { levels: '2-16 (default 4)' },
  },
  vignette: {
    fn: vignette,
    description: 'Radial edge darkening',
    params: { strength: '0-1 (default 0.5)', radius: '0-1 where falloff starts (default 0.75)' },
  },
  invert: { fn: invert, description: 'Invert RGB', params: {} },
};

// ---------- presets (stackable chains, GK house style) ----------
export const PRESETS = {
  crt_terminal: [
    { name: 'dither', params: { algorithm: 'bayer', palette: ['#000000', '#ffffff'], pixelSize: 2 } },
    { name: 'rgb_shift', params: { redX: 2, blueX: -2 } },
    { name: 'scanlines', params: { spacing: 3, intensity: 0.4 } },
    { name: 'vignette', params: { strength: 0.6, radius: 0.65 } },
  ],
  vhs: [
    { name: 'rgb_shift', params: { redX: 8, blueX: -8 } },
    { name: 'slice_shift', params: { slices: 8, maxShift: 0.08 } },
    { name: 'noise', params: { amount: 30 } },
    { name: 'scanlines', params: { spacing: 4, intensity: 0.2 } },
  ],
  corrupted: [
    { name: 'databend', params: { blocks: 10, maxOffset: 1024 } },
    { name: 'slice_shift', params: { slices: 20, maxShift: 0.3 } },
    { name: 'pixel_sort', params: { lowThreshold: 40, highThreshold: 220 } },
  ],
  dither_1bit: [
    { name: 'dither', params: { algorithm: 'floyd-steinberg', palette: ['#000000', '#ffffff'], gammaCorrect: true } },
  ],
  newsprint: [
    { name: 'posterize', params: { levels: 3 } },
    { name: 'dither', params: { algorithm: 'atkinson', palette: ['#0a0a0a', '#e8e4d8'], pixelSize: 2 } },
    { name: 'noise', params: { amount: 12 } },
  ],
  sorted_heat: [
    { name: 'posterize', params: { levels: 6 } },
    { name: 'pixel_sort', params: { direction: 'vertical', lowThreshold: 50, highThreshold: 210 } },
    { name: 'rgb_shift', params: { redX: 4, blueX: -4 } },
  ],
};

export function applyChain(img, chain) {
  for (const step of chain) {
    const effect = EFFECTS[step.name];
    if (!effect) throw new Error(`Unknown effect: ${step.name}. Use list_effects to see available effects.`);
    effect.fn(img, step.params || {});
  }
  return img;
}
