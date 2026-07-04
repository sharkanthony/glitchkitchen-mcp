# glitchkitchen-mcp

GlitchKitchen effects as native MCP tools. No browser, no API key — a pure pixel pipeline (Node + sharp) that agents can call to glitch images on disk. Same vocabulary as [glitchkitchen.com](https://glitchkitchen.com): pixel sorting, gamma-correct dithering, RGB shift, scanlines, slice tears, databending.

## Install

```bash
cd glitchkitchen-mcp
npm install
```

Requires Node 18+.

## Hook it up

**Claude Code:**

```bash
claude mcp add glitchkitchen -- node /absolute/path/to/glitchkitchen-mcp/src/index.js
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "glitchkitchen": {
      "command": "node",
      "args": ["/absolute/path/to/glitchkitchen-mcp/src/index.js"]
    }
  }
}
```

Docs: https://docs.claude.com/en/docs/claude-code/overview

## Where images go

When `output_path` is omitted, generated images are written to `~/Downloads/GlitchKitchen_PFPs/` (created automatically on first use) instead of the OS temp folder — so anything an agent generates from nothing (no `input_path`) is easy to find afterward. Override the location with the `GK_OUTPUT_DIR` environment variable. Passing an explicit `output_path` always takes precedence, and edits to an existing image (`input_path` set) still default to writing next to the source file.

## Tools

| Tool | What it does |
| --- | --- |
| `list_effects` | Full effect catalog with parameters, plus all presets |
| `generate_pfp` | One seed → one unique glitch-art profile picture: procedural palette, composition, dot treatment, and effect chain |
| `generate_source` | Make a clean source canvas — tonal gradient + centered dot, the GK house composition |
| `glitch_image` | Apply an ordered, stackable effect chain to one image |
| `glitch_preset` | One-shot house styles: `crt_terminal`, `vhs`, `corrupted`, `dither_1bit`, `newsprint`, `sorted_heat` |
| `batch_glitch` | Same chain or preset across many images (consistent look for a content batch) |

## The PFP engine

`generate_pfp` is the headline tool: a single integer seed deterministically derives an entire visual identity. The seed drives a procedural palette (continuous hue space with analogous, complement, and deep schemes — or mono), one of six background compositions (linear/radial gradients, bands, rings, splits, grids), one of four treatments of the signature centered dot (solid, ring, halo, core), and a composed glitch chain sampled from the full effect catalog with seeded parameters. The dot is the constant; everything around it is the variable.

```json
{ "seed": 4242, "temperature": "cool", "intensity": "heavy" }
```

Omit the seed and one is assigned randomly — and always reported back in the recipe, so any accidental favorite is reproducible forever. `intensity` (subtle/medium/heavy) scales distortion strength; the full recipe (palette, composition, dot, chain) returns with every image.

## No image? No problem

`input_path` is optional on `glitch_image` and `glitch_preset`. When omitted, the server generates a source canvas — a seeded tonal gradient with a centered black dot — and glitches that instead. This lets an agent create art or a profile picture entirely from nothing:

```json
{ "preset": "corrupted", "seed": 7 }
```

Control the canvas with the `source` option:

```json
{
  "preset": "vhs",
  "seed": 21,
  "source": { "temperature": "warm", "width": 1024, "height": 1024 }
}
```

- `temperature`: `cool` (navy/teal/violet), `warm` (maroon/coral/amber), or `mono`
- `colors`: custom hex gradient stops, overrides temperature
- `seed`: varies gradient direction, hue pick, and dot size — same seed, same canvas, forever
- `dot` / `dotColor`: toggle or recolor the centered dot

## Effects

- **pixel_sort** — threshold-based, horizontal/vertical, sort by brightness/hue/channel
- **dither** — Floyd–Steinberg, Atkinson, Burkes, Bayer 8×8; custom hex palettes; gamma-correct error diffusion in linear light (on by default); `pixelSize` for chunky output
- **rgb_shift** — chromatic aberration, independent red/blue offsets
- **scanlines** — CRT lines with spacing/thickness/intensity
- **slice_shift** — seeded horizontal band displacement with wraparound
- **databend** — alpha-safe byte-offset corruption smear
- **noise** — mono or RGB grain, seeded
- **posterize**, **vignette**, **invert**

Every randomized effect takes a `seed`, so agents can regenerate the exact same glitch — or sweep seeds for variations.

## Example call

```json
{
  "input_path": "/path/to/frame.png",
  "effects": [
    { "name": "posterize", "params": { "levels": 5 } },
    { "name": "pixel_sort", "params": { "direction": "vertical", "lowThreshold": 50 } },
    { "name": "rgb_shift", "params": { "redX": 4, "blueX": -4 } },
    { "name": "noise", "params": { "amount": 18, "seed": 42 } }
  ]
}
```

Order matters — chains run top to bottom, same as stacking in GlitchKitchen.

## Extending

Add an effect in `src/effects/engine.js`: write a function that mutates the raw RGBA buffer, register it in `EFFECTS`, optionally add a chain to `PRESETS`. The server picks it up automatically — the tool enums are generated from the registry.

## Remote / hosted mode (for marketplaces like OKX.AI)

`src/remote.js` serves the same engine over the MCP Streamable HTTP transport — the shape marketplace and hosted-agent platforms expect.

```bash
PORT=3333 npm run start:remote
# → POST /mcp   (MCP Streamable HTTP, stateless)
# → GET  /healthz
```

Differences from the local server, by design:

- **Payloads, not paths.** Tools take `image_base64` or `image_url` (or neither, for a generated canvas) and return the result as an MCP image content block. The filesystem is never exposed.
- **Strict validation.** Every effect parameter is schema-checked with hard ranges; unknown params are rejected. Chains cap at 12 steps.
- **Resource caps.** Inputs are resized to fit `GK_MAX_DIM` (default 2048) and limited to `GK_MAX_INPUT_BYTES` (default 15 MB). URL fetches time out at 10 s.
- **Output size guarantee.** Results always fit `GK_MAX_OUTPUT_BYTES` (default 1 MB) via an escalation ladder: PNG → palette PNG → WebP → downscale. The returned metadata reports the final format, dimensions, and byte count.
- **Stateless.** A fresh server/transport per request — safe behind a load balancer, no session store.
- **Payment gate stub.** Set `GK_API_KEY` to require an `x-api-key` header (returns 402 otherwise). The `paymentGuard` middleware in `src/remote.js` is the marked slot where the OKX Payment SDK's per-call metering drops in.

Deploy anywhere Node 18+ runs (VPS, Fly, Railway, Render). Put TLS in front of it before listing publicly.

## License

MIT
