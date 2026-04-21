# UI Style Guide — 9323 Account Navigator palette

**Source of truth**: `tools/account-navigator/public/index.html` at
`http://localhost:9323/navigator/`. Every surface across the two dashboards
(9323, 9324) and both navigators should migrate toward this palette.

No code changes are applied by this document — it's a reference so the
CSS unification PR has a single target.

## Tokens

### Base layers
| Purpose | Value | Tailwind class |
|---|---|---|
| Page background (gradient) | `linear-gradient(to bottom, slate-950 → #0a1628 → slate-950)` | `bg-gradient-to-b from-slate-950 via-[#0a1628] to-slate-950` |
| Primary surface | `rgba(15,23,42,0.4)` (slate-900 @ 40%) with backdrop-blur | `bg-slate-900/40 backdrop-blur-sm` |
| Nested / elevated surface | `rgba(2,6,23,0.5)` (slate-950 @ 50%) | `bg-slate-950/50` |
| Header card | `bg-slate-900/40` + `border-cyan-500/20` + `shadow-cyan-950/20` |   |

### Accents (primary brand — teal/cyan)
| Purpose | Value | Tailwind |
|---|---|---|
| Primary accent | `cyan-500` / `cyan-600` | `bg-cyan-600 hover:bg-cyan-500` |
| Accent border (subtle) | `border-cyan-500/20` | `border-cyan-500/20` |
| Accent text | `text-cyan-400/90` (uppercase eyebrows) | `text-cyan-400/90` |
| Primary button shadow | `shadow-cyan-900/30` | `shadow-lg shadow-cyan-900/30` |

### Text hierarchy
| Role | Class |
|---|---|
| Primary text | `text-slate-200` (body default) |
| Emphasized | `text-slate-100` |
| Secondary | `text-slate-400` |
| Muted / hints | `text-slate-500` |
| Uppercase eyebrow | `text-[0.65rem] uppercase tracking-[0.22em] text-cyan-400/90` |

### Semantic accents
| Purpose | Primary colour |
|---|---|
| Success / Launch confirmations | emerald — `bg-emerald-600`, `border-emerald-600/50`, `text-emerald-100` |
| Destructive (Close / Abort) | red — `border-red-500/40 bg-red-950/40 text-red-200 hover:bg-red-900/50` |
| Warning / Mongo block | amber — `border-amber-500/30 bg-amber-950/20 text-amber-200` |
| Info / link | cyan / blue — `text-cyan-300`, `text-blue-300` |

### Borders
| Role | Value |
|---|---|
| Default card border | `border border-white/10` |
| Accent border | `border border-cyan-500/20` |
| Warning border | `border border-amber-500/30` |

### Radii + spacing
- Buttons: `rounded-lg`, height `36px` via `ctrl-h9`
- Cards: `rounded-xl`, padding `p-4`–`p-5`
- Section gaps: `mb-6` between blocks

## Components to align

| Component | Repo | Current | Target |
|---|---|---|---|
| Dashboard top controls | playwright/dashboard | mixed blue buttons | cyan primary + red destructive |
| Dashboard top controls | playwright_hackathon/dashboard | mixed indigo | cyan primary + red destructive |
| Hackathon navigator Launch/Next | playwright_hackathon/tools/account-navigator | `bg-blue-600` | `bg-cyan-600 hover:bg-cyan-500 shadow-cyan-900/30` |
| env-manager `+` / `−` | all surfaces | cyan / red tints | already on-palette; keep |
| Mongo warning block | all | amber | already on-palette; keep |

## Do nots

- Don't introduce new brand colours (indigo, purple, green outside emerald-success).
- Don't use raw Tailwind slate-700/800 backgrounds — use the `/40`, `/50` alpha variants so the gradient reads through.
- Don't bold-colour secondary text beyond `text-slate-400`. Cyan is reserved for accent eyebrows and primary CTAs only.

## Migration checklist

- [ ] Extract tokens into `ui-tokens.css` under each repo's `dashboard/` + `tools/account-navigator/public/`
- [ ] Replace inline `bg-blue-600` Launch buttons with cyan equivalents
- [ ] Unify Abort/Close buttons to the red-border pattern
- [ ] Confirm amber Mongo block unchanged
- [ ] Screenshot diff before/after each surface
