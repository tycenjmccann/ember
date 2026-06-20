# Ember — Launch visual assets (specs + ready prompts)

Brand rules every asset must obey (from `design.md` / `brand-concept.md`):
- **World:** night woods, true black, ONE warm light source — the ember. Negative space is
  the dark; pools of warm light, not flat fills.
- **Palette:** ember-500 `#ff6a00`, glow grad `#ffb24d → #ff7a1a → #ff4d00`; night `#000 /
  #0e0d0c / #1a1816 / #2a2724 / #3a3531`; bone `#f5efe8`; ash `#8a8079`.
- **Mood:** real, grainy, warm, alive. Golden-hour + night. Faces lit by firelight, **laptop
  closed.** Never sterile/stock. No cool/blue accents anywhere.
- **The mark is an ember, post-flame** — a glowing coal with a soft bloom. **No flames in the
  logo.** Glow blooms outward; everything else falls into warm dark.
- **Wordmark:** `ember`, lowercase, warm geometric sans (Bricolage Grotesque / General Sans),
  tight tracking. Put it on a dark scrim over any photo.

> Always composite the real `ember-lockup-dark.svg` / `ember-icon.svg` over the generated
> imagery — do **not** ask the image model to draw the logo. Generate the *scene*, place the
> *vector* mark.

---

## 1. GitHub social card — 1280 × 640

**Purpose:** the repo's social preview (Settings → Social preview). Reads at small size.
**Layout:** true-black field, lower-left pool of warm light. `ember` lockup (mark + wordmark)
centered-left at ~30% width. Tagline beneath in bone. A faint drift of sparks rising on the
right. Keep 80px safe margins.

**Text on card:**
- Wordmark: `ember`
- Tagline: **Keep your session warm.**
- Sub (ash, small): Claude Code + Codex · in your own AWS account · MIT

**Background image-gen prompt:**
> Extreme macro photograph of a single glowing ember coal on a bed of dark charred wood,
> deep true-black background fading to warm near-black at the edges, one soft orange-amber
> glow blooming outward (#ff7a1a to #ff4d00), faint sparks drifting up on the right side,
> cinematic low-key lighting, fine film grain, shallow depth of field, no flames, warm and
> alive, negative space on the left for text, 1280x640 landscape, photoreal.

---

## 2. OG / link-preview image — 1200 × 630

**Purpose:** shared on X, Slack, LinkedIn, HN. Must land the emotion + the wedge instantly.
**Layout:** night-woods scene, a closed laptop on a log beside a campfire, screen dark/closed.
Bottom-third dark scrim. `ember` lockup top-left. Big bone headline. Wedge line in ash.

**Text on card:**
- Headline: **Close the lid. It's still burning.**
- Wedge (ash): Your coding agent keeps running — in your own AWS account.

**Background image-gen prompt:**
> Cinematic photograph at night in the woods, a closed silver laptop resting on a weathered
> log beside a small campfire, glowing orange coals casting warm light (#ff6a00) on the laptop
> lid and surrounding bark, dark pine treeline silhouette behind, deep black sky, a few embers
> drifting upward, golden-amber glow against warm black, film grain, shallow depth of field,
> relaxed and peaceful mood, no people, no flames in frame focus just glowing coals, 1200x630
> landscape, photoreal, room at top-left for a logo and dark scrim at the bottom for text.

---

## 3. Campfire hero photo treatment (landing hero / deck cover)

**Purpose:** the landing-page hero behind the headline; also deck title slide.
**Treatment:** warm, grainy, real. Single warm focal glow; everything else into warm dark.
Apply a subtle bottom-up dark gradient scrim so bone headline + ember CTA sit cleanly.
Hero motion (if animated): slow breathe on the ember (scale 1.0→1.03, glow opacity 0.6→1.0,
~2.5s ease), sparks drifting up.

**Variant A — the relief (people, laptop closed):**
> Cinematic wide photograph, golden-hour into dusk on a beach, two friends relaxed around a
> small bonfire roasting marshmallows, faces warmly lit by firelight, a closed laptop set
> aside on a blanket, glowing coals as the single light source, deep warm-black surroundings,
> ocean and dark sky behind, soft orange-amber glow (#ff7a1a), drifting sparks, film grain,
> shallow depth of field, peaceful and unhurried, photoreal, wide negative space of warm dark
> sky at top for headline text.

**Variant B — the macro ember (abstract, brand-pure):**
> Extreme macro photograph of one live ember at the tip of a thick charred log, glowing
> orange-to-deep-red core (#ffd089 center to #ff4d00 to #7a2c00 edge) with a soft radial bloom,
> surrounded by total warm-black darkness, faint sparks lifting, no flame, intensely warm and
> alive, fine grain, cinematic, the single point of light in the dark, photoreal, vertical or
> square crop, heavy negative space of black.

**Variant C — dutch oven in the woods (lifestyle):**
> Cinematic night photograph in a forest clearing, a cast-iron dutch oven nestled in glowing
> orange coals, warm firelight on a person's relaxed hands and a tin mug nearby, dark pine
> trees and night sky behind, embers drifting up, deep warm-black with one warm glow source
> (#ff6a00), film grain, cozy and handled, no stress, photoreal.

---

## 4. Signature launch-video opener — macro coal → logo morph

**The single most important asset.** A real ember in a fire morphs into the Ember logo mark,
holding the same glow position and color temperature. Opens the launch video and the landing
hero. ~6–8 seconds.

**Shot list:**

1. **0.0–2.0s — Cold open, the dark.** Pure black. Faint ambient warm flicker bottom-edge.
   Distant night-woods ambience (crackle, crickets). Hold the dark; let it breathe.

2. **2.0–4.5s — The breathe.** Slow push-in (macro) on a single ember on a charred log. It
   *breathes* — glow brightens and dims (opacity 0.6→1.0, scale 1.0→1.03, ~2.5s ease), as if
   air just hit it. One or two sparks lift and fade. Sound: a soft whoosh of breath, the coal
   ticking. This is "the work is still warm."

3. **4.5–6.0s — The morph.** The ember's glowing core cross-dissolves / morphs into the Ember
   logo mark — same position, same color temperature (`#ffd089 → #ff7a1a → #ff4d00` radial),
   same soft bloom. The charred-log base resolves into the mark's coal base (night-4). Real
   fire → brand, seamless.

4. **6.0–7.5s — The wordmark.** `ember` wordmark fades up beside/below the mark in bone, tight
   tracking. Tagline beneath: **Keep your session warm.** Bloom settles into a steady, alive
   glow (don't kill the breathe entirely — a slow pulse stays).

5. **7.5–8.0s — Hold + CTA.** Mark + wordmark + tagline on warm black. A single ember CTA chip
   appears: `./install.sh` or the repo URL in mono. Sparks drift faintly. Cut to black on the
   last spark.

**Generation notes:**
- Generate the macro-ember footage (steps 1–3) as photoreal video; do the morph + wordmark in
  post (After Effects / Remotion) so the logo is the real vector, not generated.
- Color-grade everything to the ember palette; crush blacks to true black; warm-shift midtones.
- Keep it quiet and confident — no hype-bro music. Low ambient drone + fire crackle + one warm
  swell on the morph.

**Macro-ember footage prompt (steps 1–3):**
> Extreme macro slow-motion video of a single glowing ember on a charred log in total
> darkness, the coal breathing — pulsing brighter and dimmer as if air hits it, orange-amber
> core (#ff7a1a) with deep-red edges (#ff4d00) and a soft outward bloom, one or two sparks
> drifting upward and fading, deep true-black surroundings, no open flame, cinematic, fine
> film grain, shallow depth of field, intimate and warm, slow push-in, photoreal, the single
> point of light in the dark.

---

## Asset checklist

| Asset | Size | Logo source | Where it ships |
|---|---|---|---|
| GitHub social card | 1280×640 | `ember-lockup-dark.svg` | repo social preview |
| OG image | 1200×630 | `ember-lockup-dark.svg` | X / Slack / HN / PH link previews |
| Campfire hero | flexible | `ember-lockup-dark.svg` | landing hero, deck cover |
| Coal→logo morph | 8s, 1080p+ | `ember-icon.svg` (post) | launch video opener, landing hero |
| Favicon / app icon | from `ember-favicon.svg` / `ember-icon.svg` | (existing) | site, app |
