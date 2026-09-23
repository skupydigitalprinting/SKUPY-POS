# Automatic Product Thumbnails

Approved 2026-09-11. UI-only fallbacks; no product image URL is written to the
database. Uploaded photos take priority. Sample/sampel names use SAMPEL text;
unknown titles use their own text. Raw material titles do not imply finished
garments. Failed images terminate at a text thumbnail without automatic retries.

Assets below were created with the built-in image generation tool, not fetched
from a third-party product listing. They are generic illustrations, not photos
of the customer's actual custom product. The UI marks them as Ilustrasi.

## Asset Prompts

`public/product-placeholders/bordir.png`

Use case: product-mockup. Create one square catalog illustration for an
Indonesian custom printing POS product thumbnail: embroidery service (bordir).
Show a centered round embroidery hoop with off-white fabric holding a small teal
and red geometric stitched emblem, with a spool of teal thread nearby. Clearly
visible realistic raised embroidery stitches, clean commercial studio photo-like
illustration, soft light gray background #eef0f2, entire objects within central
65% of frame, ample empty margins, no people, no logos, no text, no watermark.
This is a generic illustrative asset not an actual customer's product.

`public/product-placeholders/bendera.png`

Use case: product-mockup. One square catalog product illustration of a rectangular
Indonesian red-and-white flag made of fabric, red upper half white lower half,
attached to a simple short silver pole at left. Gently undulating cloth so
silhouette unmistakably a flag, entire flag and pole in frame centered, small
tabletop pole base optional. Neutral very light gray studio background #eef0f2,
soft studio light and subtle fabric texture, photo-like illustration for a
printing shop POS thumbnail. No people, no landscape, no symbols or logos, no
text, no watermark. Keep generous clear margins for UI badges.

`public/product-placeholders/scarf.png`

Use case: product-mockup. Create one square photo-like catalog illustration of a
single teal square scarf / hijab fabric elegantly draped and loosely folded on
a clean light gray #eef0f2 studio surface. Show soft lightweight woven fabric
texture and complete edges, recognizably a scarf, full object centered with clear
margins on all sides for UI badges. Refined simple studio product lighting, no
model or mannequin, no text, no pattern, no logo, no watermark, no accessories.
Intended generic scarf illustration for an Indonesian custom printing shop POS
thumbnail.

## Verification

- Regression-first tests reproduced missing name rules and the box-icon fallback.
- Root tests: 249 passed, no failures or skips after final component changes.
- Browser screenshots checked at 1366x900 and 390x844 using the actual shared
  React component with synthetic product titles, not production mutations.
- Confirmed complete text lines and no horizontal overflow; compact thumbnails
  checked at 32, 40, 48 and 60 pixels. Uploaded images remain ahead of fallbacks.
- Local production build passed; release uses remote Vercel production build
  for real environment injection, explicitly retaining legacy login mode.
- Release excludes API/server, SQL, environment files, tests, local previews and
  local build output. These assets do not activate the pending security cutover.

## Production Release

Deployment `dpl_GedV5NKqSrBRv8oLa4ceXFY1b5He` was built remotely, verified, and
promoted on 2026-09-11:
https://skupy-bjxohqagv-hardha-perdana-s-projects.vercel.app

Public https://pos.skupy.id/ was verified to serve `/assets/index-Doz2RV35.js`
and `/assets/ui-BhJ4JcUj.js`. Both compiled files and all three new PNGs returned
HTTP 200 with hashes matching the inspected deployment and local assets.
Rollback reference: `dpl_6jh4qPyvbkzBw8K3LPuKKpyGKXpM`.
No Git push, database mutation or Auth migration was performed.

Read-only production UI check: the existing session remained signed in; Produk
listed 187 products, with SAMPEL on both sample items and loaded bordir, bendera
and scarf illustrations. The page loaded the new main bundle and reported no
browser warning/error logs. Images outside the viewport remain lazy-loaded.
