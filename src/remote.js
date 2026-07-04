#!/usr/bin/env node
// GlitchKitchen MCP — remote (Streamable HTTP) variant for hosted deployment.
//
// Key differences from the local stdio server:
//   - Images travel as base64 payloads or fetch-URLs, never filesystem paths.
//   - Results return as MCP image content blocks (base64 PNG).
//   - Strict per-effect param validation, hard dimension/size caps.
//   - Stateless: a fresh server+transport per request, safe behind a load balancer.
//   - Payment gate stub where the OKX Payment SDK drops in.
//
// Run:  PORT=3333 node src/remote.js

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import sharp from 'sharp';
import { EFFECTS, PRESETS, applyChain } from './effects/engine.js';
import { generateSource } from './source.js';
import { generatePfp, PFP_TEMPERATURES, PFP_INTENSITIES } from './pfp.js';
import crypto from 'node:crypto';
import { validateChain, MAX_CHAIN_STEPS } from './params.js';

const PORT = Number(process.env.PORT || 3333);
const MAX_DIM = Number(process.env.GK_MAX_DIM || 2048); // remote cap, stricter than local
const MAX_INPUT_BYTES = Number(process.env.GK_MAX_INPUT_BYTES || 15 * 1024 * 1024);
const MAX_OUTPUT_BYTES = Number(process.env.GK_MAX_OUTPUT_BYTES || 1024 * 1024); // hard 1MB output guarantee
const FETCH_TIMEOUT_MS = 10_000;

// ---------- image IO (payloads only, never paths) ----------
async function decodeToRaw(buffer) {
  if (buffer.length > MAX_INPUT_BYTES) throw new Error(`image exceeds ${MAX_INPUT_BYTES} byte limit`);
  const img = sharp(buffer, { limitInputPixels: MAX_DIM * MAX_DIM })
    .rotate()
    .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function loadFromBase64(b64) {
  const cleaned = b64.replace(/^data:image\/[a-z+]+;base64,/i, '');
  return decodeToRaw(Buffer.from(cleaned, 'base64'));
}

async function loadFromUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http(s) URLs are allowed');
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_INPUT_BYTES) throw new Error(`image exceeds ${MAX_INPUT_BYTES} byte limit`);
  const buf = Buffer.from(await res.arrayBuffer());
  return decodeToRaw(buf);
}

async function resolveInput({ image_base64, image_url, source }, seed) {
  if (image_base64) return loadFromBase64(image_base64);
  if (image_url) return loadFromUrl(image_url);
  const src = { ...(source || {}) };
  if (seed !== undefined && src.seed === undefined) src.seed = seed;
  if (src.width) src.width = Math.min(src.width, MAX_DIM);
  if (src.height) src.height = Math.min(src.height, MAX_DIM);
  return generateSource(src);
}

// Encode with a hard output-size guarantee. Escalation ladder:
// full PNG → palette-quantized PNG → WebP at descending quality → downscale and retry.
async function encodeBounded(img) {
  const raw = (w, h, data) => sharp(data, { raw: { width: w, height: h, channels: 4 } });
  let { data, width, height } = img;

  for (let pass = 0; pass < 4; pass++) {
    let buf = await raw(width, height, data).png({ compressionLevel: 9 }).toBuffer();
    if (buf.length <= MAX_OUTPUT_BYTES) return { buf, mimeType: 'image/png', width, height };

    buf = await raw(width, height, data).png({ compressionLevel: 9, palette: true, colors: 256 }).toBuffer();
    if (buf.length <= MAX_OUTPUT_BYTES) return { buf, mimeType: 'image/png', width, height };

    for (const quality of [90, 80, 70]) {
      buf = await raw(width, height, data).webp({ quality }).toBuffer();
      if (buf.length <= MAX_OUTPUT_BYTES) return { buf, mimeType: 'image/webp', width, height };
    }

    // still too big: downscale 25% and try the ladder again
    const nw = Math.max(64, Math.round(width * 0.75));
    const nh = Math.max(64, Math.round(height * 0.75));
    const resized = await raw(width, height, data).resize(nw, nh).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    data = resized.data; width = resized.info.width; height = resized.info.height;
  }
  throw new Error('could not encode output under the size limit');
}

function imageResult(encoded, meta) {
  return {
    content: [
      { type: 'image', data: encoded.buf.toString('base64'), mimeType: encoded.mimeType },
      { type: 'text', text: JSON.stringify({ ...meta, width: encoded.width, height: encoded.height, format: encoded.mimeType, bytes: encoded.buf.length }) },
    ],
  };
}

// ---------- schemas ----------
const effectStep = z.object({
  name: z.enum(Object.keys(EFFECTS)),
  params: z.record(z.any()).optional(),
});

const sourceOptions = z.object({
  width: z.number().int().min(16).max(MAX_DIM).optional(),
  height: z.number().int().min(16).max(MAX_DIM).optional(),
  temperature: z.enum(['cool', 'warm', 'mono']).optional(),
  colors: z.array(z.string()).min(2).max(8).optional(),
  seed: z.number().int().min(0).optional(),
  dot: z.boolean().optional(),
  dotColor: z.string().optional(),
}).describe('Options for the generated source canvas, used when no image is supplied');

const imageInput = {
  image_base64: z.string().optional().describe('Source image as base64 (raw or data URL). Omit along with image_url to glitch a generated canvas.'),
  image_url: z.string().optional().describe('Publicly fetchable http(s) URL of the source image'),
  source: sourceOptions.optional(),
};

// ---------- server factory (stateless: fresh per request) ----------
function buildServer() {
  const server = new McpServer({ name: 'glitchkitchen', version: '1.0.0' });

  server.tool(
    'list_effects',
    'List all GlitchKitchen effects, their parameters, and the built-in presets. Call this first to learn the vocabulary.',
    {},
    async () => {
      const effects = Object.fromEntries(
        Object.entries(EFFECTS).map(([name, e]) => [name, { description: e.description, params: e.params }])
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ effects, presets: PRESETS, limits: { max_dim: MAX_DIM, max_chain_steps: MAX_CHAIN_STEPS, max_output_bytes: MAX_OUTPUT_BYTES } }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'generate_source',
    'Generate a clean source canvas — a tonal gradient with an optional centered dot. Returns a PNG. Seeded and fully reproducible.',
    { source: sourceOptions.optional() },
    async ({ source }) => {
      const src = { ...(source || {}) };
      if (src.width) src.width = Math.min(src.width, MAX_DIM);
      if (src.height) src.height = Math.min(src.height, MAX_DIM);
      const img = await generateSource(src);
      return imageResult(await encodeBounded(img), {});
    }
  );

  server.tool(
    'generate_pfp',
    'Generate a unique glitch-art profile picture from a single seed. Every seed deterministically derives a full identity — color palette, background composition (gradients, bands, rings, splits, grids), dot treatment (solid, ring, halo, core), and a composed multi-effect glitch chain — anchored by the signature centered dot. Omit the seed for a random identity; the seed used is always returned so any result can be reproduced exactly. Returns a PNG/WebP under the size limit plus a full recipe.',
    {
      seed: z.number().int().min(0).optional().describe('The identity. Same seed → same image, forever. Omitted → randomly assigned and reported back.'),
      size: z.number().int().min(64).max(MAX_DIM).optional().describe('Square dimension in px (default 1024)'),
      temperature: z.enum(PFP_TEMPERATURES).optional().describe('Palette family: cool, warm, mono, or any (default any)'),
      intensity: z.enum(PFP_INTENSITIES).optional().describe('Glitch strength: subtle, medium, heavy (default medium)'),
      dot_color: z.string().optional().describe('Dot color (default #0a0a0a)'),
    },
    async ({ seed, size, temperature, intensity, dot_color }) => {
      const resolvedSeed = seed ?? crypto.randomInt(0, 2 ** 31 - 1);
      const { img, recipe } = await generatePfp({
        seed: resolvedSeed,
        size: Math.min(size || 1024, MAX_DIM),
        temperature: temperature || 'any',
        intensity: intensity || 'medium',
        dotColor: dot_color || '#0a0a0a',
      });
      return imageResult(await encodeBounded(img), { recipe });
    }
  );

  server.tool(
    'glitch_image',
    'Apply a stackable chain of GlitchKitchen effects. Effects run in order, so sequence matters. Supply image_base64 or image_url, or neither to glitch a generated gradient-and-dot canvas. Returns a PNG.',
    { ...imageInput, effects: z.array(effectStep).min(1).max(MAX_CHAIN_STEPS) },
    async (args) => {
      const chain = validateChain(args.effects);
      const img = await resolveInput(args);
      applyChain(img, chain);
      return imageResult(await encodeBounded(img), {
        chain: chain.map((e) => e.name),
        source: args.image_base64 || args.image_url ? 'supplied' : 'generated',
      });
    }
  );

  server.tool(
    'glitch_preset',
    'Apply a named GlitchKitchen preset: crt_terminal, vhs, corrupted, dither_1bit, newsprint, sorted_heat. Supply an image, or neither image field to glitch a generated canvas — ideal for creating art or a profile picture from scratch. Returns a PNG.',
    {
      ...imageInput,
      preset: z.enum(Object.keys(PRESETS)),
      seed: z.number().int().min(0).optional().describe('Seed applied to the generated canvas and all randomized steps'),
    },
    async (args) => {
      const img = await resolveInput(args, args.seed);
      const chain = PRESETS[args.preset].map((step) =>
        args.seed === undefined ? step : { ...step, params: { ...step.params, seed: args.seed } }
      );
      applyChain(img, chain);
      return imageResult(await encodeBounded(img), {
        preset: args.preset,
        seed: args.seed ?? null,
        source: args.image_base64 || args.image_url ? 'supplied' : 'generated',
      });
    }
  );

  return server;
}

// ---------- x402 payment gate ----------
// Per OKX ASP marketplace requirements: every request without payment proof —
// on every HTTP method, not just POST — must get HTTP 402 carrying the payment
// requirements, matching the listing's chain/asset/price exactly. Actual
// verification + settlement of an incoming payment authorization is a separate
// piece of work, not yet implemented — until then every request is challenged.
const X402_NETWORK = 'eip155:196'; // X Layer
const X402_ASSET = '0x779ded0c9e1022225f8e0630b35a9b54be713736'; // USDT (USD₮0), 6 decimals
const X402_ASSET_DECIMALS = 6;
const X402_ASSET_NAME = 'USD₮0';
const X402_ASSET_VERSION = '2';
const X402_PAY_TO = '0xcedd70af6828ff5c7127adc90a4d80d886e21dfe'; // registered ASP wallet
const X402_MAX_AMOUNT_REQUIRED = '10000'; // 0.01 USDT in minimal units (6 decimals)
const X402_MAX_TIMEOUT_SECONDS = 60;

function build402Payload(req) {
  const resource = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  return {
    x402Version: 1,
    error: 'Payment required',
    accepts: [
      {
        scheme: 'exact',
        network: X402_NETWORK,
        maxAmountRequired: X402_MAX_AMOUNT_REQUIRED,
        resource,
        description: 'Generative Glitch PFP Engine — one glitch-art PFP per call',
        mimeType: 'application/json',
        payTo: X402_PAY_TO,
        maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
        asset: X402_ASSET,
        decimals: X402_ASSET_DECIMALS,
        extra: { name: X402_ASSET_NAME, version: X402_ASSET_VERSION, symbol: 'USDT' },
      },
    ],
  };
}

// TODO(okx): verify the incoming payment authorization (EIP-3009 'exact' scheme)
// against build402Payload()'s terms and settle it on-chain. Not implemented —
// always returns false, so every request is challenged until this is wired in.
function verifyPayment(_req) {
  return false;
}

function x402Gate(req, res, next) {
  if (verifyPayment(req)) return next();
  const payload = build402Payload(req);
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  res.status(402);
  res.set('PAYMENT-REQUIRED', payloadB64);
  res.json(payload);
}

// ---------- express app ----------
const app = express();
app.set('trust proxy', true); // Railway terminates TLS at the edge; read X-Forwarded-Proto for req.protocol
app.use(express.json({ limit: `${Math.ceil(MAX_INPUT_BYTES / (1024 * 1024)) + 10}mb` }));

app.get('/healthz', (_req, res) => res.json({ ok: true, name: 'glitchkitchen-mcp', version: '1.0.0' }));

// The x402 challenge applies to every method on /mcp (GET/HEAD probes included).
// Only a verified payment reaches the actual MCP handler below.
app.post('/mcp', x402Gate, async (req, res) => {
  // Stateless mode: new server + transport per request, no session tracking.
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('mcp request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.get('/mcp', x402Gate);
app.delete('/mcp', x402Gate);
// Catch-all: any other HTTP method on /mcp is challenged too, never a 404/405.
app.all('/mcp', x402Gate);

app.listen(PORT, () => {
  console.error(`glitchkitchen-mcp remote listening on :${PORT} (POST /mcp)`);
});
