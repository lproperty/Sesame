# Asset provenance

The photographs are estate assets reused from the supplied native app and facility API. They do not imply estate endorsement.

| Asset                                                                               | Source                                                             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `public/assets/estate.jpg`                                                          | Supplied native app's clubhouse banner                             |
| `public/assets/function-room.png`                                                   | Facility API's function room image                                 |
| `public/assets/tennis.png`                                                          | Facility API's tennis court image                                  |
| `public/assets/games.png`                                                           | Facility API's games room image                                    |
| `public/assets/bbq.png`                                                             | Facility API's outdoor dining image                                |
| `public/assets/music.png`                                                           | Facility API's music room image                                    |
| `public/assets/favicon.svg`                                                         | Original minimal house symbol in a blue-and-white gradient palette |
| `public/assets/apple-touch-icon-home.png`, `icon-home-192.png`, `icon-home-512.png` | Raster versions of the original house symbol                       |

The iPhone Home Screen icon is an opaque 180 × 180 PNG; iOS applies its own corner mask. The manifest includes 192 × 192 and 512 × 512 versions. The home icon filenames let browsers fetch the new artwork independently of older cached letter icons. The design uses one rounded house silhouette and an open doorway, with no text or decorative details. The SVG retains the editable vector design. No third-party logo artwork is included in the app.

Live facility cards use image URLs returned by the configured estate API. Demo facilities reuse category photos and use synthetic account, unit, slot and reservation identifiers. Original estate URLs and the source payment image are retained only in the private local workspace.

The payment QR is rendered locally from the original payment payload supplied through deployment settings. Its contents and destination are unchanged. Payment instructions appear after a confirmed reservation; the simulator never displays real payment instructions. No payment image is tracked in this repository.

Resident entry QRs are generated locally from the signed-in owner's entry identity; no personal QR is shipped as an asset. The encoder is **qrcode-generator 2.0.4** by Kazuhiko Arase (MIT), vendored at `public/vendor/qrcode.mjs`. The npm tarball's published SHA-512 integrity was verified before extraction. The original file SHA-256 is `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0`; the notice and license are in `public/vendor/QR-LICENSE.txt`. QR tests use the independent jsQR decoder; IndexedDB tests use fake-indexeddb. Both are development-only dependencies.
