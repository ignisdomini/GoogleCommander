'use strict'
// Google Commander — экран в духе Norton Commander: текстовый режим, растровые шрифты VGA, 16 цветов CGA.

// изменяемая копия моста к главному процессу (объект contextBridge заморожен)
const B = window.dcBridge
const dc = { app: { ...B.app }, auth: { ...B.auth }, fs: { ...B.fs }, gd: { ...B.gd }, xfer: { ...B.xfer }, onXfer: B.onXfer, pathForFile: B.pathForFile }
const L = window.I18N
const t = L.t

// ═══════════════════════════ палитра и мелочи ═══════════════════════════

const PAL = ['#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
  '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff']
const BLK = 0, BLU = 1, CYN = 3, RED = 4, LGR = 7, DGR = 8, LCY = 11, YEL = 14, WHT = 15

const collator = () => new Intl.Collator(L.lang, { numeric: true, sensitivity: 'base' })
const pad = (s, n) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))
const padL = (s, n) => (s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s)
const center = (s, n) => { if (s.length >= n) return s.slice(0, n); const l = Math.floor((n - s.length) / 2); return ' '.repeat(l) + s + ' '.repeat(n - s.length - l) }
const cut = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '}' : s)
const cutL = (s, n) => (s.length > n ? '..' + s.slice(s.length - n + 2) : s)
const two = (n) => String(n).padStart(2, '0')
const ftime = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}` }
const { num, bytes, files, q } = L
const fdate = (ms) => L.date(ms)
function sizeCol(n) {
  if (n < 1e9) return String(n)
  if (n / 1024 < 1e8) return Math.round(n / 1024) + 'K'
  return Math.round(n / 1048576) + 'M'
}
function wrap(text, w) {
  const out = []
  for (const para of String(text).split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      if (!line) line = word
      else if (line.length + 1 + word.length <= w) line += ' ' + word
      else { out.push(line); line = word }
      while (line.length > w) { out.push(line.slice(0, w)); line = line.slice(w) }
    }
    out.push(line)
  }
  return out
}

// ═══════════════════════════ текстовый экран ═══════════════════════════

const CP437_LOW = ' ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼'
// кодовая страница 850 (0x80–0xFF): латиница с диакритикой для немецкого, французского и испанского
const CP850_HI = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0'
const cpMap = new Map()      // символ → номер глифа: 0–255 шрифт 866, 256–511 шрифт 850
const canvas = document.getElementById('scr')
const ctx = canvas.getContext('2d', { alpha: false })

const scr = {
  cols: 80, rows: 25, cw: 8, ch: 12, fh: 12, scale: 2, atlasKey: '',
  chr: [], fg: null, bg: null, prev: null, atlas: null, hits: [], cursor: null,

  setFonts(cyr, lat) {
    const dec = new TextDecoder('ibm866')
    for (let i = 0; i < 256; i++) {
      const c = i > 0 && i < 32 ? CP437_LOW[i] : i === 127 ? '⌂' : dec.decode(new Uint8Array([i]))
      if (!cpMap.has(c)) cpMap.set(c, i)
    }
    if (lat) for (let i = 0; i < 128; i++) if (!cpMap.has(CP850_HI[i])) cpMap.set(CP850_HI[i], 256 + 128 + i)
    const alias = { '…': '·', '—': '─', '–': '-', '−': '-', '“': '"', '”': '"', '„': '"', '’': "'", '‘': "'", '✓': '√' }
    for (const [a, b] of Object.entries(alias)) if (cpMap.has(b)) cpMap.set(a, cpMap.get(b))
    if (!lat) for (const c of '«»') cpMap.set(c, 0x22)
    if (!cyr) { this.bits = null; return }
    this.fh = cyr.h
    this.bits = new Uint8Array(512 * cyr.h)
    this.bits.set(Uint8Array.from(atob(cyr.glyphs), (c) => c.charCodeAt(0)))
    if (lat && lat.h === cyr.h) this.bits.set(Uint8Array.from(atob(lat.glyphs), (c) => c.charCodeAt(0)), 256 * cyr.h)
  },

  // глифы 8×fh, растянутые до ячейки cw×ch точных экранных пикселей (без размытия)
  buildAtlas() {
    const { cw, ch, fh, bits } = this
    if (!bits) { this.atlas = null; return }
    if (this.atlasKey === cw + 'x' + ch) return
    this.atlasKey = cw + 'x' + ch
    const sx = new Uint8Array(cw), sy = new Uint8Array(ch)
    for (let x = 0; x < cw; x++) sx[x] = Math.min(7, Math.floor(((x + 0.5) * 8) / cw))
    for (let y = 0; y < ch; y++) sy[y] = Math.min(fh - 1, Math.floor(((y + 0.5) * fh) / ch))
    this.atlas = PAL.map((col) => {
      const cv = document.createElement('canvas')
      cv.width = 512 * cw; cv.height = ch
      const g = cv.getContext('2d')
      const img = g.createImageData(cv.width, cv.height)
      const r = parseInt(col.slice(1, 3), 16), gg = parseInt(col.slice(3, 5), 16), b = parseInt(col.slice(5, 7), 16)
      for (let c = 0; c < 512; c++) for (let y = 0; y < ch; y++) {
        const row = bits[c * fh + sy[y]]
        if (!row) continue
        for (let x = 0; x < cw; x++) if (row & (0x80 >> sx[x])) {
          const o = (y * cv.width + c * cw + x) * 4
          img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255
        }
      }
      g.putImageData(img, 0, 0)
      return cv
    })
  },

  resize() {
    const dpr = window.devicePixelRatio || 1
    const W = innerWidth * dpr, H = innerHeight * dpr
    // по умолчанию — около 100 колонок, шаг масштаба 0,25
    let s = st.zoom
    if (!s) s = Math.max(1, Math.min(6, Math.floor((W / (8 * 100)) * 4) / 4))
    this.scale = s
    this.cw = Math.max(6, Math.round(8 * s))
    this.ch = Math.max(8, Math.round(this.fh * s))
    this.buildAtlas()
    this.cols = Math.max(40, Math.floor(W / this.cw))
    this.rows = Math.max(15, Math.floor(H / this.ch))
    canvas.width = this.cols * this.cw; canvas.height = this.rows * this.ch
    const cssW = canvas.width / dpr, cssH = canvas.height / dpr
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px'
    canvas.style.left = Math.floor((innerWidth - cssW) / 2) + 'px'
    canvas.style.top = Math.floor((innerHeight - cssH) / 2) + 'px'
    const n = this.cols * this.rows
    this.chr = new Array(n); this.fg = new Uint8Array(n); this.bg = new Uint8Array(n); this.prev = null
  },

  clear() { this.chr.fill(' '); this.fg.fill(LGR); this.bg.fill(BLK); this.hits = [] },

  put(x, y, s, fg, bg) {
    if (y < 0 || y >= this.rows) return
    let i = 0
    for (const c of String(s)) {
      const xx = x + i++
      if (xx < 0 || xx >= this.cols) continue
      const k = y * this.cols + xx
      this.chr[k] = c
      if (fg != null) this.fg[k] = fg
      if (bg != null) this.bg[k] = bg
    }
  },
  fill(x, y, w, h, c, fg, bg) { const line = c.repeat(Math.max(0, w)); for (let j = 0; j < h; j++) this.put(x, y + j, line, fg, bg) },
  attr(x, y, w, fg, bg) {
    if (y < 0 || y >= this.rows) return
    for (let i = 0; i < w; i++) { const xx = x + i; if (xx < 0 || xx >= this.cols) continue; const k = y * this.cols + xx; if (fg != null) this.fg[k] = fg; if (bg != null) this.bg[k] = bg }
  },
  box(x, y, w, h, fg, bg, dbl = true) {
    const [tl, tr, bl, br, hz, vt] = dbl ? '╔╗╚╝═║' : '┌┐└┘─│'
    this.put(x, y, tl + hz.repeat(w - 2) + tr, fg, bg)
    for (let j = 1; j < h - 1; j++) { this.put(x, y + j, vt, fg, bg); this.put(x + w - 1, y + j, vt, fg, bg) }
    this.put(x, y + h - 1, bl + hz.repeat(w - 2) + br, fg, bg)
  },
  shadow(x, y, w, h) {
    for (let j = 1; j <= h; j++) this.attr(x + w, y + j, 2, DGR, BLK)
    this.attr(x + 2, y + h, w - 2, DGR, BLK)
  },
  hit(x, y, w, h, on) { this.hits.push({ x, y, w, h, ...on }) },
  // самая верхняя область под курсором, у которой есть нужный обработчик (блокирующий фон диалога — тоже)
  hitAt(cx, cy, prop) {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const r = this.hits[i]
      if (cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h && (!prop || r[prop] || r.block)) return r
    }
    return null
  },

  glyph(c) {
    let code = cpMap.get(c)
    if (code === undefined) {
      const base = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      code = base.length === 1 ? cpMap.get(base) : undefined
    }
    return code
  },

  paint(blinkOn) {
    const { cols, rows, ch, cw } = this
    const prev = this.prev
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const k = y * cols + x
      let c = this.chr[k]
      const f = this.fg[k], b = this.bg[k]
      if (this.cursor && this.cursor.x === x && this.cursor.y === y && blinkOn) c = '_'
      const sig = c + '|' + f + '|' + b
      if (prev && prev[k] === sig) continue
      if (prev) prev[k] = sig
      ctx.fillStyle = PAL[b]
      ctx.fillRect(x * cw, y * ch, cw, ch)
      if (c === ' ') continue
      const code = this.atlas ? this.glyph(c) : undefined
      if (code !== undefined) ctx.drawImage(this.atlas[f], code * cw, 0, cw, ch, x * cw, y * ch, cw, ch)
      else {
        ctx.save(); ctx.beginPath(); ctx.rect(x * cw, y * ch, cw, ch); ctx.clip()
        ctx.fillStyle = PAL[f]; ctx.font = `${Math.round(ch * 0.85)}px Consolas, "Lucida Console", monospace`; ctx.textBaseline = 'top'
        ctx.fillText(c, x * cw, Math.round(ch * 0.08), cw); ctx.restore()
      }
    }
    if (!prev) this.prev = new Array(cols * rows).fill('')
  },
}

// ═══════════════════════════ состояние ═══════════════════════════

const st = {
  panels: [], act: 0, modal: [], menu: null, viewer: null,
  status: { hasClient: false, logged: false }, about: null, loggingIn: false,
  mods: { alt: false, ctrl: false, shift: false }, cmd: '', qs: null, blink: true, zoom: 0,
  version: '', job: null,
}

function newPanel(kind, saved = {}) {
  return {
    kind, path: saved.path || 'C:\\', stack: saved.stack?.length ? saved.stack : [{ id: 'root', name: '' }],
    items: [], cur: 0, top: 0, sel: new Set(), sort: saved.sort || 'name', loading: false, err: null, space: null, seq: 0, listH: 10,
  }
}

const other = () => st.panels[1 - st.act]
const active = () => st.panels[st.act]
const cwdId = (p) => p.stack[p.stack.length - 1].id
const isRoot = (p) => (p.kind === 'local' ? /^[a-z]:\\?$/i.test(p.path) : p.stack.length === 1)
const joinPath = (dir, name) => (dir.endsWith('\\') ? dir + name : dir + '\\' + name)
const parentPath = (dir) => { const s = dir.replace(/\\+$/, ''); const i = s.lastIndexOf('\\'); return i <= 2 ? s.slice(0, 2) + '\\' : s.slice(0, i) }
const lastName = (dir) => dir.replace(/\\+$/, '').split('\\').pop()
const stackName = (s) => (s.id === 'root' ? t('myDrive') : s.id === 'shared' ? t('shared') : s.name)
const itemName = (it) => (it.virt ? t('shared') : it.name)
function title(p) {
  if (p.kind === 'local') return p.path
  return 'GD:\\' + p.stack.map(stackName).join('\\')
}

function saveState() {
  dc.app.saveState({
    act: st.act, zoom: st.zoom,
    panels: st.panels.map((p) => ({ kind: p.kind, path: p.path, stack: p.stack, sort: p.sort })),
  }).catch(() => {})
}

// ═══════════════════════════ загрузка панелей ═══════════════════════════

function sortItems(p, items) {
  const by = p.sort
  const col = collator()
  const ext = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1) : '' }
  return items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    let r = 0
    if (by === 'ext' && !a.isDir) r = col.compare(ext(a.name), ext(b.name))
    else if (by === 'time') r = b.mtime - a.mtime
    else if (by === 'size' && !a.isDir) r = b.size - a.size
    else if (by === 'none') return 0
    return r || col.compare(a.name, b.name)
  })
}

function setItems(p, raw, focus) {
  const keep = focus ?? p.items[p.cur]?.key
  const items = sortItems(p, raw.slice())
  if (p.kind === 'drive' && p.stack.length === 1 && st.status.logged) items.unshift({ key: 'shared', id: 'shared', targetId: 'shared', name: 'shared', isDir: true, virt: true, size: 0, mtime: 0 })
  if (!isRoot(p)) items.unshift({ key: '..', name: '..', isDir: true, up: true, size: 0, mtime: 0 })
  p.items = items
  const keys = new Set(items.map((i) => i.key))
  for (const k of [...p.sel]) if (!keys.has(k)) p.sel.delete(k)
  let i = keep != null ? items.findIndex((it) => it.key === keep || it.name === keep) : -1
  if (i < 0) i = Math.min(p.cur, items.length - 1)
  p.cur = Math.max(0, i)
}

async function load(p, focus) {
  const seq = ++p.seq
  p.loading = true; p.err = null
  draw()
  try {
    let raw = []
    if (p.kind === 'local') {
      raw = await dc.fs.list(p.path)
      dc.fs.space(p.path).then((s) => { if (seq === p.seq) { p.space = s; draw() } }).catch(() => {})
    } else if (st.status.logged) {
      raw = await dc.gd.list(cwdId(p))
    }
    if (seq !== p.seq) return
    setItems(p, raw, focus)
  } catch (e) {
    if (seq !== p.seq) return
    setItems(p, [], focus)
    p.err = e.message
    if (e.code === 'AUTH') await refreshStatus()
  }
  p.loading = false
  draw()
}

const reloadAll = () => Promise.all(st.panels.map((p) => load(p)))

async function refreshStatus() {
  try { st.status = await dc.auth.status() } catch {}
  if (!st.status.logged) st.about = null
  draw()
}

async function loadAbout() {
  if (!st.status.logged) { st.about = null; return }
  try { st.about = await dc.gd.about() } catch (e) { if (e.code === 'AUTH') await refreshStatus() }
  draw()
}

function enter(p, item) {
  if (!item) return
  if (item.up) return goUp(p)
  if (!item.isDir) return openFile(p, item)
  p.sel.clear()
  if (p.kind === 'local') p.path = joinPath(p.path, item.name)
  else p.stack.push({ id: item.targetId, name: item.name })
  p.cur = 0; p.top = 0
  saveState()
  load(p, '..')
}

function goUp(p) {
  if (isRoot(p)) return
  p.sel.clear()
  let focus
  if (p.kind === 'local') { focus = lastName(p.path); p.path = parentPath(p.path) } else focus = p.stack.pop().id
  saveState()
  load(p, focus)
}

function goRoot(p) {
  p.sel.clear()
  if (p.kind === 'local') p.path = p.path.slice(0, 2) + '\\'
  else p.stack = p.stack.slice(0, 1)
  p.cur = 0; saveState(); load(p)
}

function setDrive(i, target) {
  const p = st.panels[i]
  p.sel.clear(); p.cur = 0; p.top = 0; p.err = null; p.space = null
  if (target === 'gd') { p.kind = 'drive'; if (!p.stack?.length) p.stack = [{ id: 'root', name: '' }] } else { p.kind = 'local'; p.path = target }
  saveState()
  load(p)
  if (target === 'gd' && st.status.logged && !st.about) loadAbout()
}

// ═══════════════════════════ рисование ═══════════════════════════

let drawQueued = false
function draw() {
  if (drawQueued) return
  drawQueued = true
  requestAnimationFrame(() => { drawQueued = false; render() })
}

function render() {
  scr.clear()
  scr.cursor = null
  if (st.viewer) drawViewer()
  else {
    drawPanel(0); drawPanel(1)
    drawCmdline()
    drawKeybar()
    drawClock()
    if (st.qs) drawQuickSearch()
    if (st.menu) drawMenu()
  }
  for (const d of st.modal) drawDialog(d)
  scr.paint(st.blink)
}

function panelGeom(i) {
  const half = Math.floor(scr.cols / 2)
  return { x: i ? half : 0, y: 0, w: i ? scr.cols - half : half, h: scr.rows - 2 }
}

function columns(iw) {
  const cols = [{ k: 'size', w: 9, t: t('colSize') }, { k: 'date', w: 8, t: t('colDate') }]
  if (iw >= 46) cols.push({ k: 'time', w: 5, t: t('colTime') })
  const nameW = iw - cols.reduce((a, c) => a + c.w + 1, 0)
  return [{ k: 'name', w: nameW, t: t('colName') }, ...cols]
}

function sizeText(it) {
  if (it.up) return t('upTag')
  if (it.isDir) return t('dirTag')
  if (it.gdoc) return 'Google'
  return sizeCol(it.size)
}

function drawPanel(i) {
  const p = st.panels[i]
  const { x, y, w, h } = panelGeom(i)
  const isAct = i === st.act && !st.menu
  scr.fill(x, y, w, h, ' ', LCY, BLU)
  scr.box(x, y, w, h, LCY, BLU)
  scr.hit(x, y, w, h, { wheel: (dy) => { st.act = i; move(p, dy > 0 ? 3 : -3) }, click: () => { st.act = i; draw() } })
  const iw = w - 2
  const cols = columns(iw)
  const listY = y + 2, sepY = y + h - 3, listH = sepY - listY
  p.listH = listH
  if (p.cur < p.top) p.top = p.cur
  if (p.cur >= p.top + listH) p.top = p.cur - listH + 1
  if (p.top > Math.max(0, p.items.length - listH)) p.top = Math.max(0, p.items.length - listH)

  // сообщение вместо списка (вход, ошибка) — колонки не рисуем
  const msg = panelMessage(p)
  const bare = msg && p.items.length <= 1

  // разделители колонок
  let cx = x + 1
  const seps = []
  for (let c = 0; c < cols.length; c++) {
    cols[c].x = cx
    if (!bare) scr.put(cx, y + 1, center(cols[c].t, cols[c].w), YEL, BLU)
    cx += cols[c].w
    if (c < cols.length - 1) { seps.push(cx); cx++ }
  }
  if (bare) seps.length = 0
  for (const sx of seps) {
    scr.put(sx, y, '╤', LCY, BLU)
    for (let j = y + 1; j < sepY; j++) scr.put(sx, j, '│', LCY, BLU)
  }
  scr.put(x, sepY, '╟' + '─'.repeat(iw) + '╢', LCY, BLU)
  for (const sx of seps) scr.put(sx, sepY, '┴', LCY, BLU)

  // строки файлов
  for (let r = 0; r < listH; r++) {
    const idx = p.top + r
    const it = p.items[idx]
    const yy = listY + r
    if (!it) continue
    const sel = p.sel.has(it.key)
    const cur = isAct && idx === p.cur
    const fg = sel ? YEL : it.isDir ? WHT : LCY
    const bg = cur ? CYN : BLU
    const f2 = cur ? (sel ? YEL : BLK) : fg
    for (const c of cols) {
      let s = ''
      if (c.k === 'name') s = pad(cut(itemName(it), c.w), c.w)
      else if (c.k === 'size') s = it.isDir || it.gdoc ? center(sizeText(it), c.w) : padL(sizeText(it), c.w)
      else if (c.k === 'date') s = it.up ? '' : fdate(it.mtime)
      else if (c.k === 'time') s = it.up ? '' : ftime(it.mtime)
      scr.put(c.x, yy, pad(s, c.w), f2, bg)
    }
    if (cur) for (const sx of seps) scr.attr(sx, yy, 1, BLK, CYN)
    scr.hit(x + 1, yy, iw, 1, {
      click: () => { st.act = i; p.cur = idx; draw() },
      dbl: () => { st.act = i; p.cur = idx; enter(p, it) },
      right: () => { st.act = i; p.cur = idx; toggleSel(p, it); draw() },
    })
  }

  // сообщения в пустой панели
  if (msg) {
    const lines = msg.lines.flatMap((l) => wrap(l, iw - 4))
    const top = listY + Math.max(1, Math.floor((listH - lines.length) / 2))
    lines.forEach((l, k) => { if (l) scr.put(x + 1 + Math.floor((iw - l.length) / 2), top + k, l, k === 0 ? (msg.fg ?? WHT) : LCY, BLU) })
  }

  // строка состояния под списком
  const it = p.items[p.cur]
  if (it) {
    const right = it.up ? '' : ` ${padL(it.isDir ? sizeText(it) : it.gdoc ? 'Google' : num(it.size), 11)} ${fdate(it.mtime)} ${ftime(it.mtime)}`
    const nameW = iw - right.length
    scr.put(x + 1, sepY + 1, pad(cut(itemName(it), nameW), nameW) + right, LCY, BLU)
  }

  // нижняя рамка: выделение или свободное место
  let info = ''
  let infoFg = LCY
  if (p.sel.size) {
    const chosen = p.items.filter((c) => p.sel.has(c.key))
    const sum = chosen.reduce((a, c) => a + (c.isDir ? 0 : c.size), 0)
    info = ' ' + t('selInfo', { n: chosen.length, s: num(sum) }) + ' '
    infoFg = YEL
  } else if (p.kind === 'local' && p.space) info = ' ' + t('freeOf', { a: bytes(p.space.free), b: bytes(p.space.total) }) + ' '
  else if (p.kind === 'drive' && st.about) {
    info = ' ' + (st.about.limit
      ? t('freeOf', { a: bytes(Math.max(0, st.about.limit - st.about.usage)), b: bytes(st.about.limit) })
      : t('usedUnlim', { a: bytes(st.about.usage) })) + ' '
  }
  if (info) scr.put(x + Math.max(1, Math.floor((w - info.length) / 2)), y + h - 1, cutL(info, iw), infoFg, BLU)

  // заголовок — путь
  const head = ' ' + cutL(title(p), iw - 4) + ' '
  scr.put(x + Math.floor((w - head.length) / 2), y, head, isAct ? BLK : LCY, isAct ? CYN : BLU)
}

function panelMessage(p) {
  if (p.loading && !p.items.length) return { lines: [t('reading')] }
  if (p.kind === 'drive') {
    if (st.loggingIn) return { lines: [t('loginWaitTitle'), '', t('loginWait1'), t('loginWait2'), '', t('escCancel')], fg: YEL }
    if (!st.status.hasClient) return { lines: [t('noClientTitle'), '', t('noClient1'), t('noClient2'), '', t('noClient3')], fg: YEL }
    if (!st.status.logged) return { lines: [t('notLoggedTitle'), '', t('notLogged1'), t('notLogged2')], fg: YEL }
  }
  if (p.err) return { lines: [t('error'), '', p.err], fg: YEL }
  if (p.loading) return null
  if (p.items.length <= (isRoot(p) ? 0 : 1) && !(p.kind === 'drive' && p.stack.length === 1)) return { lines: [t('emptyDir')], fg: LCY }
  return null
}

function drawCmdline() {
  const y = scr.rows - 2
  scr.fill(0, y, scr.cols, 1, ' ', LGR, BLK)
  const p = active()
  const prompt = title(p) + '>'
  let line = prompt + st.cmd
  if (line.length > scr.cols - 2) line = line.slice(line.length - scr.cols + 2)
  scr.put(0, y, line, LGR, BLK)
  if (!st.modal.length && !st.menu && !st.qs) scr.cursor = { x: line.length, y }
}

function keyLabels() {
  if (st.mods.alt) return t('keysAlt')
  if (st.mods.ctrl) return t('keysCtrl')
  if (st.mods.shift) return t('keysShift')
  const k = t('keysNone').slice()
  if (st.status.logged) k[1] = t('keyAccount')
  return k
}

function drawKeybar(labels) {
  const y = scr.rows - 1
  const set = labels || keyLabels()
  const slot = Math.floor(scr.cols / 10)
  scr.fill(0, y, scr.cols, 1, ' ', BLK, BLK)
  for (let i = 0; i < 10; i++) {
    const x = i * slot
    const w = i === 9 ? scr.cols - x : slot
    const n = String(i + 1)
    scr.put(x, y, n, WHT, BLK)
    scr.put(x + n.length, y, pad(set[i], w - n.length), BLK, CYN)
    const fk = 'F' + (i + 1)
    scr.hit(x, y, w, 1, { click: () => (st.viewer ? viewerKey({ key: fk }) : fkey(fk, st.mods)) })
  }
}

function drawClock() {
  const d = new Date()
  scr.put(scr.cols - 5, 0, `${two(d.getHours())}:${two(d.getMinutes())}`, BLK, CYN)
}

function drawQuickSearch() {
  const { x, w, h } = panelGeom(st.act)
  const label = t('search') + ' '
  const bw = Math.min(w - 2, 32), bx = x + Math.floor((w - bw) / 2), by = h - 3
  const fw = bw - 4 - label.length
  scr.fill(bx, by, bw, 3, ' ', BLK, CYN)
  scr.box(bx, by, bw, 3, BLK, CYN, false)
  scr.put(bx + 2, by + 1, label, BLK, CYN)
  scr.put(bx + 2 + label.length, by + 1, pad(st.qs.text.slice(-(fw - 1)), fw), BLK, LGR)
  scr.cursor = { x: bx + 2 + label.length + Math.min(st.qs.text.length, fw - 1), y: by + 1 }
}

// ═══════════════════════════ меню F9 ═══════════════════════════

function panelMenu(i) {
  const p = st.panels[i]
  const s = (k) => (p.sort === k ? '√ ' : '  ')
  return [
    { t: t('miDrive'), k: i ? 'Alt-F2' : 'Alt-F1', fn: () => pickDrive(i) },
    '-',
    { t: s('name') + t('miByName'), k: 'Ctrl-F3', fn: () => setSort(p, 'name') },
    { t: s('ext') + t('miByExt'), k: 'Ctrl-F4', fn: () => setSort(p, 'ext') },
    { t: s('time') + t('miByTime'), k: 'Ctrl-F5', fn: () => setSort(p, 'time') },
    { t: s('size') + t('miBySize'), k: 'Ctrl-F6', fn: () => setSort(p, 'size') },
    { t: s('none') + t('miUnsorted'), k: 'Ctrl-F7', fn: () => setSort(p, 'none') },
    '-',
    { t: t('miRefresh'), k: 'Ctrl-R', fn: () => load(p) },
  ]
}

function menus() {
  return [
    { t: t('mLeft'), items: panelMenu(0) },
    { t: t('mFile'), items: [
      { t: t('miHelp'), k: 'F1', fn: help },
      { t: t('miView'), k: 'F3', fn: view },
      { t: t('miEdit'), k: 'F4', fn: edit },
      { t: t('miCopy'), k: 'F5', fn: () => copyMove('copy') },
      { t: t('miMove'), k: 'F6', fn: () => copyMove('move') },
      { t: t('miRename'), k: 'Shift-F6', fn: renameItem },
      { t: t('miMkdir'), k: 'F7', fn: mkdir },
      { t: t('miDelete'), k: 'F8', fn: remove },
      '-',
      { t: t('miSelect'), k: 'Gray +', fn: () => selectMask(true) },
      { t: t('miUnselect'), k: 'Gray -', fn: () => selectMask(false) },
      { t: t('miInvert'), k: 'Gray *', fn: invertSel },
      '-',
      { t: t('miLink'), k: 'Ctrl-K', fn: copyLink },
      { t: t('miOutside'), k: 'Ctrl-E', fn: openOutside },
      '-',
      { t: t('miQuit'), k: 'F10', fn: quit },
    ] },
    { t: t('mCmd'), items: [
      { t: st.status.logged ? t('miAccount') : t('miLogin'), k: 'F2', fn: account },
      { t: t('miLogout'), fn: logout },
      '-',
      { t: t('miSwap'), k: 'Ctrl-U', fn: swapPanels },
      { t: t('miSame'), k: 'Ctrl-=', fn: samePanel },
      { t: t('miFull'), k: 'Alt-Enter', fn: () => dc.app.fullscreen() },
    ] },
    { t: t('mOpt'), items: [
      { t: t('miLang'), fn: pickLang },
      '-',
      { t: t('miOAuth'), fn: settings },
      { t: t('miHowKey'), fn: help },
      '-',
      { t: t('miBigger'), k: 'Ctrl +', fn: () => zoom(1) },
      { t: t('miSmaller'), k: 'Ctrl -', fn: () => zoom(-1) },
      { t: t('miFit'), k: 'Ctrl-0', fn: () => zoom(0) },
      '-',
      { t: t('miAbout'), fn: aboutApp },
    ] },
    { t: t('mRight'), items: panelMenu(1) },
  ]
}

function menuLayout() {
  const list = menus()
  let x = 2
  for (const m of list) { m.x = x; x += m.t.length + 4 }
  return list
}

function drawMenu() {
  const list = menuLayout()
  const m = st.menu
  scr.fill(0, 0, scr.cols, 1, ' ', BLK, CYN)
  list.forEach((it, i) => {
    const on = i === m.i
    scr.put(it.x, 0, '  ' + it.t + '  ', on ? WHT : BLK, on ? BLK : CYN)
    scr.hit(it.x, 0, it.t.length + 4, 1, { click: () => { m.i = i; m.j = firstItem(list[i].items); m.open = true; draw() } })
  })
  if (!m.open) return
  const cur = list[m.i]
  const items = cur.items
  const w = Math.max(...items.map((it) => (it === '-' ? 0 : it.t.length + (it.k ? it.k.length + 4 : 0)))) + 4
  const x = Math.max(0, Math.min(cur.x, scr.cols - w - 2)), y = 1
  scr.hit(0, 1, scr.cols, scr.rows - 1, { click: closeMenu, block: true })
  scr.fill(x, y, w, items.length + 2, ' ', BLK, CYN)
  scr.box(x, y, w, items.length + 2, WHT, CYN)
  scr.shadow(x, y, w, items.length + 2)
  items.forEach((it, j) => {
    const yy = y + 1 + j
    if (it === '-') { scr.put(x, yy, '╟' + '─'.repeat(w - 2) + '╢', WHT, CYN); return }
    const on = j === m.j
    const line = ' ' + pad(it.t, w - 4 - (it.k ? it.k.length : 0)) + (it.k || '') + ' '
    scr.put(x + 1, yy, line, on ? WHT : BLK, on ? BLK : CYN)
    scr.hit(x + 1, yy, w - 2, 1, { click: () => { closeMenu(); it.fn() } })
  })
}

const firstItem = (items) => items.findIndex((it) => it !== '-')
function openMenu(i = st.act ? 4 : 0) { st.menu = { i, j: firstItem(menus()[i].items), open: true }; st.qs = null; draw() }
function closeMenu() { st.menu = null; draw() }

function menuKey(e) {
  const list = menus()
  const m = st.menu
  const items = list[m.i].items
  const step = (d) => { let j = m.j; do { j = (j + d + items.length) % items.length } while (items[j] === '-'); m.j = j }
  switch (e.key) {
    case 'Escape': case 'F9': case 'F10': closeMenu(); break
    case 'ArrowLeft': m.i = (m.i + list.length - 1) % list.length; m.j = firstItem(list[m.i].items); break
    case 'ArrowRight': m.i = (m.i + 1) % list.length; m.j = firstItem(list[m.i].items); break
    case 'ArrowDown': if (!m.open) m.open = true; else step(1); break
    case 'ArrowUp': if (!m.open) m.open = true; else step(-1); break
    case 'Home': m.j = firstItem(items); break
    case 'End': m.j = items.length - 1; break
    case 'Enter': {
      if (!m.open) { m.open = true; break }
      const it = items[m.j]
      closeMenu()
      if (it && it !== '-') it.fn()
      return
    }
    default: return
  }
  draw()
}

// ═══════════════════════════ диалоги ═══════════════════════════

const SCHEMES = {
  gray: { bg: LGR, fg: BLK, border: WHT, title: BLK, input: [BLK, CYN], btn: [BLK, LGR], focus: [BLK, CYN], dim: DGR },
  red: { bg: RED, fg: WHT, border: WHT, title: YEL, input: [BLK, LGR], btn: [WHT, RED], focus: [BLK, LGR], dim: LGR },
  cyan: { bg: CYN, fg: BLK, border: WHT, title: BLK, input: [BLK, LGR], btn: [BLK, CYN], focus: [WHT, BLK], dim: BLU },
}

function dialog(d) {
  d.scheme = d.scheme || 'gray'
  d.rows = d.rows || []
  st.modal.push(d)
  focusables(d)
  if (d.f == null) d.f = Math.max(0, d.fl.findIndex((f) => f.el.def))
  st.qs = null
  draw()
  return new Promise((r) => { d.resolve = r })
}

function focusables(d) {
  d.fl = []
  d.rows.forEach((row, ri) => {
    if (row.input || row.item) d.fl.push({ ri, el: row })
    else if (row.btns) row.btns.forEach((b, bi) => d.fl.push({ ri, bi, el: b }))
  })
  if (d.f != null && d.f >= d.fl.length) d.f = d.fl.length - 1
}

function closeDialog(d, v) {
  const i = st.modal.indexOf(d)
  if (i >= 0) st.modal.splice(i, 1)
  const vals = {}
  for (const r of d.rows) if (r.input) vals[r.id] = r.value
  d.closed = true
  d.resolve?.({ v, vals })
  draw()
}

function activate(d, el) {
  if (el.fn) return el.fn(d)
  closeDialog(d, el.v)
}

function dialogSize(d) {
  let iw = d.w ? d.w - 8 : 0
  for (const r of d.rows) {
    if (r.t != null) iw = Math.max(iw, r.t.length)
    if (r.item) iw = Math.max(iw, r.label.length + 2)
    if (r.btns) iw = Math.max(iw, r.btns.reduce((a, b) => a + b.label.length + 4 + 2, -2))
  }
  iw = Math.min(iw, scr.cols - 10)
  const h = d.rows.reduce((a, r) => a + (r.view ? r.h : 1), 0) + 4
  return { iw, W: iw + 8, H: h }
}

function drawDialog(d) {
  const S = SCHEMES[d.scheme]
  const { iw, W, H } = dialogSize(d)
  let x = d.cx != null ? d.cx - Math.floor(W / 2) : Math.floor((scr.cols - W) / 2)
  x = Math.max(0, Math.min(scr.cols - W, x))
  const y = Math.max(0, Math.floor((scr.rows - H) / 2) - 1)
  scr.hit(0, 0, scr.cols, scr.rows, { block: true })
  scr.fill(x, y, W, H, ' ', S.fg, S.bg)
  scr.box(x + 2, y + 1, W - 4, H - 2, S.border, S.bg)
  scr.shadow(x, y, W, H)
  if (d.title) { const s = ' ' + d.title + ' '; scr.put(x + Math.floor((W - s.length) / 2), y + 1, s, S.title, S.bg) }
  const cx = x + 4
  let yy = y + 2
  const fe = d.fl[d.f]?.el
  d.rows.forEach((r) => {
    if (r.sep) scr.put(x + 2, yy, '╟' + '─'.repeat(W - 6) + '╢', S.border, S.bg)
    else if (r.t != null) {
      const s = r.align === 'center' ? center(r.t, iw) : pad(r.t, iw)
      scr.put(cx, yy, s, r.fg ?? S.fg, S.bg)
    } else if (r.input) {
      const view = Math.max(0, r.pos - iw + 1)
      const shown = r.mask ? '•'.repeat(r.value.length) : r.value
      const [f, b] = S.input
      scr.put(cx, yy, pad(shown.slice(view, view + iw), iw), f, b)
      if (fe === r) scr.cursor = { x: cx + r.pos - view, y: yy }
      scr.hit(cx, yy, iw, 1, { click: () => { d.f = d.fl.findIndex((qq) => qq.el === r); r.pos = r.value.length; draw() } })
    } else if (r.item) {
      const on = fe === r
      const [f, b] = on ? S.focus : [S.fg, S.bg]
      scr.put(cx - 1, yy, ' ' + pad(r.label, iw) + ' ', f, b)
      scr.hit(cx - 1, yy, iw + 2, 1, { click: () => activate(d, r) })
    } else if (r.btns) {
      const total = r.btns.reduce((a, b) => a + b.label.length + 4 + 2, -2)
      let bx = cx + Math.max(0, Math.floor((iw - total) / 2))
      for (const b of r.btns) {
        const s = '[ ' + b.label + ' ]'
        const [f, bg] = fe === b ? S.focus : S.btn
        scr.put(bx, yy, s, f, bg)
        scr.hit(bx, yy, s.length, 1, { click: () => activate(d, b) })
        bx += s.length + 2
      }
    } else if (r.bar != null) {
      const n = Math.round(Math.max(0, Math.min(1, r.bar)) * iw)
      scr.put(cx, yy, '█'.repeat(n), BLU, S.bg)
      scr.put(cx + n, yy, '░'.repeat(iw - n), S.dim, S.bg)
    } else if (r.view) {
      const lines = r.lines
      r.top = Math.max(0, Math.min(r.top || 0, lines.length - r.h))
      for (let k = 0; k < r.h; k++) {
        const l = lines[r.top + k]
        if (l == null) continue
        const hl = Array.isArray(l)
        scr.put(cx, yy + k, pad(hl ? l[1] : l, iw), hl ? BLU : S.fg, S.bg)
      }
      if (lines.length > r.h) {
        const pos = Math.round((r.top / Math.max(1, lines.length - r.h)) * (r.h - 1))
        for (let k = 0; k < r.h; k++) scr.put(x + W - 3, yy + k, k === pos ? '■' : '░', S.border, S.bg)
      }
      scr.hit(cx, yy, iw, r.h, { wheel: (dy) => { r.top += dy > 0 ? 3 : -3; draw() } })
      yy += r.h - 1
    }
    yy++
  })
}

function dialogKey(d, e) {
  if (d.onKey && d.onKey(e) !== false) return
  const el = d.fl[d.f]?.el
  const k = e.key
  const view = d.rows.find((r) => r.view)
  if (k === 'Escape') { if (d.noEsc) return; return closeDialog(d, d.cancel ?? null) }
  if (k === 'Tab') { if (d.fl.length) d.f = (d.f + (e.shiftKey ? d.fl.length - 1 : 1)) % d.fl.length; return draw() }
  if (el?.input) {
    const r = el
    if (k === 'Enter') { const def = d.fl.find((f) => f.el.def) || d.fl.find((f) => f.el.label); return def && activate(d, def.el) }
    if (k === 'ArrowLeft') r.pos = Math.max(0, r.pos - 1)
    else if (k === 'ArrowRight') r.pos = Math.min(r.value.length, r.pos + 1)
    else if (k === 'Home') r.pos = 0
    else if (k === 'End') r.pos = r.value.length
    else if (k === 'Backspace') { if (r.pos > 0) { r.value = r.value.slice(0, r.pos - 1) + r.value.slice(r.pos); r.pos-- } }
    else if (k === 'Delete') r.value = r.value.slice(0, r.pos) + r.value.slice(r.pos + 1)
    else if (k === 'ArrowDown' || k === 'ArrowUp') { if (d.fl.length) d.f = (d.f + (k === 'ArrowUp' ? d.fl.length - 1 : 1)) % d.fl.length }
    else if ((e.ctrlKey && e.code === 'KeyV') || (e.shiftKey && k === 'Insert')) {
      dc.app.paste().then((s) => { s = String(s).replace(/[\r\n]+/g, ' '); r.value = r.value.slice(0, r.pos) + s + r.value.slice(r.pos); r.pos += s.length; draw() })
    } else if (e.ctrlKey && e.code === 'KeyY') { r.value = ''; r.pos = 0 }
    else if (k.length === 1 && !e.ctrlKey && !e.altKey) { r.value = r.value.slice(0, r.pos) + k + r.value.slice(r.pos); r.pos++ }
    else return
    return draw()
  }
  if (view && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(k)) {
    const delta = { ArrowUp: -1, ArrowDown: 1, PageUp: -view.h, PageDown: view.h, Home: -1e9, End: 1e9 }[k]
    view.top = (view.top || 0) + delta
    return draw()
  }
  if (k === 'Enter' && el) return activate(d, el)
  if (['ArrowLeft', 'ArrowUp'].includes(k) && d.fl.length) { d.f = (d.f + d.fl.length - 1) % d.fl.length; return draw() }
  if (['ArrowRight', 'ArrowDown'].includes(k) && d.fl.length) { d.f = (d.f + 1) % d.fl.length; return draw() }
  if (k === 'Home') { d.f = 0; return draw() }
  if (k === 'End') { d.f = d.fl.length - 1; return draw() }
  if (k.length === 1) {
    const ch = k.toLowerCase()
    const hit = d.fl.find((f) => f.el.hot && f.el.hot.includes(ch))
    if (hit) activate(d, hit.el)
  }
}

async function ask(head, lines, btns, opt = {}) {
  const rows = []
  for (const l of [].concat(lines)) {
    if (typeof l === 'object' && l) rows.push(l)
    else for (const w of wrap(l ?? '', opt.width || 52)) rows.push({ t: w, align: opt.align || 'center' })
  }
  rows.push({ t: '' })
  rows.push({ btns })
  const r = await dialog({ title: head, rows, scheme: opt.scheme, cancel: opt.cancel ?? null, f: opt.f })
  return r.v
}

const alertBox = (head, msg, scheme = 'red') => ask(head, msg, [{ label: t('ok'), v: true }], { scheme })

async function prompt(head, label, value = '', opt = {}) {
  const inp = { input: true, id: 'v', value, pos: value.length }
  const r = await dialog({
    title: head, w: opt.w || 60,
    rows: [{ t: label }, inp, { t: '' }, { btns: [{ label: opt.ok || t('ok'), v: 'ok', def: true }, { label: t('cancel'), v: null }] }],
  })
  return r.v === 'ok' ? r.vals.v.trim() : null
}

// ═══════════════════════════ просмотр F3 ═══════════════════════════

const ENCODINGS = [['utf-8', 'UTF-8'], ['windows-1251', 'Win-1251'], ['windows-1252', 'Win-1252'], ['ibm866', 'DOS-866']]

function decodeText(data, enc) {
  if (enc) return new TextDecoder(enc).decode(data)
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), enc: 'utf-8' } } catch {
    const e = L.lang === 'ru' ? 'windows-1251' : 'windows-1252'
    return { text: new TextDecoder(e).decode(data), enc: e }
  }
}

function openViewer(name, data, size, truncated) {
  const { text, enc } = decodeText(data)
  st.viewer = { name, data, size, truncated, enc, wrap: true, top: 0, left: 0 }
  setViewerText(text)
  draw()
}
function setViewerText(text) {
  st.viewer.raw = text.replace(/\r\n?/g, '\n').replace(/\t/g, '        ').split('\n')
  layoutViewer()
}
function layoutViewer() {
  const v = st.viewer
  v.lines = v.wrap ? v.raw.flatMap((l) => { if (l.length <= scr.cols) return [l]; const o = []; for (let i = 0; i < l.length; i += scr.cols) o.push(l.slice(i, i + scr.cols)); return o }) : v.raw
}

function drawViewer() {
  const v = st.viewer
  const h = scr.rows - 2
  v.top = Math.max(0, Math.min(v.top, Math.max(0, v.lines.length - h)))
  scr.fill(0, 0, scr.cols, 1, ' ', BLK, CYN)
  const pct = v.lines.length <= h ? 100 : Math.round(((v.top + h) / v.lines.length) * 100)
  const encName = ENCODINGS.find((e) => e[0] === v.enc)?.[1] || v.enc
  const right = `${encName}  ${num(v.size)} ${L.bytes(0).split(' ')[1]}  ${t('viewerLine', { n: v.top + 1 })}  ${pct}%${v.truncated ? '  ' + t('viewerHead') : ''}`
  scr.put(1, 0, cutL(v.name, scr.cols - right.length - 4), BLK, CYN)
  scr.put(scr.cols - right.length - 1, 0, right, BLK, CYN)
  scr.fill(0, 1, scr.cols, h, ' ', LCY, BLU)
  for (let r = 0; r < h; r++) {
    const l = v.lines[v.top + r]
    if (l != null) scr.put(0, 1 + r, v.wrap ? l : l.slice(v.left, v.left + scr.cols), LCY, BLU)
  }
  scr.hit(0, 1, scr.cols, h, { wheel: (dy) => { v.top += dy > 0 ? 3 : -3; draw() } })
  const keys = t('keysViewer').slice()
  if (v.wrap) keys[1] = t('keyUnwrap')
  drawKeybar(keys)
}

function viewerKey(e) {
  const v = st.viewer
  const h = scr.rows - 2
  switch (e.key) {
    case 'Escape': case 'F3': case 'F10': st.viewer = null; break
    case 'ArrowDown': v.top++; break
    case 'ArrowUp': v.top--; break
    case 'PageDown': case ' ': v.top += h; break
    case 'PageUp': v.top -= h; break
    case 'Home': v.top = 0; v.left = 0; break
    case 'End': v.top = 1e9; break
    case 'ArrowRight': if (!v.wrap) v.left += 8; break
    case 'ArrowLeft': if (!v.wrap) v.left = Math.max(0, v.left - 8); break
    case 'F2': v.wrap = !v.wrap; layoutViewer(); break
    case 'F8': {
      const i = ENCODINGS.findIndex((x) => x[0] === v.enc)
      v.enc = ENCODINGS[(i + 1) % ENCODINGS.length][0]
      setViewerText(decodeText(v.data, v.enc))
      break
    }
    case 'F1': help(); break
    default: return
  }
  draw()
}

// ═══════════════════════════ действия ═══════════════════════════

function move(p, d) {
  if (!p.items.length) return
  p.cur = Math.max(0, Math.min(p.items.length - 1, p.cur + d))
  draw()
}

function toggleSel(p, it) {
  if (!it || it.up || it.virt) return
  if (p.sel.has(it.key)) p.sel.delete(it.key); else p.sel.add(it.key)
}

function targets(p) {
  const sel = p.items.filter((c) => p.sel.has(c.key))
  if (sel.length) return sel
  const it = p.items[p.cur]
  return it && !it.up && !it.virt ? [it] : []
}

function setSort(p, k) { p.sort = k; setItems(p, p.items.filter((c) => !c.up && !c.virt)); saveState(); draw() }

function maskRe(mask) {
  const parts = mask.split(/[;,]/).map((m) => m.trim()).filter(Boolean)
  const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^(' + parts.map((m) => (m === '*.*' ? '.*' : esc(m))).join('|') + ')$', 'i')
}

async function selectMask(add) {
  const p = active()
  const m = await prompt(add ? t('selTitle') : t('unselTitle'), t('maskLabel'), '*.*', { w: 48 })
  if (!m) return
  const re = maskRe(m)
  for (const it of p.items) {
    if (it.up || it.virt || (it.isDir && m === '*.*' && add)) continue
    if (re.test(it.name)) add ? p.sel.add(it.key) : p.sel.delete(it.key)
  }
  draw()
}

function invertSel() {
  const p = active()
  for (const it of p.items) if (!it.up && !it.virt && !it.isDir) toggleSel(p, it)
  draw()
}

function swapPanels() {
  st.panels = [st.panels[1], st.panels[0]]
  saveState(); draw()
}

function samePanel() {
  const p = active(), o = other()
  o.kind = p.kind; o.path = p.path; o.stack = p.stack.map((s) => ({ ...s })); o.sel.clear()
  saveState(); load(o)
}

function zoom(d) {
  const steps = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5, 4, 5, 6]
  if (d === 0) st.zoom = 0
  else {
    const cur = st.zoom || scr.scale
    let i = steps.findIndex((s) => s >= cur)
    if (i < 0) i = steps.length - 1
    st.zoom = steps[Math.max(0, Math.min(steps.length - 1, i + d))]
  }
  scr.resize(); saveState(); draw()
}

async function quit() {
  const r = await ask('Google Commander', [t('quitQ')], [{ label: t('yes'), v: true, hot: t('yesHot') }, { label: t('no'), v: false, hot: t('noHot') }], { cancel: false, scheme: 'cyan' })
  if (r) dc.app.quit()
}

function needDrive(p) {
  if (p.kind !== 'drive') return true
  if (!st.status.logged) { alertBox('Google Drive', st.status.hasClient ? t('needLogin') : t('needKey')); return false }
  return true
}

async function openFile(p, it) {
  try {
    if (p.kind === 'local') await dc.fs.open(joinPath(p.path, it.name))
    else if (it.link) await dc.app.openUrl(it.link)
  } catch (e) { alertBox(t('error'), e.message) }
}

async function view() {
  const p = active()
  const it = p.items[p.cur]
  if (!it || it.up) return
  if (it.isDir) return enter(p, it)
  if (p.kind === 'drive') return openFile(p, it)
  try {
    const full = joinPath(p.path, it.name)
    const h = await dc.fs.head(full)
    const data = Uint8Array.from(atob(h.data), (c) => c.charCodeAt(0))
    if (data.length && data.subarray(0, 8192).some((b) => b === 0)) return dc.fs.open(full)
    openViewer(full, data, h.size, h.truncated)
  } catch (e) { alertBox(t('viewTitle'), e.message) }
}

async function edit() {
  const p = active()
  const it = p.items[p.cur]
  if (!it || it.up || it.virt) return
  try {
    if (p.kind === 'local') { if (!it.isDir) await dc.fs.edit(joinPath(p.path, it.name)) }
    else if (it.link) await dc.app.openUrl(it.link)
  } catch (e) { alertBox(t('error'), e.message) }
}

function folderUrl(p) {
  const id = cwdId(p)
  return id === 'root' ? 'https://drive.google.com/drive/my-drive' : id === 'shared' ? 'https://drive.google.com/drive/shared-with-me' : 'https://drive.google.com/drive/folders/' + id
}

async function copyLink() {
  const p = active()
  const it = p.items[p.cur]
  if (!it) return
  const text = p.kind === 'local' ? joinPath(p.path, it.up ? '' : it.name).replace(/\\$/, '') : it.up || it.virt ? folderUrl(p) : it.link
  if (!text) return
  await dc.app.clipboard(text)
  flash(p.kind === 'local' ? t('pathCopied') : t('linkCopied'))
}

async function openOutside() {
  const p = active()
  try { if (p.kind === 'local') await dc.fs.explorer(p.path); else await dc.app.openUrl(folderUrl(p)) } catch (e) { alertBox(t('error'), e.message) }
}

function flash(text) {
  const d = { title: '', rows: [{ t: text, align: 'center' }], scheme: 'cyan' }
  dialog(d)
  setTimeout(() => { if (!d.closed) closeDialog(d) }, 900)
}

async function mkdir() {
  const p = active()
  if (!needDrive(p)) return
  if (p.kind === 'drive' && cwdId(p) === 'shared') return alertBox(t('mkdirTitle'), t('mkdirShared'))
  const name = await prompt(t('mkdirTitle'), t('mkdirLabel'))
  if (!name) return
  try {
    let focus = name
    if (p.kind === 'local') await dc.fs.mkdir(p.path, name)
    else focus = (await dc.gd.mkdir(cwdId(p), name)).id
    await load(p, focus)
    if (other().kind === p.kind) load(other())
  } catch (e) { alertBox(t('error'), t('mkdirFail', { q: q(name), e: e.message })) }
}

async function renameItem() {
  const p = active()
  const it = p.items[p.cur]
  if (!it || it.up || it.virt || !needDrive(p)) return
  const name = await prompt(t('renameTitle'), t('renameLabel', { q: q(cut(it.name, 40)) }), it.name)
  if (!name || name === it.name) return
  try {
    if (p.kind === 'local') await dc.fs.rename(p.path, it.name, name)
    else await dc.gd.rename(it.id, name)
    await load(p, p.kind === 'local' ? name : it.key)
    if (other().kind === p.kind) load(other())
  } catch (e) { alertBox(t('error'), e.message) }
}

async function remove() {
  const p = active()
  if (!needDrive(p)) return
  const list = targets(p)
  if (!list.length) return
  if (p.kind === 'drive' && cwdId(p) === 'shared') return alertBox(t('delTitle'), t('delShared'))
  const what = list.length === 1 ? t(list[0].isDir ? 'delDir' : 'delFile', { q: q(cut(list[0].name, 40)) }) : files(list.length)
  const where = p.kind === 'local' ? 'Windows' : 'Google Drive'
  const ok = await ask(t('delTitle'), [t('delQ', { what, where })], [{ label: t('delBtn'), v: true, hot: t('delHot') }, { label: t('cancel'), v: false }], { scheme: 'red', cancel: false })
  if (!ok) return
  const wait = { title: t('delTitle'), rows: [{ t: t('deleting', { what: files(list.length) }), align: 'center' }], noEsc: true }
  dialog(wait)
  let errors = []
  try {
    if (p.kind === 'local') errors = await dc.fs.trash(p.path, list.map((c) => c.name))
    else errors = await dc.gd.trash(list.map((c) => c.id))
  } catch (e) { errors = [e.message] }
  closeDialog(wait)
  p.sel.clear()
  await load(p)
  if (other().kind === p.kind) load(other())
  if (p.kind === 'drive') loadAbout()
  if (errors.length) alertBox(t('delTitle'), errors.slice(0, 5).join('\n'))
}

function sameLocation(a, b) {
  if (a.kind !== b.kind) return false
  return a.kind === 'local' ? a.path.toLowerCase() === b.path.toLowerCase() : cwdId(a) === cwdId(b)
}

const specOf = (p) => (p.kind === 'local' ? { kind: 'local', dir: p.path } : { kind: 'drive', folderId: cwdId(p) })

function opWords(op, src, dst) {
  if (op === 'move') return { verb: t('vMove'), head: t('moveTitle') }
  if (src === 'local' && dst === 'drive') return { verb: t('vUpload'), head: t('upTitle') }
  if (src === 'drive' && dst === 'local') return { verb: t('vDownload'), head: t('downTitle') }
  return { verb: t('vCopy'), head: t('copyTitle') }
}

async function confirmCopy(head, verb, what, dest) {
  const r = await dialog({
    title: head, w: 64,
    rows: [{ t: verb + ' ' + what }, { t: t('to') }, { t: cutL(dest, 56), fg: BLU }, { t: '' },
      { btns: [{ label: verb, v: true, def: true }, { label: t('cancel'), v: false }] }],
  })
  return r.v
}

async function copyMove(op) {
  const p = active(), o = other()
  const list = targets(p)
  if (!list.length) return
  if (!needDrive(p) || !needDrive(o)) return
  const { verb, head } = opWords(op, p.kind, o.kind)
  if (o.kind === 'drive' && cwdId(o) === 'shared') return alertBox(head, t('sharedNoCopy'))
  if (op === 'move' && p.kind === 'drive' && cwdId(p) === 'shared') return alertBox(head, t('sharedMoveOnly'))
  if (sameLocation(p, o)) return alertBox(head, t('sameLoc') + (op === 'move' ? '\n' + t('sameLocMove') : ''))
  const what = list.length === 1 ? q(cut(list[0].name, 44)) : files(list.length)
  const dest = title(o)
  if (!(await confirmCopy(head, verb, what, dest))) return
  await runJob({ op, src: specOf(p), dst: specOf(o), items: list.map((c) => ({ ...c })) }, { verb, head, dest })
  p.sel.clear()
}

// ═══════════════════════════ копирование: прогресс и вопросы ═══════════════════════════

const pending = new Map()
dc.onXfer((m) => {
  const j = st.job
  if (!j || j.id !== m.job) { pending.set(m.job, [...(pending.get(m.job) || []), m]); return }
  onXfer(j, m)
})

function onXfer(j, m) {
  if (m.type === 'progress') { j.p = m; updateProgress(j) }
  else if (m.type === 'ask') askXfer(j, m)
  else if (m.type === 'done') j.finish(m)
}

function updateProgress(j) {
  const m = j.p || {}
  const d = j.dlg
  const iw = 56
  const rows = []
  if (m.phase === 'scan') {
    rows.push({ t: t('scanning'), align: 'center' }, { t: cutL(m.name || '', iw), align: 'center' }, { t: '' })
    rows.push({ t: t('found', { f: files(m.filesTotal || 0), b: bytes(m.total || 0) }), align: 'center' })
  } else {
    rows.push({ t: j.verb + ':' }, { t: cutL(m.name || '', iw), fg: BLU })
    rows.push({ t: t('to') + ' ' + cutL(j.dest, iw - 6) })
    rows.push({ bar: m.fileSize ? m.fileDone / m.fileSize : 0 })
    rows.push({ t: padL(t('ofBytes', { a: bytes(m.fileDone || 0), b: bytes(m.fileSize || 0) }), iw) })
    rows.push({ sep: true })
    rows.push({ t: t('total', { n: m.files || 0, f: files(m.filesTotal || 0), a: bytes(m.done || 0), b: bytes(m.total || 0) }) })
    rows.push({ bar: m.total ? m.done / m.total : m.filesTotal ? m.files / m.filesTotal : 0 })
    const left = m.bps > 0 && m.total ? (m.total - m.done) / m.bps : 0
    const tl = left > 0 ? '   ' + t('timeLeft', { t: `${Math.floor(left / 3600) ? Math.floor(left / 3600) + ':' : ''}${two(Math.floor((left % 3600) / 60))}:${two(Math.floor(left % 60))}` }) : ''
    rows.push({ t: m.bps > 0 ? t('speed', { s: bytes(m.bps) }) + tl : '' })
  }
  rows.push({ t: '' })
  rows.push({ btns: [{ label: t('cancel'), fn: () => cancelJob(j) }] })
  d.rows = rows
  focusables(d)
  d.f = 0
  draw()
}

async function cancelJob(j) {
  if (j.cancelling) return
  const r = await ask(t('abortTitle'), [t('abortQ')], [{ label: t('btnAbort'), v: true }, { label: t('btnContinue'), v: false }], { scheme: 'red', cancel: false, f: 1 })
  if (r && !j.done) { j.cancelling = true; dc.xfer.cancel(j.id) }
}

async function askXfer(j, msg) {
  let v
  const m = msg.q
  if (m.type === 'exists') {
    const lw = Math.max(t('existsNew').length, t('existsOld').length) + 1
    const line = (label, x) => `${pad(label, lw)} ${padL(num(x.size), 15)} ${L.bytes(0).split(' ')[1]}  ${fdate(x.mtime)} ${ftime(x.mtime)}`
    v = await ask(t('existsTitle'), [
      { t: cut(m.name, 56), align: 'center', fg: YEL }, { t: '' },
      { t: line(t('existsNew'), m.src) }, { t: line(t('existsOld'), m.dst) },
    ], [
      { label: t('btnOverwrite'), v: 'overwrite' }, { label: t('btnAll'), v: 'overwriteAll' },
      { label: t('btnSkip'), v: 'skip' }, { label: t('btnSkipAll'), v: 'skipAll' }, { label: t('cancel'), v: 'cancel' },
    ], { scheme: 'red', cancel: 'cancel' })
  } else {
    v = await ask(t('error'), [{ t: cut(m.name, 56), align: 'center', fg: YEL }, ...wrap(m.message, 56).map((s) => ({ t: s, align: 'center' }))], [
      { label: t('btnRetry'), v: 'retry' }, { label: t('btnSkip'), v: 'skip' }, { label: t('btnSkipAll'), v: 'skipAll' }, { label: t('cancel'), v: 'cancel' },
    ], { scheme: 'red', cancel: 'cancel' })
  }
  if (v === 'cancel') j.cancelling = true
  dc.xfer.answer(j.id, msg.askId, v)
}

async function runJob(spec, { verb, head, dest }) {
  if (st.job) return alertBox(head, t('waitJob'))
  const j = { verb, dest, p: { phase: 'scan' } }
  j.dlg = { title: head, rows: [], noEsc: true, onKey: (e) => { if (e.key === 'Escape') { cancelJob(j); return true } return false } }
  const doneP = new Promise((r) => { j.finish = (m) => { j.done = true; r(m) } })
  dialog(j.dlg)
  updateProgress(j)
  try {
    j.id = await dc.xfer.start(spec)
  } catch (e) { closeDialog(j.dlg); return alertBox(t('error'), e.message) }
  st.job = j
  for (const m of pending.get(j.id) || []) onXfer(j, m)
  pending.delete(j.id)
  const res = await doneP
  st.job = null
  closeDialog(j.dlg)
  await reloadAll()
  if (spec.src.kind === 'drive' || spec.dst.kind === 'drive') loadAbout()
  if (res.error) await alertBox(t('error'), res.error)
  else if (res.cancelled) flash(t('aborted'))
  else if (res.skipped) await alertBox(t('doneTitle'), t('doneSkipped', { f: files(res.copied), n: res.skipped }), 'gray')
}

// ═══════════════════════════ аккаунт, ключ, язык ═══════════════════════════

async function login() {
  if (!st.status.hasClient) return settings()
  if (st.loggingIn) return
  st.loggingIn = true
  draw()
  try {
    st.status = await dc.auth.login()
    st.loggingIn = false
    await loadAbout()
    for (const p of st.panels) if (p.kind === 'drive') load(p)
    if (st.about) flash(t('loginDone', { w: st.about.email || st.about.name }))
  } catch (e) {
    st.loggingIn = false
    draw()
    if (e.code !== 'CANCELLED') alertBox(t('loginTitle'), e.message)
  }
}

async function account() {
  if (!st.status.logged) return login()
  await loadAbout()
  const a = st.about
  if (!a) return
  const rows = [{ t: a.name || '', align: 'center', fg: BLU }, { t: a.email || '', align: 'center' }, { t: '' }]
  if (a.limit) {
    const lw = Math.max(...['acctTotal', 'acctUsed', 'acctInDrive', 'acctTrash', 'acctFree'].map((k) => t(k).length)) + 2
    const row = (k, v, fg) => rows.push({ t: pad(t(k), lw) + padL(bytes(v), 12), fg })
    row('acctTotal', a.limit)
    row('acctUsed', a.usage)
    row('acctInDrive', a.inDrive)
    row('acctTrash', a.inTrash)
    row('acctFree', Math.max(0, a.limit - a.usage), BLU)
    rows.push({ t: '' })
    rows.push({ bar: a.usage / a.limit })
    rows.push({ t: t('acctPct', { p: Math.round((a.usage / a.limit) * 100) }), align: 'center' })
  } else rows.push({ t: t('usedUnlim', { a: bytes(a.usage) }) })
  rows.push({ t: '' })
  rows.push({ btns: [{ label: t('ok'), v: 'ok', def: true }, { label: t('btnSwitch'), v: 'switch' }, { label: t('btnLogout'), v: 'logout' }] })
  const r = await dialog({ title: t('acctTitle'), rows, w: 52 })
  if (r.v === 'logout') logout(true)
  if (r.v === 'switch') { await dc.auth.logout(); await refreshStatus(); login() }
}

async function logout(confirmed) {
  if (!st.status.logged) return
  if (confirmed !== true) {
    const ok = await ask(t('logoutTitle'), [t('logoutQ1'), t('logoutQ2')], [{ label: t('btnLogout'), v: true }, { label: t('cancel'), v: false }], { cancel: false })
    if (!ok) return
  }
  st.status = await dc.auth.logout()
  st.about = null
  for (const p of st.panels) if (p.kind === 'drive') { p.stack = p.stack.slice(0, 1); load(p) }
}

async function settings() {
  const s = await dc.auth.status()
  const cid = { input: true, id: 'cid', value: s.clientId || '', pos: (s.clientId || '').length }
  const sec = { input: true, id: 'sec', value: '', pos: 0, mask: true }
  async function importJson(dd) {
    try {
      const r = await dc.auth.importClient()
      if (!r) return
      st.status = r
      closeDialog(dd, 'imported')
    } catch (e) { alertBox(t('setTitle'), e.message) }
  }
  const r = await dialog({
    title: t('setTitle'), w: 72,
    rows: [
      { t: t('set1') }, { t: t('set2') }, { t: t('set3') }, { t: '' },
      { btns: [{ label: t('btnJson'), fn: importJson }, { label: t('btnHow'), fn: () => help() }] },
      { sep: true },
      { t: t('setManual') }, cid,
      { t: s.hasClient ? t('setSecretKeep') : t('setSecret') }, sec,
      { t: '' },
      { btns: [{ label: t('btnSave'), v: 'save', def: true }, { label: t('cancel'), v: null }] },
    ],
  })
  if (r.v === 'save') {
    const id = r.vals.cid.trim()
    if (!id) return
    const secret = r.vals.sec.trim()
    if (!secret && s.hasClient && id === s.clientId) return
    st.status = await dc.auth.setClient(id, secret)
  }
  if (r.v === 'save' || r.v === 'imported') {
    draw()
    const go = await ask(t('setTitle'), [t('keySaved'), t('loginNowQ')], [{ label: t('btnLogin'), v: true }, { label: t('btnLater'), v: false }], { cancel: false })
    if (go) login()
  }
}

function help() {
  const lines = L.HELP[L.lang] || L.HELP.en
  const h = Math.min(lines.length, scr.rows - 9)
  return dialog({ title: t('helpTitle'), w: 66, scheme: 'cyan', rows: [{ view: true, lines, h, top: 0 }, { t: '' }, { btns: [{ label: t('ok'), v: true }] }] })
}

function aboutApp() {
  return ask(t('aboutTitle'), [
    { t: 'GOOGLE COMMANDER', align: 'center', fg: BLU }, { t: t('aboutVer', { v: st.version }), align: 'center' }, { t: '' },
    { t: t('about1'), align: 'center' }, { t: t('about2'), align: 'center' }, { t: t('about3'), align: 'center' }, { t: '' },
    { t: t('about4'), align: 'center', fg: BLU },
  ], [{ label: t('ok'), v: true }], { scheme: 'cyan' })
}

async function pickLang() {
  const rows = L.LANGS.map((l) => ({ item: true, v: l, label: `${l.toUpperCase()}  ${L.NAMES[l]}`, hot: l[0] }))
  const d = { title: t('langTitle'), rows, scheme: 'cyan', w: 34 }
  d.f = Math.max(0, L.LANGS.indexOf(L.lang))
  const r = await dialog(d)
  if (r.v) setLang(r.v)
}

function setLang(l) {
  L.setLang(l)
  dc.app.setLang(l).catch(() => {})
  document.documentElement.lang = l
  for (const p of st.panels) setItems(p, p.items.filter((c) => !c.up && !c.virt))
  draw()
}

async function pickDrive(i) {
  st.act = i
  let drives = []
  try { drives = await dc.fs.drives() } catch {}
  const p = st.panels[i]
  const cur = p.kind === 'drive' ? 'gd' : p.path.slice(0, 1).toUpperCase()
  const rows = drives.map((d) => ({ item: true, v: d.path, hot: d.letter.toLowerCase(), label: `${d.letter}:  ${d.free != null ? padL(bytes(d.free), 10) + ' ' + t('freeShort') : ''}` }))
  const free = st.about?.limit ? '  ' + bytes(Math.max(0, st.about.limit - st.about.usage)) + ' ' + t('freeShort') : ''
  // «G» — Google Drive, если в компьютере нет диска G:
  const gHot = drives.some((d) => d.letter === 'G') ? '' : 'g'
  rows.push({ item: true, v: 'gd', label: '☼  Google Drive' + free, hot: gHot })
  const { x, w } = panelGeom(i)
  const d = { title: t('driveTitle'), rows, scheme: 'cyan', cx: x + Math.floor(w / 2) }
  d.f = Math.max(0, rows.findIndex((r) => (r.v === 'gd' ? 'gd' : r.v.slice(0, 1)) === cur))
  const r = await dialog(d)
  if (r.v) setDrive(i, r.v)
}

// ═══════════════════════════ командная строка ═══════════════════════════

async function runCommand(text) {
  const p = active()
  const cmd = text.trim()
  st.cmd = ''
  draw()
  if (!cmd) return
  if (/^[a-z]:$/i.test(cmd)) return setDrive(st.act, cmd.toUpperCase() + '\\')
  if (/^exit$/i.test(cmd)) return quit()
  if (/^cls$/i.test(cmd)) return
  const md = /^(md|mkdir)\s+(.+)$/i.exec(cmd)
  if (md) {
    const name = md[2].trim()
    try {
      if (p.kind === 'local') await dc.fs.mkdir(p.path, name)
      else if (needDrive(p)) await dc.gd.mkdir(cwdId(p), name)
      return load(p, name)
    } catch (e) { return alertBox('md', e.message) }
  }
  const cd = /^(cd|chdir)\s*(.*)$/i.exec(cmd)
  if (cd) {
    const arg = cd[2].trim().replace(/^"|"$/g, '')
    if (!arg) return
    if (arg === '..' || arg === '.\\..') return goUp(p)
    if (arg === '\\' || arg === '/') return goRoot(p)
    if (p.kind === 'drive') {
      const it = p.items.find((c) => c.isDir && !c.up && c.name.toLowerCase() === arg.toLowerCase())
      return it ? enter(p, it) : alertBox('cd', t('cdNoDir', { x: arg }))
    }
    const target = (/^[a-z]:/i.test(arg) ? arg : joinPath(p.path, arg)).replace(/\//g, '\\').replace(/^([a-z]):$/i, '$1:\\')
    const dir = await dc.fs.exists(target).catch(() => null)
    if (dir) { p.path = dir; p.sel.clear(); saveState(); return load(p) }
    return alertBox('cd', t('cdNoDir', { x: arg }))
  }
  if (p.kind !== 'local') return alertBox(t('cmdTitle'), t('cmdOnlyLocal'))
  try { await dc.fs.shell(p.path, cmd) } catch (e) { alertBox(t('cmdTitle'), e.message) }
}

// ═══════════════════════════ клавиатура ═══════════════════════════

function fkey(k, mods) {
  if (st.modal.length || st.menu || st.viewer) return
  const { alt, ctrl, shift } = mods
  const p = active()
  if (alt) {
    if (k === 'F1') return pickDrive(0)
    if (k === 'F2') return pickDrive(1)
    if (k === 'F7') { st.qs = { text: '' }; return draw() }
    return
  }
  if (ctrl) {
    const sorts = { F3: 'name', F4: 'ext', F5: 'time', F6: 'size', F7: 'none' }
    if (sorts[k]) setSort(p, sorts[k])
    return
  }
  if (shift) { if (k === 'F6') renameItem(); return }
  switch (k) {
    case 'F1': return help()
    case 'F2': return account()
    case 'F3': return view()
    case 'F4': return edit()
    case 'F5': return copyMove('copy')
    case 'F6': return copyMove('move')
    case 'F7': return mkdir()
    case 'F8': return remove()
    case 'F9': return openMenu()
    case 'F10': return quit()
  }
}

function quickSearch(ch) {
  const p = active()
  const text = st.qs.text + ch
  const low = text.toLowerCase()
  const i = p.items.findIndex((c) => !c.up && itemName(c).toLowerCase().startsWith(low))
  if (i >= 0) { st.qs.text = text; p.cur = i }
  draw()
}

function mainKey(e) {
  const p = active()
  const k = e.key
  const ctrl = e.ctrlKey, alt = e.altKey, shift = e.shiftKey

  if (/^F\d+$/.test(k)) return fkey(k, { alt, ctrl, shift })

  if (st.qs) {
    if (k === 'Escape' || k === 'Enter' || k === 'Tab') { st.qs = null; draw(); if (k === 'Enter') enter(p, p.items[p.cur]); return }
    if (k === 'Backspace') { st.qs.text = st.qs.text.slice(0, -1); return draw() }
    if (k.length === 1 && !ctrl) return quickSearch(k)
    st.qs = null
  }

  if (alt && k === 'Enter') return dc.app.fullscreen()
  if (alt && k.length === 1 && !ctrl) { st.qs = { text: '' }; return quickSearch(k) }

  if (ctrl) {
    const c = e.code
    if (c === 'KeyR') return load(p)
    if (c === 'KeyU') return swapPanels()
    if (c === 'KeyK') return copyLink()
    if (c === 'KeyE') return openOutside()
    if (c === 'Backslash') return goRoot(p)
    if (c === 'KeyA') { for (const it of p.items) if (!it.up && !it.virt) p.sel.add(it.key); return draw() }
    if (c === 'Equal' && !shift) return samePanel()
    if (c === 'Equal' || c === 'NumpadAdd') return zoom(1)
    if (c === 'Minus' || c === 'NumpadSubtract') return zoom(-1)
    if (c === 'Digit0' || c === 'Numpad0') return zoom(0)
    if (c === 'PageUp') return goUp(p)
    if (c === 'PageDown') return enter(p, p.items[p.cur])
    if (c === 'KeyV') return dc.app.paste().then((s) => { st.cmd += String(s).replace(/[\r\n]+/g, ' '); draw() })
    if (c === 'Enter') { const it = p.items[p.cur]; if (it && !it.up && !it.virt) { st.cmd += (st.cmd && !st.cmd.endsWith(' ') ? ' ' : '') + (it.name.includes(' ') ? `"${it.name}"` : it.name); draw() } return }
    return
  }

  switch (k) {
    case 'Tab': st.act = 1 - st.act; saveState(); return draw()
    case 'ArrowDown': return move(p, 1)
    case 'ArrowUp': return move(p, -1)
    case 'PageDown': return move(p, p.listH - 1)
    case 'PageUp': return move(p, -(p.listH - 1))
    case 'Home': if (!st.cmd) { p.cur = 0; return draw() } return
    case 'End': if (!st.cmd) { p.cur = p.items.length - 1; return draw() } return
    case 'ArrowLeft': if (!st.cmd) return move(p, -p.listH); return
    case 'ArrowRight': if (!st.cmd) return move(p, p.listH); return
    case 'Insert': toggleSel(p, p.items[p.cur]); return move(p, 1)
    case 'Enter': return st.cmd ? runCommand(st.cmd) : enter(p, p.items[p.cur])
    case 'Escape': st.cmd = ''; return draw()
    case 'Backspace': if (st.cmd) { st.cmd = st.cmd.slice(0, -1); return draw() } return goUp(p)
  }
  if (e.code === 'NumpadAdd' && !st.cmd) return selectMask(true)
  if (e.code === 'NumpadSubtract' && !st.cmd) return selectMask(false)
  if (e.code === 'NumpadMultiply' && !st.cmd) return invertSel()
  if (k === ' ' && !st.cmd) { toggleSel(p, p.items[p.cur]); return move(p, 1) }
  if (k.length === 1) { st.cmd += k; draw() }
}

window.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'F4') return
  const prevent = e.key.startsWith('F') || e.key === 'Tab' || e.altKey || (e.ctrlKey && e.code !== 'KeyC') || e.key === 'Backspace' || e.key === ' '
  if (prevent) e.preventDefault()
  if (['Alt', 'Control', 'Shift'].includes(e.key)) { setMods(e); return }
  st.blink = true
  if (st.modal.length) return dialogKey(st.modal[st.modal.length - 1], e)
  if (st.viewer) return viewerKey(e)
  if (st.menu) return menuKey(e)
  if (st.loggingIn && e.key === 'Escape') { dc.auth.cancel(); return }
  mainKey(e)
})
window.addEventListener('keyup', (e) => {
  if (e.key === 'Alt') e.preventDefault()
  setMods(e)
})
window.addEventListener('blur', () => { st.mods = { alt: false, ctrl: false, shift: false }; draw() })

function setMods(e) {
  const m = { alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey }
  if (m.alt !== st.mods.alt || m.ctrl !== st.mods.ctrl || m.shift !== st.mods.shift) { st.mods = m; draw() }
}

// ═══════════════════════════ мышь и перетаскивание ═══════════════════════════

function cellOf(e) {
  const r = canvas.getBoundingClientRect()
  return { x: Math.floor(((e.clientX - r.left) / r.width) * scr.cols), y: Math.floor(((e.clientY - r.top) / r.height) * scr.rows) }
}

canvas.addEventListener('mousedown', (e) => {
  const c = cellOf(e)
  st.blink = true
  // щелчок по верхней строке открывает меню, как в NC
  if (!st.modal.length && !st.menu && !st.viewer && c.y === 0 && e.button === 0) {
    const list = menuLayout()
    let i = list.findIndex((m) => c.x >= m.x && c.x < m.x + m.t.length + 4)
    if (i < 0) i = c.x < scr.cols / 2 ? 0 : 4
    st.menu = { i, j: firstItem(list[i].items), open: true }
    return draw()
  }
  if (e.button === 2) return scr.hitAt(c.x, c.y, 'right')?.right?.()
  if (e.button !== 0) return
  if (e.detail >= 2) { const h = scr.hitAt(c.x, c.y, 'dbl'); if (h?.dbl) return h.dbl() }
  scr.hitAt(c.x, c.y, 'click')?.click?.()
})
canvas.addEventListener('contextmenu', (e) => e.preventDefault())
canvas.addEventListener('wheel', (e) => {
  if (e.ctrlKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); return }
  const c = cellOf(e)
  scr.hitAt(c.x, c.y, 'wheel')?.wheel?.(e.deltaY)
}, { passive: false })

window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' })
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  if (st.modal.length || st.viewer || st.job) return
  const paths = [...e.dataTransfer.files].map((f) => dc.pathForFile(f)).filter(Boolean)
  if (!paths.length) return
  const c = cellOf(e)
  const i = c.x < scr.cols / 2 ? 0 : 1
  st.act = i
  const p = st.panels[i]
  if (!needDrive(p)) return
  const { verb, head } = opWords('copy', 'local', p.kind)
  if (p.kind === 'drive' && cwdId(p) === 'shared') return alertBox(head, t('dropShared'))
  const groups = new Map()
  for (const f of paths) {
    const dir = parentPath(f), name = lastName(f)
    if (!groups.has(dir)) groups.set(dir, [])
    groups.get(dir).push({ name, key: name })
  }
  const what = paths.length === 1 ? q(cut(lastName(paths[0]), 44)) : files(paths.length)
  if (!(await confirmCopy(head, verb, what, title(p)))) return
  for (const [dir, items] of groups) {
    if (p.kind === 'local' && dir.toLowerCase() === p.path.toLowerCase()) continue
    await runJob({ op: 'copy', src: { kind: 'local', dir }, dst: specOf(p), items }, { verb, head, dest: title(p) })
  }
})

// ═══════════════════════════ демо для скриншотов (только при разработке, --demo) ═══════════════════════════

function demoShim() {
  const G = 1024 ** 3, M = 1024 ** 2
  const at = (d, h = 12, m = 0) => new Date(2026, 9, d, h, m).getTime()
  const F = (name, size, mtime, extra = {}) => ({ key: name, id: name, targetId: name, name, isDir: false, size: Math.round(size), mtime, link: 'https://drive.google.com/', ...extra })
  const D = (name, mtime) => ({ key: name, id: name, targetId: name, name, isDir: true, size: 0, mtime, link: 'https://drive.google.com/' })
  const doc = (name, mtime, mime) => F(name, 0, mtime, { gdoc: true, mime })
  const N = {
    ru: ['Архив 2025', 'Документы', 'Карты', 'Резервные копии', 'Фото 2026', 'План на ноябрь', 'Бюджет 2026', 'Отчёт за сентябрь.pdf', 'Смета ремонта.xlsx'],
    en: ['Archive 2025', 'Documents', 'Maps', 'Backups', 'Photos 2026', 'November plan', 'Budget 2026', 'September report.pdf', 'Renovation estimate.xlsx'],
    de: ['Archiv 2025', 'Dokumente', 'Karten', 'Sicherungen', 'Fotos 2026', 'Plan für November', 'Budget 2026', 'Bericht September.pdf', 'Kostenvoranschlag.xlsx'],
    fr: ['Archives 2025', 'Documents', 'Cartes', 'Sauvegardes', 'Photos 2026', 'Plan de novembre', 'Budget 2026', 'Rapport de septembre.pdf', 'Devis rénovation.xlsx'],
    es: ['Archivo 2025', 'Documentos', 'Mapas', 'Copias de seguridad', 'Fotos 2026', 'Plan de noviembre', 'Presupuesto 2026', 'Informe de septiembre.pdf', 'Presupuesto reforma.xlsx'],
  }
  const tree = () => {
    const n = N[L.lang] || N.en
    return [D(n[0], at(2, 9)), D(n[1], at(11, 18, 4)), D(n[2], at(9, 21, 40)), D(n[3], at(13, 3, 15)), D(n[4], at(14, 20, 31)),
      doc(n[5], at(14, 11, 2), 'application/vnd.google-apps.document'), doc(n[6], at(12, 16, 45), 'application/vnd.google-apps.spreadsheet'),
      F('backup-2026-10-13.zip', 734 * M, at(13, 3, 15)), F('IMG_2041.jpg', 4.2 * M, at(14, 20, 31)), F('IMG_2042.jpg', 3.9 * M, at(14, 20, 32)),
      F(n[7], 1.3 * M, at(1, 10, 20)), F(n[8], 48213, at(6, 14, 7)), F('notes.txt', 2911, at(10, 8, 55))]
  }
  st.status = { hasClient: true, logged: true }
  dc.gd.list = async (id) => (id === 'root' ? tree() : [F('README.txt', 1520, at(3)), F('scan_001.pdf', 2.4 * M, at(5, 9))])
  dc.gd.about = async () => ({ name: 'Demo User', email: 'demo.user@example.com', limit: 15 * G, usage: 6.4 * G, inDrive: 5.9 * G, inTrash: 0.5 * G })
  dc.auth.status = async () => ({ hasClient: true, logged: true, clientId: 'demo' })
  // копирование — имитация загрузки с прогрессом
  dc.xfer.start = async (spec) => {
    const id = 999, list = spec.items.length ? spec.items : [{ name: 'file', size: 900 * M }]
    const total = list.reduce((a, it) => a + (it.size || 0), 0)
    let done = 0, i = 0, fileDone = 0
    const tick = setInterval(() => {
      const f = list[i]
      fileDone = Math.min(f.size, fileDone + 2.4 * M); done += 2.4 * M
      onXfer(st.job || { id }, { job: id, type: 'progress', phase: 'copy', name: f.name, fileDone, fileSize: f.size, done: Math.min(done, total), total, files: i, filesTotal: list.length, bps: 9.6 * M })
      if (fileDone >= f.size) { i++; fileDone = 0 }
      if (i >= list.length) { clearInterval(tick); st.job?.finish({ copied: list.length, skipped: 0 }) }
    }, 250)
    return id
  }
}

// ═══════════════════════════ запуск ═══════════════════════════

window.addEventListener('resize', () => { scr.resize(); if (st.viewer) layoutViewer(); draw() })
setInterval(() => { st.blink = !st.blink; if (scr.cursor) draw() }, 500)
setInterval(draw, 15000)

;(async () => {
  const init = await dc.app.init()
  st.version = init.version
  st.status = init.status
  L.setLang(init.lang)
  document.documentElement.lang = init.lang
  if (init.demo) demoShim()
  const s = init.state || {}
  st.zoom = s.zoom || 0
  st.act = s.act || 0
  const sp = s.panels || []
  st.panels = [newPanel(sp[0]?.kind || 'local', sp[0]), newPanel(sp[1]?.kind || 'drive', sp[1])]
  scr.setFonts(init.font, init.fontLat)
  scr.resize()
  draw()
  for (const p of st.panels) {
    if (p.kind === 'local' && !(await dc.fs.exists(p.path).catch(() => false))) p.path = 'C:\\'
    load(p)
  }
  if (st.status.logged) loadAbout()
})()
