// Génère un fichier icon.ico minimal (32x32, bleu OptiQ avec "O")
// Utilise uniquement des modules Node.js natifs
const fs = require('fs')
const path = require('path')

// ICO = BMP 32x32 bleu (#1A237E) avec lettre O blanche au centre
// On génère un PNG base64 encodé embarqué dans l'ICO via le format PNG-in-ICO (Windows Vista+)

// PNG 32x32 bleu #1A237E avec "O" blanc — généré pixel par pixel via chunks PNG manuels
function createMinimalPNG(size, bgR, bgG, bgB) {
  // Utilise le module zlib pour la compression
  const zlib = require('zlib')

  // Créer les données image RGBA
  const pixels = []
  const cx = size / 2
  const cy = size / 2
  const outerR = size * 0.38
  const innerR = size * 0.22

  for (let y = 0; y < size; y++) {
    pixels.push(0) // filter byte
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy
      const dist = Math.sqrt(dx*dx + dy*dy)
      // Anneau "O" blanc
      if (dist <= outerR && dist >= innerR) {
        pixels.push(255, 255, 255, 255) // blanc opaque
      } else {
        pixels.push(bgR, bgG, bgB, 255) // fond bleu
      }
    }
  }

  const raw = Buffer.from(pixels)
  const compressed = zlib.deflateSync(raw, { level: 9 })

  function chunk(type, data) {
    const buf = Buffer.alloc(12 + data.length)
    buf.writeUInt32BE(data.length, 0)
    buf.write(type, 4, 'ascii')
    data.copy(buf, 8)
    // CRC32
    const crc = crc32(Buffer.concat([Buffer.from(type, 'ascii'), data]))
    buf.writeInt32BE(crc, 8 + data.length)
    return buf
  }

  function crc32(buf) {
    let crc = 0xFFFFFFFF
    const table = crc32.table || (crc32.table = (() => {
      const t = []
      for (let i = 0; i < 256; i++) {
        let c = i
        for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
        t.push(c)
      }
      return t
    })())
    for (const byte of buf) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
    return (crc ^ 0xFFFFFFFF) | 0
  }

  const sig    = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr   = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  const ihdrChunk = chunk('IHDR', ihdr)
  const idatChunk = chunk('IDAT', compressed)
  const iendChunk = chunk('IEND', Buffer.alloc(0))

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk])
}

function pngToIco(pngBuf) {
  // ICO header
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)   // reserved
  header.writeUInt16LE(1, 2)   // type: 1 = ICO
  header.writeUInt16LE(1, 4)   // count: 1 image

  // Image directory entry (16 bytes)
  const entry = Buffer.alloc(16)
  entry[0] = 0   // width  (0 = 256)
  entry[1] = 0   // height (0 = 256)
  entry[2] = 0   // color count
  entry[3] = 0   // reserved
  entry.writeUInt16LE(1, 4)              // planes
  entry.writeUInt16LE(32, 6)             // bit count
  entry.writeUInt32LE(pngBuf.length, 8)  // size of image data
  entry.writeUInt32LE(22, 12)            // offset = 6 + 16

  return Buffer.concat([header, entry, pngBuf])
}

const png = createMinimalPNG(256, 0x1A, 0x23, 0x7E) // bleu OptiQ
const ico = pngToIco(png)
const outPath = path.join(__dirname, 'assets', 'icon.ico')
fs.writeFileSync(outPath, ico)
console.log(`Icon créée : ${outPath} (${ico.length} bytes)`)
