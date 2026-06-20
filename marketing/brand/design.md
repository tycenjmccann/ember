# Ember — Design System (design.md)

The single source of truth for every Ember surface: landing page, launch video, deck,
social, and the in-app UI overhaul. Built to drop onto the existing true-black iOS-native
app — we keep the dark night, swap the iOS-blue accent for **ember glow**.

---

## 1. Brand essence

- **Name:** Ember (always lowercase in the wordmark `ember`; "Ember" sentence-case in prose)
- **Tagline:** Keep your session warm.
- **Mark:** a single live ember / glowing tip of a charred log — a hot dot with a soft bloom.
- **World:** night woods, one source of light against the dark. Warm, grainy, alive.

## 2. Color palette

### Ember accent scale (replaces iOS blue as the brand/accent)
The core glow runs orange→amber, like a coal breathed back to life.

| Token | Hex | Use |
|---|---|---|
| `ember-50`  | `#fff3e6` | faint glow on light surfaces |
| `ember-100` | `#ffe1c2` | tints, hover wash |
| `ember-200` | `#ffc187` | |
| `ember-300` | `#ff9d4d` | |
| `ember-400` | `#ff7a1a` | secondary accent |
| **`ember-500`** | **`#ff6a00`** | **primary accent (dark mode) — the ember** |
| **`ember-600`** | **`#f25c00`** | **primary accent (light mode)** |
| `ember-700` | `#cc4a00` | press / active |
| `ember-800` | `#a23a00` | |
| `ember-900` | `#7a2c00` | deep coal edge |

### Glow gradient (the "live ember")
`linear-gradient(180deg, #ffb24d 0%, #ff7a1a 45%, #ff4d00 100%)`
Center-out radial for the mark: `radial-gradient(circle, #ffd089 0%, #ff7a1a 38%, #ff4d00 70%, #7a2c00 100%)`

### Night / neutrals (the dark we light)
| Token | Hex | Use |
|---|---|---|
| `night-0` | `#000000` | app background (true black) |
| `night-1` | `#0e0d0c` | raised surfaces (warm-shifted near-black) |
| `night-2` | `#1a1816` | cards / fields (warm graphite) |
| `night-3` | `#2a2724` | fills |
| `night-4` | `#3a3531` | strong fills / borders |
| `ash`      | `#8a8079` | warm muted text |
| `smoke`    | `#c9c2bb` | warm secondary text |
| `bone`     | `#f5efe8` | warm white text / light-mode bg |

> Neutrals are **warm-shifted** (a hair toward brown/orange) vs. the current pure-gray iOS
> grays — so the whole app feels lit by fire, not by a screen. Subtle; do not overcook.

### System states
- success / warm-session: `#34c759` (keep iOS green)
- danger: `#ff453a`
- **warmth dots** (the product's real session states):
  - **warm** = `ember-500` `#ff6a00`, with a soft `0 0 8px` glow (pulsing, alive)
  - **idle** = `ember-300` `#ff9d4d` at 70%, no glow (coals dimming)
  - **cold** = `ash` `#8a8079` (gone out)

## 3. Typography

- **UI / body:** keep the native stack — `-apple-system, "SF Pro Text/Display", system-ui`.
  (The app is iOS-native; don't fight it.)
- **Wordmark + marketing display:** a warm geometric humanist sans. Primary:
  **Bricolage Grotesque** (display) or **General Sans**; fallback `system-ui`. Lowercase
  `ember`, tight tracking `-0.02em`.
- **Mono (code, terminal, CLI):** `"SF Mono", "JetBrains Mono", ui-monospace`. Keep.
- **Marketing scale:** hero 64–88px / display 48 / h1 36 / h2 28 / body 17–19 / caption 14.
  Tracking: headings `-0.02em`, body `-0.01em`.

## 4. The logo system

**Mark — "the ember":** a single glowing coal. Construction: a soft-cornered irregular dot
(the live tip) with a `radial-gradient` core (`#ffd089 → #ff7a1a → #ff4d00`), a faint outer
bloom (`0 0 24px #ff6a00 at ~40% opacity`), and an optional charred-log base in `night-4`
beneath it. At favicon size it collapses to a hot orange dot with bloom — must read at 16px.

**Wordmark:** `ember` lowercase, warm geometric sans, `bone`/`night` depending on bg. The
dot of a glow can replace nothing literal — instead the leading **e**'s counter or a trailing
spark carries an ember tint. Keep it clean; the mark does the heavy lifting.

**Lockups:** (a) mark-only (app icon, favicon, avatar), (b) mark + wordmark horizontal
(nav, site), (c) stacked (launch/hero). Clear space = height of the mark on all sides.

**The signature transition:** real macro ember in a fire → cross-dissolve/morph → the logo
mark, holding the same glow position and color temperature. Opens launch video + landing hero.

**Logo don'ts:** don't put the glow on a busy photo without a dark scrim; don't recolor the
ember cool; don't add a flame (it's an *ember*, post-flame — that's the whole point: it holds
heat *quietly* while you're away). Keep it a coal, not a campfire.

## 5. App → CSS variable mapping (the overhaul)

The app's `globals.css` already defines the dark theme via CSS vars. The overhaul is mostly
a token swap, not a rewrite:

| Existing var | Current (iOS) | → New (Ember) |
|---|---|---|
| `--ios-blue` (dark) | `#0a84ff` | `#ff6a00` (ember-500) |
| `--ios-blue` (light) | `#007aff` | `#f25c00` (ember-600) |
| `--ios-blue-press` | `#409cff` / `#0066d6` | `#cc4a00` (ember-700) |
| `--color-surface-0` (dark) | `#000000` | `#000000` (keep true black) |
| `--color-surface-1` (dark) | `#1c1c1e` | `#0e0d0c` (warm) |
| `--color-surface-2` (dark) | `#2c2c2e` | `#1a1816` (warm) |
| `--color-surface-3/4` (dark) | grays | `#2a2724` / `#3a3531` (warm) |
| `--color-text-secondary/muted` | cool gray | warm-shift toward `smoke`/`ash` |
| user chat bubble gradient | iOS blue grad | ember glow grad (`#ffb24d→#ff7a1a→#ff4d00`) |
| `brand.*` tailwind scale | iOS blue scale | ember scale (§2) |

Also: warmth dots → use the warm/idle/cold spec in §2 (this is the brand's hero moment *in*
the product — make the warm dot actually glow + breathe). Keep the green for "connected/plan
active". Keep code blocks GitHub-dark (devs expect it).

## 6. Components (inherit existing iOS components, re-tinted)

Buttons, segmented controls, bottom sheets, iMessage bubbles, frosted nav — all already exist
and are good. Rules for the overhaul:
- **Primary button:** `ember-500/600` fill, white text, soft ember glow shadow
  `0 2px 16px rgba(255,106,0,0.35)` (the "slight glow behind buttons" — on brand literally).
- **Focus / active / links:** ember, not blue.
- **Hover wash:** `ember-50/100` tint on light; `rgba(255,106,0,0.10)` on dark.
- **Radius:** keep `13px` / `18px` iOS radii.
- Don't redesign component *structure* — only color, glow, and warmth.

## 7. Marketing surface rules

- **Background:** true-black / night-woods. One light source: the ember. Heavy use of dark
  imagery with a single warm glow focal point.
- **Photography:** real campfires, golden-hour + night, faces lit by firelight, laptop closed,
  outdoors. Grainy, warm, alive. Never sterile stock.
- **Glow physics:** light blooms outward from the ember; everything else falls into warm dark.
  Use radial gradients and soft `box-shadow` bloom, not flat fills, for hero elements.
- **Motion:** slow breathe on the ember (scale 1.0→1.03, glow opacity 0.6→1.0, ~2.5s ease),
  sparks drifting up, sections fading in from the dark like firelight reaching them.
- **Negative space is the dark.** Let it be mostly black with pools of warm light.

## 8. Don'ts (brand-wide)

- No cool/blue accents anywhere in marketing (blue was the *old* iOS identity).
- No flames in the logo — it's a banked ember (holds heat while you're away = the pitch).
- Don't overuse campfire puns; let the metaphor breathe.
- Don't make it look corporate-enterprise; it's open-source-first, warm, human.
- Never sterile/clinical. If it doesn't feel like it's lit by a fire, it's off-brand.
