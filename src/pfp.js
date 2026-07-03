// Generative PFP engine: one seed deterministically derives a full identity —
// palette, background composition, dot treatment, and a composed effect chain.
// The centered black dot is the constant; everything around it is the variable.
import sharp from 'sharp';
import { makeRng, applyChain } from './effects/engine.js';

// ---------- color ----------
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

const HUE_RANGES = {
  warm: [-40, 70],   // magenta-red through amber
  cool: [170, 300],  // teal through violet
  any: [0, 360],
};

function buildPalette(rng, temperature) {
  if (temperature === 'mono') {
    const l1 = 8 + rng() * 10, l2 = 40 + rng() * 20, l3 = 75 + rng() * 18;
    return { stops: [hslToHex(0, 0, l1), hslToHex(0, 0, l2), hslToHex(0, 0, l3)], hue: null };
  }
  const [lo, hi] = HUE_RANGES[temperature] || HUE_RANGES.any;
  const hue = lo + rng() * (hi - lo);
  const scheme = ['analogous', 'complement', 'deep'][Math.floor(rng() * 3)];
  const sat = 55 + rng() * 35;
  const stops = [];
  if (scheme === 'analogous') {
    stops.push(hslToHex(hue - 22, sat, 16 + rng() * 12));
    stops.push(hslToHex(hue, sat, 45 + rng() * 15));
    stops.push(hslToHex(hue + 22, sat * 0.9, 62 + rng() * 18));
  } else if (scheme === 'complement') {
    stops.push(hslToHex(hue, sat, 15 + rng() * 12));
    stops.push(hslToHex(hue, sat * 0.8, 50 + rng() * 12));
    stops.push(hslToHex(hue + 180, sat * 0.75, 60 + rng() * 18));
  } else { // deep: dark-dominant with one bright accent
    stops.push(hslToHex(hue, sat * 0.7, 8 + rng() * 8));
    stops.push(hslToHex(hue + 12, sat, 26 + rng() * 12));
    stops.push(hslToHex(hue - 8, sat, 68 + rng() * 20));
  }
  return { stops, hue };
}

// ---------- background compositions (dot always drawn on top) ----------
const COMPOSITIONS = ['linear', 'radial', 'bands', 'rings', 'split', 'grid'];

function backgroundSvg(rng, comp, stops, w, h) {
  const [c0, c1, c2] = stops;
  switch (comp) {
    case 'linear': {
      const angle = rng() * 360;
      const rad = (angle * Math.PI) / 180;
      const x2 = (0.5 + Math.cos(rad) / 2).toFixed(3), y2 = (0.5 + Math.sin(rad) / 2).toFixed(3);
      const x1 = (1 - x2).toFixed ? (1 - Number(x2)).toFixed(3) : x2, y1 = (1 - Number(y2)).toFixed(3);
      return `<defs><linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
<stop offset="0" stop-color="${c0}"/><stop offset="0.55" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>`;
    }
    case 'radial': {
      const cx = 0.3 + rng() * 0.4, cy = 0.3 + rng() * 0.4;
      return `<defs><radialGradient id="g" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="0.9">
<stop offset="0" stop-color="${c2}"/><stop offset="0.55" stop-color="${c1}"/><stop offset="1" stop-color="${c0}"/>
</radialGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>`;
    }
    case 'bands': {
      const n = 5 + Math.floor(rng() * 8);
      const vertical = rng() > 0.5;
      const size = (vertical ? w : h) / n;
      let rects = `<rect width="${w}" height="${h}" fill="${c0}"/>`;
      for (let i = 0; i < n; i++) {
        const fill = [c0, c1, c2][i % 3];
        rects += vertical
          ? `<rect x="${i * size}" y="0" width="${size + 1}" height="${h}" fill="${fill}"/>`
          : `<rect x="0" y="${i * size}" width="${w}" height="${size + 1}" fill="${fill}"/>`;
      }
      return rects;
    }
    case 'rings': {
      const n = 4 + Math.floor(rng() * 5);
      let rings = `<rect width="${w}" height="${h}" fill="${c0}"/>`;
      const maxR = Math.hypot(w, h) / 2;
      for (let i = n; i >= 1; i--) {
        rings += `<circle cx="${w / 2}" cy="${h / 2}" r="${(maxR * i) / n}" fill="${[c0, c1, c2][i % 3]}"/>`;
      }
      return rings;
    }
    case 'split': {
      const angle = rng() * 180;
      const rad = (angle * Math.PI) / 180;
      const dx = Math.cos(rad) * Math.hypot(w, h), dy = Math.sin(rad) * Math.hypot(w, h);
      const mx = w / 2, my = h / 2;
      return `<rect width="${w}" height="${h}" fill="${c0}"/>
<polygon points="${mx - dx},${my - dy} ${mx + dx},${my + dy} ${mx + dx - dy * 2},${my + dy + dx * 2} ${mx - dx - dy * 2},${my - dy + dx * 2}" fill="${c1}"/>
<circle cx="${w * (0.2 + rng() * 0.6)}" cy="${h * (0.2 + rng() * 0.6)}" r="${w * 0.08}" fill="${c2}"/>`;
    }
    case 'grid': {
      const n = 6 + Math.floor(rng() * 8);
      const cell = w / n;
      let cells = `<rect width="${w}" height="${h}" fill="${c0}"/>`;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        if (rng() > 0.55) cells += `<rect x="${x * cell}" y="${y * cell}" width="${cell + 0.5}" height="${cell + 0.5}" fill="${rng() > 0.5 ? c1 : c2}"/>`;
      }
      return cells;
    }
  }
}

// ---------- dot treatments (the constant, with controlled variation) ----------
const DOT_STYLES = ['solid', 'ring', 'halo', 'core'];

function dotSvg(rng, style, w, h, dotColor) {
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) * (0.2 + rng() * 0.09);
  switch (style) {
    case 'solid':
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${dotColor}"/>`;
    case 'ring': {
      const stroke = r * (0.28 + rng() * 0.2);
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${dotColor}" stroke-width="${stroke}"/>`;
    }
    case 'halo': {
      const gap = r * (0.18 + rng() * 0.12);
      return `<circle cx="${cx}" cy="${cy}" r="${r + gap + r * 0.08}" fill="none" stroke="${dotColor}" stroke-width="${r * 0.08}"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="${dotColor}"/>`;
    }
    case 'core': {
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${dotColor}"/>
<circle cx="${cx}" cy="${cy}" r="${r * (0.3 + rng() * 0.15)}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="${r * 0.05}"/>`;
    }
  }
}

// ---------- effect chain composer ----------
const INTENSITY = { subtle: 0.55, medium: 1, heavy: 1.6 };

function composeChain(rng, seed, stops, intensityName) {
  const k = INTENSITY[intensityName] ?? 1;
  const chain = [];
  const ri = (lo, hi) => Math.round(lo + rng() * (hi - lo));
  const rf = (lo, hi) => lo + rng() * (hi - lo);

  // texture pass (~65% of identities get one)
  if (rng() < 0.65) {
    const pick = rng();
    if (pick < 0.45) {
      const algos = ['floyd-steinberg', 'atkinson', 'burkes', 'bayer'];
      const dark = stops[0], light = stops[2];
      const palette = rng() < 0.5 ? [dark, light] : [stops[0], stops[1], stops[2]];
      chain.push({ name: 'dither', params: { algorithm: algos[Math.floor(rng() * algos.length)], palette, pixelSize: ri(1, 3) } });
    } else if (pick < 0.8) {
      chain.push({ name: 'posterize', params: { levels: ri(3, 8) } });
    } else {
      chain.push({ name: 'noise', params: { amount: Math.round(rf(8, 26) * k), monochrome: rng() > 0.4, seed } });
    }
  }

  // distortion pass — always at least one, the glitch core
  const distortions = [
    () => chain.push({ name: 'pixel_sort', params: {
      direction: rng() > 0.5 ? 'horizontal' : 'vertical',
      lowThreshold: ri(25, 70), highThreshold: ri(180, 235),
      sortBy: ['brightness', 'hue', 'red', 'blue'][Math.floor(rng() * 4)],
    }}),
    () => chain.push({ name: 'slice_shift', params: {
      slices: Math.min(60, Math.round(rf(5, 24) * k)), maxShift: Math.min(0.5, rf(0.05, 0.2) * k), seed,
    }}),
    () => chain.push({ name: 'databend', params: {
      blocks: Math.min(30, Math.round(rf(3, 11) * k)), maxOffset: ri(256, 2048), seed,
    }}),
  ];
  const first = Math.floor(rng() * distortions.length);
  distortions[first]();
  if (rng() < 0.55 * k) {
    let second = Math.floor(rng() * distortions.length);
    if (second === first) second = (second + 1) % distortions.length;
    distortions[second]();
  }

  // finish pass
  if (rng() < 0.75) chain.push({ name: 'rgb_shift', params: { redX: ri(2, Math.round(9 * k)), blueX: -ri(2, Math.round(9 * k)) } });
  if (rng() < 0.5) chain.push({ name: 'scanlines', params: { spacing: ri(2, 4), intensity: rf(0.15, 0.4) } });
  if (rng() < 0.45) chain.push({ name: 'vignette', params: { strength: rf(0.3, 0.65), radius: rf(0.55, 0.8) } });

  return chain;
}

// ---------- public API ----------
export const PFP_TEMPERATURES = ['cool', 'warm', 'mono', 'any'];
export const PFP_INTENSITIES = ['subtle', 'medium', 'heavy'];

export async function generatePfp({ seed = 1337, size = 1024, temperature = 'any', intensity = 'medium', dotColor = '#0a0a0a' } = {}) {
  const rng = makeRng(seed);
  const { stops } = buildPalette(rng, temperature);
  const comp = COMPOSITIONS[Math.floor(rng() * COMPOSITIONS.length)];
  const dotStyle = DOT_STYLES[Math.floor(rng() * DOT_STYLES.length)];

  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
${backgroundSvg(rng, comp, stops, size, size)}
${dotSvg(rng, dotStyle, size, size, dotColor)}
</svg>`;

  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = { data, width: info.width, height: info.height };

  const chain = composeChain(rng, seed, stops, intensity);
  applyChain(img, chain);

  return {
    img,
    recipe: { seed, size, temperature, intensity, palette: stops, composition: comp, dot: dotStyle, chain: chain.map((c) => c.name) },
  };
}
