# Before / after — Cloud Code (iOS blue) → Ember

A re-skin, not a redesign. Same iOS-native components, same layout, same radii and
motion. We swapped the light source: **iOS blue → ember glow**, and warm-shifted the
night so the whole app feels lit by a fire instead of a screen.

| Surface | Before (Cloud Code) | After (Ember) |
|---|---|---|
| **Brand accent (dark)** | iOS blue `#0a84ff` | ember-500 `#ff6a00` |
| **Brand accent (light)** | iOS blue `#007aff` | ember-600 `#f25c00` |
| **Press / active** | `#409cff` / `#0066d6` | ember-700 `#cc4a00` |
| **App bg (dark)** | true black `#000000` | true black `#000000` (kept — the night) |
| **Raised surface 1 (dark)** | `#1c1c1e` cool graphite | `#0e0d0c` warm near-black |
| **Card / field 2 (dark)** | `#2c2c2e` | `#1a1816` warm graphite |
| **Fills 3 / 4 (dark)** | `#3a3a3c` / `#48484a` | `#2a2724` / `#3a3531` warm |
| **Primary text (dark)** | pure white `#ffffff` | bone `#f5efe8` |
| **Secondary text** | cool gray `rgba(235,235,245,…)` | smoke `#c9c2bb` warm |
| **Muted text** | cool gray | ash `#8a8079` warm |
| **User chat bubble** | iOS-blue gradient | ember glow `#ffb24d→#ff7a1a→#ff4d00` |
| **Buttons / links / focus** | blue | ember + soft glow shadow `rgba(255,106,0,.35)` |
| **`brand.*` Tailwind scale** | iOS-blue 50–900 | ember 50–900 |
| **Warmth dot — warm** | iOS green, static | ember-500 **glowing + breathing** (the hero moment) |
| **Warmth dot — idle** | amber 80% | ember-300, dimmer (coals dimming) |
| **Warmth dot — cold** | muted gray | ash (gone out) |
| **"Connected / plan active"** | iOS green | iOS green (kept — per design.md §5) |
| **Code blocks** | GitHub-dark | GitHub-dark (kept — devs expect it) |
| **Favicon / app icon** | blue Cloud glyph | ember coal mark + bloom |
| **Light-mode bg** | cool `#f2f2f7` | warm bone `#f2efe9` |

## What deliberately did NOT change
- Component structure, layout, iOS radii (13/18px), springy press + sheet motion.
- True-black dark background (it *is* the night woods).
- The GitHub-dark code editor + syntax highlighting.
- The green "connected/plan-active" state.

## The single biggest visual win
The warmth dot. The product literally has warm/idle/cold session states — before, the
"warm" dot was a flat green pip. Now it is the brand mark itself: an ember-500 coal that
**glows and breathes** (scale 1→1.18, bloom 0→1, 2.6s). idle dims to a no-glow amber;
cold goes to dead ash. The brand metaphor becomes a live, on-screen mechanic — exactly
the "make the warm dot actually glow + breathe" note in design.md §5.

See `preview.png` for the rendered swatch sheet.
