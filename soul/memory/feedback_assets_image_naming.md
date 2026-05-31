---
name: assets image naming convention
description: All image assets (PNG/JPG/WEBP/SVG) prefixed image-<category>-<descriptor> for prefix-as-fake-folder organization
type: feedback
originSessionId: 32770bc4-7264-4ac1-a676-e717e4a133f6
---
All image files in any project's flat asset directory get prefix `image-<category>-<descriptor>.<ext>`. Established categories: `background`, `blog`, `icon` (covers SVG icons too), `logo`, `portrait` (people), `product`, `project` (3-step tile imagery and similar grouped assets). New categories may be added as needed.

**Why:** Shopify themes (and similar platforms) require a flat asset directory with no subdirectories. The prefix gives alphabetical sort the grouping behavior of a folder structure without violating the platform constraint. Mixing image filenames with stylesheets and scripts in one directory becomes navigable when files cluster by prefix. Locked 2026-05-13 during the Starbrite Shopify Phase 3 asset organization pass.

**How to apply:** When adding any image asset to a project (Shopify theme, plugin, anywhere with flat asset layout), name it `image-<category>-<descriptor>.<ext>`. When renaming existing assets, batch-rename + sweep references in one pass. CSS files (`component-*.css`) and scripts (`theme.js`, `main.css`) keep their own prefix conventions, only image files get the `image-` prefix.
