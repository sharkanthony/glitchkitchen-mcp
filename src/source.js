// Built-in source generator: the GK demo composition (tonal gradient + black dot).
// Used as the default canvas when an agent doesn't supply its own image.
import sharp from 'sharp';
import { makeRng } from './effects/engine.js';

const FAMILIES = {
  cool: [
    ['#0a1f44', '#00b3c9', '#6a5bff'],
    ['#04122e', '#1e6f9f', '#8bd5ff'],
    ['#101033', '#3d7bff', '#00e0c0'],
  ],
  warm: [
    ['#3d0b0b', '#ff5e3a', '#ffc857'],
    ['#2b0a1e', '#e0344f', '#ff9e2c'],
    ['#331100', '#ff7733', '#ffe08a'],
  ],
  mono: [
    ['#0a0a0a', '#4a4a4a', '#e8e8e8'],
    ['#050505', '#6a6a6a', '#f2f2f2'],
  ],
};

const DIRECTIONS = [
  [0, 0, 1, 1], // diagonal ↘
  [1, 0, 0, 1], // diagonal ↙
  [0, 0, 0, 1], // vertical
  [0, 0, 1, 0], // horizontal
];

export async function generateSource({
  width = 640,
  height = 640,
  temperature = 'cool',
  colors,
  seed = 1337,
  dot = true,
  dotColor = '#0a0a0a',
} = {}) {
  const rng = makeRng(seed);
  const family = FAMILIES[temperature] || FAMILIES.cool;
  const stops =
    Array.isArray(colors) && colors.length >= 2
      ? colors
      : family[Math.floor(rng() * family.length)];
  const [x1, y1, x2, y2] = DIRECTIONS[Math.floor(rng() * DIRECTIONS.length)];
  const radius = Math.round(Math.min(width, height) * (0.22 + rng() * 0.06));

  const stopSvg = stops
    .map((c, i) => `<stop offset="${(i / (stops.length - 1)).toFixed(3)}" stop-color="${c}"/>`)
    .join('');
  const circle = dot
    ? `<circle cx="${width / 2}" cy="${height / 2}" r="${radius}" fill="${dotColor}"/>`
    : '';
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stopSvg}</linearGradient></defs>
<rect width="${width}" height="${height}" fill="url(#g)"/>${circle}</svg>`;

  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
