# Asset provenance

The photographs and payment QR are estate assets reused from the supplied APK and image URLs returned by the facility API.

| Local asset                                                          | Source                                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `public/assets/estate.jpg`                                           | Supplied APK: `static/mainpage/banner.jpg`                                                                 |
| `public/assets/bank-transfer.jpg`                                    | Supplied APK: `static/common/GDBankTransfer.jpg`                                                           |
| `public/assets/function-room.png`                                    | Facility API image: `https://granddunman.intelliving.app/img-granddunman/jewel%20function%20room1_320.png` |
| `public/assets/tennis.png`                                           | Facility API image: `https://granddunman.intelliving.app/img-granddunman/tennis%20court_320.png`           |
| `public/assets/games.png`                                            | Facility API image: `https://granddunman.intelliving.app/img-granddunman/gameroom_320.png`                 |
| `public/assets/bbq.png`                                              | Facility API image: `https://granddunman.intelliving.app/img-granddunman/bbq1_320.png`                     |
| `public/assets/music.png`                                            | Facility API image: `https://granddunman.intelliving.app/img-granddunman/karaoke%20room_320.png`           |
| `public/assets/favicon.svg`                                          | Original simple letter G mark created for this web app                                                     |
| `public/assets/apple-touch-icon.png`, `icon-192.png`, `icon-512.png` | Original letter G app icons drawn for Sesame, using the existing mark and estate-green palette             |

The local APK workspace retains the original asset-preparation utility; normal startup does not download assets. Live facility cards use the image URL returned for each facility. Demo facilities reuse the appropriate category photo and use synthetic account, unit, slot and reservation identifiers.

The live GitHub Pages artifact includes the photographs, original app icons and `bank-transfer.jpg`. Payment instructions appear after a confirmed reservation. The optional `?demo=1` simulator never displays the real payment QR. Sesame is an independent resident portal; these source assets do not imply estate endorsement.
