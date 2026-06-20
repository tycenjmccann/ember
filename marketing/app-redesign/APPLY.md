# Applying the Ember re-skin to the app

These are the exact, copy-pasteable changes to turn the blue Cloud Code app into
Ember. **Token-only** — no component structure changes. Verified against a
rendered swatch page (`preview.png`).

Files in this folder:
- `globals.ember.css` — drop-in replacement for `src/styles/globals.css`
- `tailwind.config.ember.js` — drop-in replacement for `tailwind.config.js`
- `preview.html` / `preview.png` — standalone token preview (render check)

---

## 1. Theme tokens — `src/styles/globals.css`

Easiest path: **replace the file** with `globals.ember.css` (it is the same file
with token swaps + a warmth-dot block added; all component CSS is byte-identical).

If you prefer a surgical diff, change exactly these vars:

### `:root` (light theme)
| Var | From | To |
|---|---|---|
| `--ios-blue` | `#007aff` | `#f25c00` (ember-600) |
| `--ios-blue-press` | `#0066d6` | `#cc4a00` (ember-700) |
| `--color-surface-0` | `#f2f2f7` | `#f2efe9` (warm) |
| `--color-surface-1/2` | `#ffffff` | `#fffaf4` (warm) |
| `--color-surface-3` | `#e5e5ea` | `#ece6dd` |
| `--color-surface-4` | `#d1d1d6` | `#ddd5c9` |
| `--color-text-primary` | `#000000` | `#1a1410` |
| `--color-text-secondary` | `rgba(60,60,67,0.6)` | `rgba(58,48,40,0.62)` |
| `--color-text-muted` | `rgba(60,60,67,0.45)` | `rgba(58,48,40,0.46)` |
| `--color-border-hover` | `rgba(0,122,255,0.5)` | `rgba(242,92,0,0.5)` |
| `--ios-nav-bg` | `rgba(249,249,251,0.8)` | `rgba(250,246,240,0.8)` |
| `--ios-fill-*` / `--ios-segment-*` | `rgba(118,118,128,…)` | `rgba(138,128,121,…)` (warm ash) |
| `--bubble-agent` | `#e9e9eb` | `#ece6dd` |
| Keep `--ios-green`, `--ios-red`, and all `--code-*` as-is. |

### `[data-theme="dark"]`
| Var | From | To |
|---|---|---|
| `--ios-blue` | `#0a84ff` | `#ff6a00` (ember-500) |
| `--ios-blue-press` | `#409cff` | `#cc4a00` (ember-700) |
| `--color-surface-1` | `#1c1c1e` | `#0e0d0c` (warm) |
| `--color-surface-2` | `#2c2c2e` | `#1a1816` (warm) |
| `--color-surface-3` | `#3a3a3c` | `#2a2724` (warm) |
| `--color-surface-4` | `#48484a` | `#3a3531` (warm) |
| `--color-text-primary` | `#ffffff` | `#f5efe8` (bone) |
| `--color-text-secondary` | `rgba(235,235,245,0.6)` | `rgba(201,194,187,0.66)` (smoke) |
| `--color-text-muted` | `rgba(235,235,245,0.42)` | `rgba(138,128,121,0.7)` (ash) |
| `--color-border` | `rgba(84,84,88,0.6)` | `rgba(58,53,49,0.85)` (warm) |
| `--color-border-hover` | `rgba(10,132,255,0.6)` | `rgba(255,106,0,0.6)` |
| `--ios-nav-bg` | `rgba(22,22,24,0.72)` | `rgba(14,13,12,0.72)` |
| `--ios-segment-active` | `#636366` | `#3a3531` |
| `--ios-separator` | `rgba(84,84,88,0.65)` | `rgba(58,53,49,0.8)` |
| `--bubble-agent` | `#262629` | `#1f1c19` |
| `--prose-body` | `rgba(235,235,245,0.82)` | `rgba(201,194,187,0.86)` (smoke) |
| Keep `--color-surface-0` `#000000` (true black), `--ios-green`, `--code-*`. |

### `.bubble-user` (both themes) — the iMessage user bubble → ember glow
Replace the blue gradient + shadow with the ember glow gradient:
```css
.bubble-user {
  background-image: linear-gradient(180deg, #ffb24d 0%, #ff7a1a 45%, #ff4d00 100%);
  color: #fff;
  border-radius: 21px;
  border-bottom-right-radius: 7px;
  box-shadow: 0 1px 2px rgba(255,106,0,0.32), 0 0 14px rgba(255,106,0,0.18);
}
[data-theme="dark"] .bubble-user {
  background-image: linear-gradient(180deg, #ffb24d 0%, #ff7a1a 45%, #ff4d00 100%);
}
```

### `.agent-output-prose blockquote` — blue wash → ember wash
`background: rgba(10,132,255,0.06)` → `rgba(255,106,0,0.07)`.
(The `border-left` already uses `var(--ios-blue)`, so it follows automatically.)

### New: warmth-dot helper classes
`globals.ember.css` adds `:root` ember tokens (`--ember-*`, `--coal`, `--glow-grad`,
`--bloom`, `--btn-glow`) plus `.warmth-dot--warm/idle/cold` (see step 4). Paste that
block in if you are diffing by hand.

---

## 2. Tailwind scale — `tailwind.config.js`

Replace with `tailwind.config.ember.js`, **or** swap just the color scales:

- `brand` 50–900: iOS-blue scale → ember scale
  (`#fff3e6 #ffe1c2 #ffc187 #ff9d4d #ff7a1a #ff6a00 #f25c00 #cc4a00 #a23a00 #7a2c00`).
- `ios.blue` already points at `var(--ios-blue)` — no change needed (it now resolves
  to ember via globals.css).
- Optional additions used by no existing component but available for marketing-grade
  in-app touches: `ember.*`, `night.*`, `ash/smoke/bone`, `shadow-ember/-bloom`,
  `bg-ember-glow/-coal`.

Radii (`ios` 13px / `ios-lg` 18px) and the typography plugin are unchanged.

---

## 3. Nav lockup + title — `src/components/layout/TopBar.tsx`

Currently a blue `Cloud` icon tile + "Cloud Code". Swap to the ember mark + wordmark.

Replace the icon-tile block (lines ~19–27) with the ember lockup. Drop the SVG into
`public/` first (see step 5), then:

```tsx
{/* ember mark */}
<img src="/ember-icon.svg" alt="" className="w-7 h-7 shrink-0" />
<h1 className="text-[17px] font-semibold tracking-tight text-[var(--color-text-primary)] truncate">
  ember
</h1>
```

Or, to keep it inline with no extra request, use the glowing-coal tile:
```tsx
<div
  className="w-7 h-7 rounded-[8px] shrink-0"
  style={{ background: "radial-gradient(circle,#ffd089 0%,#ff7a1a 38%,#ff4d00 70%,#7a2c00 100%)",
           boxShadow: "0 0 14px rgba(255,106,0,0.5)" }}
/>
```
The "Cost" link already uses `text-[var(--ios-blue)]` → it turns ember automatically.

> The same blue Cloud-tile gradient (`linear-gradient(180deg,#3a98ff,#007aff)`) and
> `rgba(0,122,255,…)` shadows are repeated inline in `src/app/cloud-code/page.tsx`
> (session avatars, FAB, empty-state icon — lines ~280, 351, 361, 684 etc.). Replace
> each with the coal radial + ember shadow `rgba(255,106,0,…)` for full coverage.
> These are inline literals, not tokens, so they do NOT follow globals.css.

---

## 4. Session warmth dots — `src/app/cloud-code/page.tsx` (the brand hero moment)

Today (lines ~21–26) warmth is mapped to **green/amber/gray** — off-brand. The dot
should be the ember itself. Replace `WARMTH_DOT` with the new classes:

```tsx
const WARMTH_DOT: Record<SessionWarmth, string> = {
  warm: "warmth-dot warmth-dot--warm",   // ember-500, glow + breathe
  idle: "warmth-dot warmth-dot--idle",   // ember-300, dimmer
  cold: "warmth-dot warmth-dot--cold",   // ash, gone out
};
```
(`globals.ember.css` defines `.warmth-dot--warm/idle/cold` + the `warmthBreathe`
keyframes.) Adjust the dot `<span>` at line ~286 to drop the fixed `w-2.5 h-2.5`
since `.warmth-dot` sets size, or keep the ring class — both compose fine.

Keep the green **connected/plan-active** indicator in the CLI-config sheet
(`AuthStatus`, `status[r.cli]`, line ~918) — that is "plan active", not session
warmth, and design.md §5 says keep green there.

---

## 5. Favicon / app icon / theme color

### Copy assets into `public/` (Next.js serves it at web root)
```bash
mkdir -p public
cp marketing/brand/logo/ember-favicon.svg     public/favicon.svg
cp marketing/brand/logo/favicon-32.png         public/favicon-32.png
cp marketing/brand/logo/apple-touch-icon.png   public/apple-touch-icon.png
cp marketing/brand/logo/ember-icon.svg         public/ember-icon.svg
cp marketing/brand/logo/ember-icon-512.png     public/icon-512.png
```

### `src/app/layout.tsx` — metadata + theme color
```tsx
export const metadata: Metadata = {
  title: "Ember",
  description: "Keep your session warm. A resumable coding agent that runs in your own AWS account.",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Ember" },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};
```
Update the light `themeColor` from `#f2f2f7` → `#f2efe9` (warm); keep dark `#000000`.

---

## 6. Verify

```bash
AWS_PROFILE=<profile> npm run dev   # http://localhost:3000
```
Check, in dark mode: TopBar shows the ember mark; the New-session FAB / "Cost" link /
input focus ring / send button are all ember; a warm session pulses an orange glow dot;
user chat bubbles are the ember gradient; code blocks are still GitHub-dark; the green
"connected" check still reads green. Toggle to light mode and confirm warm bone surfaces.
