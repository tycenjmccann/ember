# Ember — Logo & Brand Kit

> **Keep your session warm.**

The mark: a **charred log with textured woodgrain bark, its glowing cut end a live ember
showing a `>_` terminal prompt, resting on a bed of chunky natural coals.** Banked firewood
that holds heat quietly while you step away = a coding agent that keeps running in your own
cloud. The `>_` fuses campfire with terminal.

## Files (this folder)

| File | Use |
|---|---|
| `ember-icon.svg` | Primary icon, full color, transparent bg (vector) |
| `ember-icon-512.png` / `-1024.png` | Raster icon exports |
| `ember-favicon.svg` | Simplified favicon — the ember `>_` coal-end only (reads at 16px) |
| `favicon-32.png` / `apple-touch-icon.png` | Favicon / iOS app icon rasters |
| `ember-lockup-dark.svg` | Horizontal lockup, bone wordmark (for dark backgrounds) |
| `ember-lockup-light.svg` | Horizontal lockup, near-black wordmark (for light backgrounds) |
| `ember-lockup-dark-1280.png` | Lockup raster / social + OG image |
| `ember-mono.svg` | One-color black silhouette (stamp / etch / single-color print) |
| `_BRAND_KIT.png` | The kit overview sheet |

## Colors

| Token | Hex | Use |
|---|---|---|
| ember-500 | `#ff6a00` | primary accent / the glowing terminal end |
| ember hot | `#ff7a1a` → `#ffb24d` | coal cores / glow highlights |
| bark dark | `#4a3426` / `#201c19` | charred log woodgrain |
| night | `#0e0d0c` / `#000000` | dark background |
| bone | `#f5efe8` | warm white / light background + wordmark on dark |

## Wordmark

`ember`, lowercase, **Bricolage Grotesque** (or General Sans / Avenir Next fallback), bold,
tight tracking (`-0.02em`). Bone on dark, near-black (`#1a1816`) on light.

## Usage

- **Favicon / tiny sizes:** always use `ember-favicon.svg` (the coal-`>_` end), never the full
  scene — the full log+coals mushes below ~24px.
- **App icon / avatar:** `ember-icon.svg`.
- **Nav / headers / docs:** the horizontal lockup (dark or light to match bg).
- **One-color contexts** (laser, embroidery, stamp): `ember-mono.svg`.
- Clear space = height of the log's end-cap on all sides. Don't recolor the ember cool; don't
  add flames (it's a banked ember, post-flame — that restraint is the pitch).

## How it was made

Generated as 12-up concept sheets (Allan Peters method — see `../../../.claude` skill
`logo-design-allan-peters`) across Google image models, narrowed over rounds (abstract → charred
log + `>` terminal end → + campfire context → textured bark + chunky coals), then the chosen
master art was vector-traced (vtracer color + potrace mono), background-stripped, and assembled
into lockups. Concept/round sheets are archived in `sheets/`.
