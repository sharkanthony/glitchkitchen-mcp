// Strict per-effect parameter schemas. Unknown params are rejected, ranges are
// capped so a public endpoint can't be handed pathological work.
import { z } from 'zod';

const hex = z.string().regex(/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/, 'must be a hex color');
const seed = z.number().int().min(0).max(2 ** 31 - 1);

export const PARAM_SCHEMAS = {
  pixel_sort: z.object({
    direction: z.enum(['horizontal', 'vertical']).optional(),
    lowThreshold: z.number().min(0).max(255).optional(),
    highThreshold: z.number().min(0).max(255).optional(),
    sortBy: z.enum(['brightness', 'hue', 'red', 'green', 'blue']).optional(),
    reverse: z.boolean().optional(),
  }).strict(),
  dither: z.object({
    algorithm: z.enum(['floyd-steinberg', 'atkinson', 'burkes', 'bayer']).optional(),
    palette: z.array(hex).min(2).max(16).optional(),
    gammaCorrect: z.boolean().optional(),
    pixelSize: z.number().int().min(1).max(32).optional(),
  }).strict(),
  rgb_shift: z.object({
    redX: z.number().int().min(-64).max(64).optional(),
    redY: z.number().int().min(-64).max(64).optional(),
    blueX: z.number().int().min(-64).max(64).optional(),
    blueY: z.number().int().min(-64).max(64).optional(),
  }).strict(),
  scanlines: z.object({
    spacing: z.number().int().min(1).max(64).optional(),
    thickness: z.number().int().min(1).max(32).optional(),
    intensity: z.number().min(0).max(1).optional(),
  }).strict(),
  slice_shift: z.object({
    slices: z.number().int().min(1).max(64).optional(),
    maxShift: z.number().min(0).max(1).optional(),
    seed: seed.optional(),
    wrap: z.boolean().optional(),
  }).strict(),
  databend: z.object({
    blocks: z.number().int().min(1).max(32).optional(),
    maxOffset: z.number().int().min(1).max(8192).optional(),
    seed: seed.optional(),
  }).strict(),
  noise: z.object({
    amount: z.number().min(0).max(128).optional(),
    monochrome: z.boolean().optional(),
    seed: seed.optional(),
  }).strict(),
  posterize: z.object({
    levels: z.number().int().min(2).max(16).optional(),
  }).strict(),
  vignette: z.object({
    strength: z.number().min(0).max(1).optional(),
    radius: z.number().min(0).max(0.99).optional(),
  }).strict(),
  invert: z.object({}).strict(),
};

export const MAX_CHAIN_STEPS = 12;

export function validateChain(chain) {
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new Error('effects must be a non-empty array');
  }
  if (chain.length > MAX_CHAIN_STEPS) {
    throw new Error(`effect chains are capped at ${MAX_CHAIN_STEPS} steps`);
  }
  return chain.map((step, i) => {
    const schema = PARAM_SCHEMAS[step.name];
    if (!schema) throw new Error(`Unknown effect at step ${i}: ${step.name}`);
    const result = schema.safeParse(step.params || {});
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new Error(`Invalid params for ${step.name} at step ${i}: ${issue.path.join('.')} ${issue.message}`);
    }
    return { name: step.name, params: result.data };
  });
}
