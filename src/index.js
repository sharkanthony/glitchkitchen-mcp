#!/usr/bin/env node
// GlitchKitchen MCP server — glitchkitchen.com effects as native agent tools
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import sharp from 'sharp';
import path from 'node:path';
import os from 'node:os';
import { EFFECTS, PRESETS, applyChain } from './effects/engine.js';
import { generateSource } from './source.js';
import { validateChain } from './params.js';
import { generatePfp, PFP_TEMPERATURES, PFP_INTENSITIES } from './pfp.js';
import crypto from 'node:crypto';

const MAX_DIM = 4096;

async function loadImage(inputPath) {
  const base = sharp(inputPath, { limitInputPixels: MAX_DIM * MAX_DIM * 4 })
    .rotate() // respect EXIF orientation
    .ensureAlpha();
  const { data, info } = await base.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function saveImage(img, outputPath) {
  const ext = path.extname(outputPath).toLowerCase();
  let pipeline = sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });
  if (ext === '.jpg' || ext === '.jpeg') pipeline = pipeline.flatten({ background: '#000' }).jpeg({ quality: 92 });
  else if (ext === '.webp') pipeline = pipeline.webp({ quality: 92 });
  else pipeline = pipeline.png();
  await pipeline.toFile(outputPath);
}

function defaultOutputPath(inputPath, tag) {
  if (!inputPath) {
    return path.join(os.tmpdir(), `gk-${tag}-${Date.now()}.png`);
  }
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath) || '.png';
  const stem = path.basename(inputPath, ext);
  return path.join(dir, `${stem}.gk-${tag}${ext === '.gif' ? '.png' : ext}`);
}

const effectStep = z.object({
  name: z.enum(Object.keys(EFFECTS)),
  params: z.record(z.any()).optional().describe('Effect parameters — see list_effects for each effect\u2019s options'),
});

const sourceOptions = z.object({
  width: z.number().int().min(16).max(MAX_DIM).optional().describe('Canvas width (default 640)'),
  height: z.number().int().min(16).max(MAX_DIM).optional().describe('Canvas height (default 640)'),
  temperature: z.enum(['cool', 'warm', 'mono']).optional().describe('Gradient family (default cool)'),
  colors: z.array(z.string()).min(2).optional().describe('Custom gradient stops as hex colors — overrides temperature'),
  seed: z.number().int().optional().describe('Varies gradient direction, hues, and dot size (default 1337)'),
  dot: z.boolean().optional().describe('Include the centered dot (default true)'),
  dotColor: z.string().optional().describe('Dot fill color (default #0a0a0a)'),
}).describe('Options for the generated source canvas, used only when input_path is omitted');

async function resolveInput(input_path, source) {
  if (input_path) return loadImage(input_path);
  return generateSource(source || {});
}

const server = new McpServer({ name: 'glitchkitchen', version: '0.2.0' });

server.tool(
  'list_effects',
  'List all GlitchKitchen effects, their parameters, and the built-in presets. Call this first to learn the vocabulary.',
  {},
  async () => {
    const effects = Object.fromEntries(
      Object.entries(EFFECTS).map(([name, e]) => [name, { description: e.description, params: e.params }])
    );
    return { content: [{ type: 'text', text: JSON.stringify({ effects, presets: PRESETS }, null, 2) }] };
  }
);

server.tool(
  'generate_source',
  'Generate a clean source canvas — a tonal gradient with an optional centered dot, the GlitchKitchen house composition. Use this (or omit input_path on the glitch tools) when you have no image of your own, e.g. when making art or a profile picture from scratch. Seeded and fully reproducible.',
  {
    output_path: z.string().optional().describe('Where to write the PNG; defaults to the system temp directory'),
    source: sourceOptions.optional(),
  },
  async ({ output_path, source }) => {
    const img = await generateSource(source || {});
    const out = output_path || defaultOutputPath(null, 'source');
    await saveImage(img, out);
    return { content: [{ type: 'text', text: JSON.stringify({ output_path: out, width: img.width, height: img.height }) }] };
  }
);

server.tool(
  'generate_pfp',
  'Generate a unique glitch-art profile picture from a single seed. The seed deterministically derives palette, background composition, dot treatment, and a composed glitch chain — anchored by the signature centered dot. Omit the seed for a random identity; the seed used is returned in the result.',
  {
    seed: z.number().int().min(0).optional().describe('The identity. Same seed → same image, forever.'),
    size: z.number().int().min(64).max(MAX_DIM).optional().describe('Square dimension in px (default 1024)'),
    temperature: z.enum(PFP_TEMPERATURES).optional(),
    intensity: z.enum(PFP_INTENSITIES).optional(),
    dot_color: z.string().optional(),
    output_path: z.string().optional().describe('Where to write the PNG; defaults to the system temp directory'),
  },
  async ({ seed, size, temperature, intensity, dot_color, output_path }) => {
    const resolvedSeed = seed ?? crypto.randomInt(0, 2 ** 31 - 1);
    const { img, recipe } = await generatePfp({
      seed: resolvedSeed,
      size: Math.min(size || 1024, MAX_DIM),
      temperature: temperature || 'any',
      intensity: intensity || 'medium',
      dotColor: dot_color || '#0a0a0a',
    });
    const out = output_path || defaultOutputPath(null, `pfp-${resolvedSeed}`);
    await saveImage(img, out);
    return { content: [{ type: 'text', text: JSON.stringify({ output_path: out, recipe }) }] };
  }
);

server.tool(
  'glitch_image',
  'Apply a stackable chain of GlitchKitchen effects. Effects run in order, so sequence matters (e.g. posterize → pixel_sort → rgb_shift). If input_path is omitted, a generated gradient-and-dot canvas is used as the source — pass source options to control it. Use seeds for reproducible randomness.',
  {
    input_path: z.string().optional().describe('Absolute path to the source image (png/jpg/webp). Omit to glitch a generated canvas instead.'),
    effects: z.array(effectStep).min(1).describe('Ordered effect chain'),
    output_path: z.string().optional().describe('Where to write the result; defaults to <input>.gk-glitched.<ext>, or a temp file for generated sources'),
    source: sourceOptions.optional(),
  },
  async ({ input_path, effects, output_path, source }) => {
    const chain = validateChain(effects);
    const img = await resolveInput(input_path, source);
    applyChain(img, chain);
    const out = output_path || defaultOutputPath(input_path, 'glitched');
    await saveImage(img, out);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          output_path: out,
          width: img.width,
          height: img.height,
          chain: effects.map((e) => e.name),
          source: input_path ? 'file' : 'generated',
        }),
      }],
    };
  }
);

server.tool(
  'glitch_preset',
  'Apply a named GlitchKitchen preset chain: crt_terminal, vhs, corrupted, dither_1bit, newsprint, sorted_heat. If input_path is omitted, a generated gradient-and-dot canvas is used — ideal for making art or a profile picture from scratch. Pass a seed to vary both the canvas and the randomized effects while staying reproducible.',
  {
    input_path: z.string().optional().describe('Absolute path to the source image. Omit to glitch a generated canvas instead.'),
    preset: z.enum(Object.keys(PRESETS)).describe('Preset name'),
    seed: z.number().int().optional().describe('Seed applied to the generated canvas and all randomized steps'),
    output_path: z.string().optional(),
    source: sourceOptions.optional(),
  },
  async ({ input_path, preset, seed, output_path, source }) => {
    const src = { ...(source || {}) };
    if (seed !== undefined && src.seed === undefined) src.seed = seed;
    const img = await resolveInput(input_path, src);
    const chain = PRESETS[preset].map((step) =>
      seed === undefined ? step : { ...step, params: { ...step.params, seed } }
    );
    applyChain(img, chain);
    const out = output_path || defaultOutputPath(input_path, preset);
    await saveImage(img, out);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ output_path: out, preset, seed: seed ?? null, source: input_path ? 'file' : 'generated' }),
      }],
    };
  }
);

server.tool(
  'batch_glitch',
  'Apply the same effect chain or preset to multiple images. Useful for processing a content batch with a consistent look.',
  {
    input_paths: z.array(z.string()).min(1).describe('Absolute paths to source images'),
    preset: z.enum(Object.keys(PRESETS)).optional().describe('Preset to apply (ignored if effects is provided)'),
    effects: z.array(effectStep).optional().describe('Custom chain to apply to every image'),
    seed: z.number().int().optional(),
    output_dir: z.string().optional().describe('Directory for outputs; defaults next to each input'),
  },
  async ({ input_paths, preset, effects, seed, output_dir }) => {
    if (!effects && !preset) throw new Error('Provide either a preset or an effects chain.');
    const baseChain = effects ? validateChain(effects) : PRESETS[preset];
    const results = [];
    for (const inputPath of input_paths) {
      const img = await loadImage(inputPath);
      const chain = baseChain.map((step) =>
        seed === undefined ? step : { ...step, params: { ...step.params, seed } }
      );
      applyChain(img, chain);
      let out = defaultOutputPath(inputPath, preset || 'glitched');
      if (output_dir) out = path.join(output_dir, path.basename(out));
      await saveImage(img, out);
      results.push(out);
    }
    return { content: [{ type: 'text', text: JSON.stringify({ outputs: results }) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('glitchkitchen-mcp running on stdio');
