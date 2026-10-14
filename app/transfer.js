// Копирование и перенос (F5/F6) между любыми панелями: компьютер ⇄ Google Drive, компьютер → компьютер, Drive → Drive.
// Вопросы «файл уже есть» и «ошибка» задаются окну программы и ждут ответа.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { pipeline } = require('node:stream/promises')
const { Transform } = require('node:stream')
const drive = require('./drive')
const { t, q } = require('./i18n')

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

function safeLocalName(name) {
  let n = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '')
  if (!n) n = '_'
  if (RESERVED.test(n)) n = '_' + n
  return n
}

class Job {
  constructor(id, spec, send) {
    this.id = id
    this.spec = spec
    this.send = (m) => send({ job: id, ...m })
    this.ac = new AbortController()
    this.asks = new Map()
    this.askSeq = 0
    this.policy = { exists: null, error: null }
    this.total = 0; this.done = 0
    this.files = 0; this.filesTotal = 0
    this.copied = 0; this.skipped = 0
    this.cur = { name: '', size: 0, done: 0 }
    this.lastSend = 0
    this.speed = { t: Date.now(), b: 0, bps: 0 }
    this.cancelled = false
    this.sameKind = spec.src.kind === spec.dst.kind
    this.move = spec.op === 'move'
  }

  cancel() {
    this.cancelled = true
    this.ac.abort()
    for (const r of this.asks.values()) r('cancel')
    this.asks.clear()
  }

  answer(askId, value) {
    const r = this.asks.get(askId)
    if (r) { this.asks.delete(askId); r(value) }
  }

  ask(q) {
    if (this.cancelled) return Promise.resolve('cancel')
    const askId = ++this.askSeq
    this.send({ type: 'ask', askId, q })
    return new Promise((r) => this.asks.set(askId, r))
  }

  check() { if (this.cancelled) { const e = new Error(t('eCancelled')); e.code = 'CANCELLED'; throw e } }

  progress(force = false) {
    const now = Date.now()
    if (!force && now - this.lastSend < 100) return
    this.lastSend = now
    const dt = now - this.speed.t
    if (dt >= 1000) {
      const bytes = this.done + this.cur.done
      this.speed.bps = ((bytes - this.speed.b) * 1000) / dt
      this.speed = { t: now, b: bytes, bps: this.speed.bps }
    }
    this.send({
      type: 'progress', phase: this.phase, name: this.cur.name, fileDone: this.cur.done, fileSize: this.cur.size,
      done: this.done + this.cur.done, total: this.total, files: this.files, filesTotal: this.filesTotal, bps: this.speed.bps,
    })
  }

  // ---------- обход источника ----------

  async scanLocal(full, name) {
    this.check()
    const st = await fsp.stat(full)
    const node = { name, isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs, local: full }
    if (node.isDir) {
      node.children = []
      for (const e of await fsp.readdir(full)) node.children.push(await this.scanLocal(path.join(full, e), e))
    } else { this.total += node.size; this.filesTotal++ }
    this.cur.name = full; this.progress()
    return node
  }

  async scanDrive(file, parentId) {
    this.check()
    const node = { name: file.name, isDir: file.isDir, size: file.size, mtime: file.mtime, drive: file, parentId }
    if (node.isDir) {
      node.children = []
      for (const f of await drive.list(file.targetId)) node.children.push(await this.scanDrive(f, file.targetId))
    } else { this.total += file.size; this.filesTotal++ }
    this.cur.name = file.name; this.progress()
    return node
  }

  async childrenOf(node) {
    if (node.local) return Promise.all((await fsp.readdir(node.local)).map((e) => this.scanLocal(path.join(node.local, e), e)))
    return Promise.all((await drive.list(node.drive.targetId)).map((f) => this.scanDrive(f, node.drive.targetId)))
  }

  // ---------- место назначения ----------

  dstName(node) {
    if (this.spec.dst.kind !== 'local') return node.name
    let n = safeLocalName(node.name)
    const ex = node.drive && drive.exportInfo(node.drive)
    if (ex && !n.toLowerCase().endsWith(ex.ext)) n += ex.ext
    return n
  }

  async existsAt(dst, name) {
    if (dst.kind === 'local') {
      const p = path.join(dst.dir, name)
      try { const st = await fsp.stat(p); return { isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, path: p } } catch { return null }
    }
    const found = await drive.findChild(dst.folderId, name)
    return found.length ? found.sort((a, b) => b.isDir - a.isDir)[0] : null
  }

  async mkdirAt(dst, name) {
    if (dst.kind === 'local') { const p = path.join(dst.dir, name); await fsp.mkdir(p, { recursive: true }); return { kind: 'local', dir: p } }
    const f = await drive.mkdir(dst.folderId, name)
    return { kind: 'drive', folderId: f.id }
  }

  subOf(dst, ex) { return dst.kind === 'local' ? { kind: 'local', dir: ex.path } : { kind: 'drive', folderId: ex.targetId } }

  async removeSrc(node) {
    if (node.local) {
      if (node.isDir) await fsp.rmdir(node.local).catch(() => {})
      else await fsp.rm(node.local, { force: true })
    } else await drive.trash(node.drive.id)
  }

  // ---------- вопросы ----------

  async onExists(node, ex) {
    if (this.policy.exists) return this.policy.exists
    const a = await this.ask({ type: 'exists', name: node.name, src: { size: node.size, mtime: node.mtime }, dst: { size: ex.size, mtime: ex.mtime } })
    if (a === 'overwriteAll') { this.policy.exists = 'overwrite'; return 'overwrite' }
    if (a === 'skipAll') { this.policy.exists = 'skip'; return 'skip' }
    return a
  }

  async onError(node, e) {
    if (this.policy.error) return this.policy.error
    const a = await this.ask({ type: 'error', name: node.name, message: e.message })
    if (a === 'skipAll') { this.policy.error = 'skip'; return 'skip' }
    return a
  }

  cancelErr() { const e = new Error(t('eCancelled')); e.code = 'CANCELLED'; return e }

  // ---------- выполнение ----------

  async exec(node, dst) {
    for (;;) {
      this.check()
      try {
        return node.isDir ? await this.execDir(node, dst) : await this.execFile(node, dst)
      } catch (e) {
        if (this.cancelled || e.code === 'CANCELLED') throw this.cancelErr()
        if (e.code === 'AUTH') throw e
        const a = await this.onError(node, e)
        if (a === 'retry') continue
        if (a === 'skip') { this.skipped++; this.skipBytes(node); return false }
        throw this.cancelErr()
      }
    }
  }

  skipBytes(node) {
    if (node.isDir) { for (const c of node.children || []) this.skipBytes(c) } else if (!node._counted) { node._counted = true; this.done += node.size; this.files++ }
  }

  async execDir(node, dst) {
    const name = this.dstName(node)
    if (node.local && dst.kind === 'local') {
      const target = path.resolve(dst.dir, name)
      if ((target + path.sep).toLowerCase().startsWith(path.resolve(node.local).toLowerCase() + path.sep)) throw new Error(t('eSelfDir'))
    }
    if (node.drive && dst.kind === 'drive' && dst.folderId === node.drive.targetId) throw new Error(t('eSelfDir'))
    const ex = await this.existsAt(dst, name)
    if (ex && !ex.isDir) throw new Error(t('eFileThere', { q: q(name) }))

    // перенос внутри одного хранилища — одним действием, если такой папки там ещё нет
    if (this.move && this.sameKind && !ex) {
      this.cur = { name: node.name, size: 0, done: 0 }; this.progress()
      if (node.local) {
        try { await fsp.rename(node.local, path.join(dst.dir, name)); this.files++; this.copied++; return true } catch (e) { if (e.code !== 'EXDEV') throw e }
      } else {
        await drive.move(node.drive.id, node.parentId, dst.folderId); this.files++; this.copied++; return true
      }
    }

    const sub = ex ? this.subOf(dst, ex) : await this.mkdirAt(dst, name)
    if (!node.children) node.children = await this.childrenOf(node)
    let all = true
    for (const c of node.children) all = (await this.exec(c, sub)) && all
    if (this.move && all) await this.removeSrc(node)
    return all
  }

  async execFile(node, dst) {
    const name = this.dstName(node)
    const ex = await this.existsAt(dst, name)
    if (ex?.isDir) throw new Error(t('eDirThere', { q: q(name) }))
    if (ex) {
      const same = node.local ? ex.path && path.resolve(ex.path).toLowerCase() === path.resolve(node.local).toLowerCase() : ex.id === node.drive.id
      if (same) throw new Error(t('eSelfFile'))
      const a = await this.onExists(node, ex)
      if (a === 'skip') { this.skipped++; this.skipBytes(node); return false }
      if (a !== 'overwrite') throw this.cancelErr()
    }

    this.cur = { name: node.name, size: node.size, done: 0 }
    this.progress(true)
    const tick = (n) => { this.cur.done = Math.min(n, this.cur.size || n); this.progress() }
    const signal = this.ac.signal
    const { kind } = dst
    let moved = false

    if (node.local && kind === 'drive') {
      await drive.upload(node.local, { parent: dst.folderId, name, existingId: ex?.id }, tick, signal)
    } else if (node.drive && kind === 'local') {
      await drive.download(node.drive, path.join(dst.dir, name), tick, signal)
    } else if (node.local) {
      const target = path.join(dst.dir, name)
      if (this.move) {
        try { await fsp.rename(node.local, target); moved = true } catch (e) { if (e.code !== 'EXDEV') throw e }
      }
      if (!moved) await this.copyLocal(node, target, tick, signal)
    } else {
      if (ex) await drive.trash(ex.id)
      if (this.move) { await drive.move(node.drive.id, node.parentId, dst.folderId, name !== node.name ? name : undefined); moved = true }
      else await drive.copy(node.drive.id, dst.folderId, name)
    }

    if (this.move && !moved) await this.removeSrc(node)
    this.cur = { name: node.name, size: 0, done: 0 }
    this.done += node.size; this.files++; this.copied++; node._counted = true
    this.progress(true)
    return true
  }

  async copyLocal(node, target, tick, signal) {
    const tmp = target + '.dcpart'
    let n = 0
    const meter = new Transform({ transform(chunk, _e, cb) { n += chunk.length; tick(n); cb(null, chunk) } })
    try {
      await pipeline(fs.createReadStream(node.local), meter, fs.createWriteStream(tmp), { signal })
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      if (signal.aborted) throw this.cancelErr()
      throw e
    }
    await fsp.rm(target, { force: true })
    await fsp.rename(tmp, target)
    await fsp.utimes(target, new Date(), new Date(node.mtime)).catch(() => {})
  }

  async run() {
    const { src, items } = this.spec
    let error = null
    try {
      if (this.move && src.kind === 'drive' && src.folderId === 'shared') throw new Error(t('eSharedMove'))
      this.phase = 'scan'; this.progress(true)
      const nodes = []
      const deep = !(this.move && this.sameKind)   // перенос в пределах хранилища не требует обхода
      for (const it of items) {
        if (src.kind === 'local') {
          const full = path.join(src.dir, it.name)
          nodes.push(deep ? await this.scanLocal(full, it.name) : { name: it.name, isDir: it.isDir, size: it.size, mtime: it.mtime, local: full })
        } else {
          nodes.push(deep ? await this.scanDrive(it, src.folderId) : { name: it.name, isDir: it.isDir, size: it.size, mtime: it.mtime, drive: it, parentId: src.folderId })
        }
      }
      if (!deep) { this.filesTotal = nodes.length; this.total = nodes.reduce((a, n) => a + (n.isDir ? 0 : n.size), 0) }
      this.phase = 'copy'; this.progress(true)
      for (const n of nodes) await this.exec(n, this.spec.dst)
    } catch (e) {
      if (!(this.cancelled || e.code === 'CANCELLED')) error = e.message
    }
    this.progress(true)
    this.send({ type: 'done', cancelled: this.cancelled, error, copied: this.copied, skipped: this.skipped })
  }
}

module.exports = { Job }
