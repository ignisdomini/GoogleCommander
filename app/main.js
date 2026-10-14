// Google Commander — главный процесс Electron.
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const config = require('./config')
const auth = require('./auth')
const drive = require('./drive')
const local = require('./local')
const { Job } = require('./transfer')
const i18n = require('./i18n')
const { t } = i18n

let win = null
let job = null
let jobSeq = 0

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })

// Растровые шрифты VGA из Windows — те самые, что были в DOS-окне:
// 866 (кириллица и псевдографика) и 850 (латиница с диакритикой для de/fr/es).
function readFon(names) {
  const dir = path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts')
  for (const f of names) {
    try {
      const b = fs.readFileSync(path.join(dir, f))
      const ne = b.readUInt32LE(0x3c)
      const rt = ne + b.readUInt16LE(ne + 0x24)
      const shift = b.readUInt16LE(rt)
      let p = rt + 2
      while (b.readUInt16LE(p)) {
        const type = b.readUInt16LE(p), cnt = b.readUInt16LE(p + 2)
        p += 8
        for (let i = 0; i < cnt; i++, p += 12) {
          if ((type & 0x7fff) !== 8) continue
          const off = b.readUInt16LE(p) << shift
          const w = b.readUInt16LE(off + 0x56), h = b.readUInt16LE(off + 0x58)
          const first = b[off + 0x5f], last = b[off + 0x60]
          if (w !== 8 || h !== 12) continue
          const glyphs = Buffer.alloc(256 * h)
          for (let c = first; c <= last; c++) {
            const e = off + 0x76 + (c - first) * 4
            const gOff = b.readUInt16LE(e + 2)
            b.copy(glyphs, c * h, off + gOff, off + gOff + h)
          }
          return { name: f, w, h, glyphs: glyphs.toString('base64') }
        }
      }
    } catch {}
  }
  return null
}

function createWindow() {
  const size = !app.isPackaged && /--size=(\d+)x(\d+)/.exec(process.argv.join(' '))
  const b = size ? { width: +size[1], height: +size[2], useContentSize: true } : config.get('bounds', { width: 1280, height: 800 })
  win = new BrowserWindow({
    ...b, minWidth: 640, minHeight: 400, backgroundColor: '#000000', show: false,
    title: 'Google Commander', icon: path.join(__dirname, 'icon.ico'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  })
  if (config.get('maximized')) win.maximize()
  win.once('ready-to-show', () => win.show())
  win.on('close', () => {
    config.set('maximized', win.isMaximized())
    if (!win.isMaximized() && !win.isFullScreen()) config.set('bounds', win.getBounds())
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.loadFile(path.join(__dirname, 'ui', 'index.html'))

  // проверка без участия человека: --shot=файл.png [--keys=F9,ArrowRight,...] [--wait=мс]
  const arg = (n) => process.argv.find((a) => a.startsWith('--' + n + '='))?.slice(n.length + 3)
  const shot = !app.isPackaged && arg('shot')
  if (shot) {
    win.webContents.once('did-finish-load', async () => {
      const wait = Number(arg('wait') || 2500)
      await new Promise((r) => setTimeout(r, wait))
      for (const k of (arg('keys') || '').split(',').filter(Boolean)) {
        if (/^sleep\d+$/.test(k)) { await new Promise((r) => setTimeout(r, Number(k.slice(5)))); continue }
        const [mod, key] = k.includes('+') ? k.split('+') : [null, k]
        const modifiers = mod ? [mod] : []
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
        if (key.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: key, modifiers })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
        await new Promise((r) => setTimeout(r, 400))
      }
      await new Promise((r) => setTimeout(r, 600))
      const img = await win.webContents.capturePage()
      fs.writeFileSync(shot, img.toPNG())
      app.exit(0)
    })
  }
}

const ok = (fn) => async (_e, ...a) => {
  try { return { ok: true, value: await fn(...a) } } catch (e) { return { ok: false, error: e.message, code: e.code } }
}

function status() {
  return { hasClient: auth.hasClient(), logged: auth.isLoggedIn(), clientId: auth.client().id }
}

function setClient(id, secret) {
  config.set('clientId', String(id || '').trim())
  config.setSecret('clientSecret', String(secret || '').trim() || null)
}

function ipc() {
  ipcMain.handle('app:init', ok(async () => ({
    font: readFon(['vga866.fon', 'vgaoem.fon']), fontLat: readFon(['vga850.fon']), lang: i18n.lang, state: config.get('ui', {}), status: status(), version: app.getVersion(),
    demo: !app.isPackaged && process.argv.includes('--demo'),   // примерные данные Drive для скриншотов
  })))
  ipcMain.handle('app:saveState', ok((s) => config.set('ui', s)))
  ipcMain.handle('app:setLang', ok((l) => { i18n.setLang(l); config.set('lang', i18n.lang); return i18n.lang }))
  ipcMain.handle('app:quit', ok(() => app.quit()))
  ipcMain.handle('app:fullscreen', ok(() => win.setFullScreen(!win.isFullScreen())))
  ipcMain.handle('app:clipboard', ok((t) => clipboard.writeText(String(t))))
  ipcMain.handle('app:paste', ok(() => clipboard.readText()))
  ipcMain.handle('app:openUrl', ok((u) => {
    const url = new URL(u)
    if (url.protocol !== 'https:' || !/(^|\.)(google\.com)$/.test(url.hostname)) throw new Error(t('eBadLink'))
    return shell.openExternal(url.href)
  }))

  ipcMain.handle('auth:status', ok(() => status()))
  ipcMain.handle('auth:setClient', ok((id, secret) => { setClient(id, secret); return status() }))
  ipcMain.handle('auth:importClient', ok(async () => {
    const r = await dialog.showOpenDialog(win, { title: t('eKeyDialog'), filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return null
    const j = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'))
    const c = j.installed || j.web
    if (!c?.client_id) throw new Error(t('eKeyNoId'))
    if (!j.installed) throw new Error(t('eKeyWeb'))
    setClient(c.client_id, c.client_secret)
    return status()
  }))
  ipcMain.handle('auth:login', ok(async () => { await auth.login(); if (win) { if (win.isMinimized()) win.restore(); win.focus() } return status() }))
  ipcMain.handle('auth:cancel', ok(() => auth.cancel()))
  ipcMain.handle('auth:logout', ok(async () => { await auth.logout(); return status() }))

  ipcMain.handle('fs:drives', ok(() => local.drives()))
  ipcMain.handle('fs:list', ok((dir) => local.list(dir)))
  ipcMain.handle('fs:space', ok((dir) => local.space(dir)))
  ipcMain.handle('fs:mkdir', ok((dir, name) => local.mkdir(dir, name)))
  ipcMain.handle('fs:rename', ok((dir, a, b) => local.rename(dir, a, b)))
  ipcMain.handle('fs:trash', ok((dir, names) => local.trash(dir, names)))
  ipcMain.handle('fs:open', ok(async (p) => { const e = await shell.openPath(p); if (e) throw new Error(e) }))
  ipcMain.handle('fs:edit', ok((p) => { spawn('notepad.exe', [p], { detached: true, stdio: 'ignore' }).unref() }))
  ipcMain.handle('fs:head', ok(async (p) => { const h = await local.head(p); return { ...h, data: h.data.toString('base64') } }))
  // существующая папка → её полный путь (C:\a\..\b → C:\b), иначе null
  ipcMain.handle('fs:exists', ok((p) => { const r = path.resolve(String(p)); return fs.existsSync(r) && fs.statSync(r).isDirectory() ? r : null }))
  // команда из командной строки — в отдельном окне cmd, как в DOS
  ipcMain.handle('fs:shell', ok((dir, cmd) => {
    spawn('cmd.exe', ['/k', String(cmd)], { cwd: dir, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref()
  }))
  ipcMain.handle('fs:explorer', ok((p) => shell.openPath(p)))

  ipcMain.handle('gd:about', ok(() => drive.about()))
  ipcMain.handle('gd:list', ok((id) => drive.list(id)))
  ipcMain.handle('gd:mkdir', ok((parent, name) => drive.mkdir(parent, name)))
  ipcMain.handle('gd:rename', ok((id, name) => drive.rename(id, name)))
  ipcMain.handle('gd:trash', ok(async (ids) => {
    const errors = []
    for (const id of ids) { try { await drive.trash(id) } catch (e) { errors.push(e.message) } }
    return errors
  }))

  ipcMain.handle('xfer:start', ok((spec) => {
    if (job) throw new Error(t('eBusy'))
    const id = ++jobSeq
    job = new Job(id, spec, (m) => win?.webContents.send('xfer:event', m))
    job.run().finally(() => { job = null })
    return id
  }))
  ipcMain.handle('xfer:answer', ok((id, askId, value) => { if (job?.id === id) job.answer(askId, value) }))
  ipcMain.handle('xfer:cancel', ok((id) => { if (job?.id === id) job.cancel() }))
}

app.whenReady().then(() => {
  config.load()
  i18n.setLang(config.get('lang') || i18n.pick(app.getPreferredSystemLanguages?.()[0] || app.getLocale()))
  Menu.setApplicationMenu(null)
  ipc()
  createWindow()
})
app.on('window-all-closed', () => { job?.cancel(); auth.cancel(); app.quit() })
