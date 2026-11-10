# teriac brand

A block of infrastructure being built: its sides are solid, its top is still a dashed outline.
Planned, then applied, which is what teriac does. One flat colour (indigo `#4f46e5`, or `#818cf8`
on dark backgrounds); the mark and favicon switch between them with the viewer's theme. The mark
and wordmark are drawn as shapes, not type, so they look the same everywhere.

| File | Use |
|---|---|
| `teriac-logo.svg` / `.png` | Mark and wordmark, on light backgrounds (docs header) |
| `teriac-logo-dark.svg` / `.png` | The same, on dark backgrounds |
| `teriac-mark.svg`, `teriac-mark-512.png` | The mark alone (app icons, small spaces) |
| `teriac-app-icon.svg` / `.png` | Square icon, 512×512, full-bleed (no lettering): GitHub App logo, app stores, chat bots |
| `teriac-avatar.svg` / `.png` | Round profile picture: social profiles |
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
