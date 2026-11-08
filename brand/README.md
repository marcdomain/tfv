# tfv brand

A block for infrastructure whose top meets the sides in a **v**, for versions, with a fainter
**v** below it for the versions stacked underneath. The mark and wordmark are drawn as shapes, not
type, so they look the same everywhere.

| File | Use |
|---|---|
| `tfv-logo.svg` / `.png` | Mark and wordmark, on light backgrounds (docs header) |
| `tfv-logo-dark.svg` / `.png` | The same, on dark backgrounds |
| `tfv-mark.svg`, `tfv-mark-512.png` | The mark alone (app icons, small spaces) |
| `tfv-avatar.svg` / `.png` | Round profile picture: GitHub App, social |
| `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` | Browser tab and home screen |
| `social-preview.png` | 1280×640 link preview: GitHub repo social preview, Open Graph image for the website |

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

**Colours**

| | Hex |
|---|---|
| Top face | `#c7d2fe` → `#8b9bfb` |
| Left face | `#6d6af7` → `#4f46e5` |
| Right face | `#4338ca` → `#312e81` |
| Avatar background | `#1e1b4b` → `#3730a3` |
| Ink (light / dark) | `#0f172a` / `#f8fafc` |

Leave clear space around the logo of at least half the mark's height. Don't recolour,
stretch or add effects to it. The PNGs have transparent backgrounds.
