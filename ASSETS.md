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
| `design/icon-monogram-source.png` | AI-generated production artwork based on the user-selected C monogram concept; blue-and-white folded S |
| `public/assets/favicon-monogram-32.png`, `apple-touch-icon-monogram.png`, `icon-monogram-192.png`, `icon-monogram-512.png` | Resized opaque PNG exports of the selected monogram source |

The user selected concept C: a folded white S with pale-lavender shading on the original vivid blue theme (`#3b45fd` to `#1f2afd`). The full-resolution source is retained in `design/icon-monogram-source.png` and is not included in the Pages build. The browser favicon is 32 × 32, the iPhone Home Screen icon is 180 × 180, and the manifest includes 192 × 192 and 512 × 512 versions. All exports are opaque full-bleed squares; iOS applies its own corner mask. New monogram filenames avoid reusing cached house artwork. The original house icon assets are retired.

Live facility cards use image URLs returned by the configured estate API. Demo facilities reuse category photos and use synthetic account, unit, slot and reservation identifiers. Original estate URLs and the source payment image are retained only in the private local workspace.

The payment QR is rendered locally from the original payment payload supplied through deployment settings. Its contents and destination are unchanged. Payment instructions appear after a confirmed reservation; the simulator never displays real payment instructions. No payment image is tracked in this repository.

Resident entry QRs are generated locally from the signed-in owner's entry identity; no personal QR is shipped as an asset. The encoder is **qrcode-generator 2.0.4** by Kazuhiko Arase (MIT), vendored at `public/vendor/qrcode.mjs`. The npm tarball's published SHA-512 integrity was verified before extraction. The original file SHA-256 is `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0`; the notice and license are in `public/vendor/QR-LICENSE.txt`. QR tests use the independent jsQR decoder; IndexedDB tests use fake-indexeddb. Both are development-only dependencies.
