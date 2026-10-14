// Значок: resources/icon.html (SVG) → resources/icon.png (512) → resources/icon.ico (16…256) и app/icon.ico.
// Запуск: npm run icon
const { app, BrowserWindow, nativeImage } = require('electron')
const { writeFileSync, copyFileSync } = require('node:fs')
const { join } = require('node:path')

app.whenReady().then(async () => {
  const root = join(__dirname, '..')
  const w = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
  await w.loadFile(join(root, 'resources', 'icon.html'))
  await new Promise((r) => setTimeout(r, 800))
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  const src = nativeImage.createFromBuffer(img.toPNG())
  writeFileSync(join(root, 'resources', 'icon.png'), src.resize({ width: 512, height: 512, quality: 'best' }).toPNG())
  const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
  const pngs = sizes.map((s) => src.resize({ width: s, height: s, quality: 'best' }).toPNG())
  const head = Buffer.alloc(6 + 16 * sizes.length)
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4)
  let offset = head.length
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i
    head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1); head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3)
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(offset, e + 12)
    offset += pngs[i].length
  })
  writeFileSync(join(root, 'resources', 'icon.ico'), Buffer.concat([head, ...pngs]))
  copyFileSync(join(root, 'resources', 'icon.ico'), join(root, 'app', 'icon.ico'))
  app.exit(0)
})
