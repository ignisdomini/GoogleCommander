// Файлы компьютера: диски, каталоги, место на диске, папки, корзина Windows.
const fsp = require('node:fs/promises')
const path = require('node:path')
const { shell } = require('electron')

async function space(p) {
  try {
    const s = await fsp.statfs(p)
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  } catch { return null }
}

async function drives() {
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('')
  const found = await Promise.all(letters.map(async (l) => {
    const root = l + ':\\'
    try { await fsp.access(root) } catch { return null }
    return { letter: l, path: root, ...(await space(root)) }
  }))
  return found.filter(Boolean).sort((a, b) => a.letter.localeCompare(b.letter))
}

async function list(dir) {
  const ents = await fsp.readdir(dir, { withFileTypes: true })
  return Promise.all(ents.map(async (e) => {
    const p = path.join(dir, e.name)
    try {
      const st = await fsp.stat(p)
      return { key: e.name, name: e.name, isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs }
    } catch {
      return { key: e.name, name: e.name, isDir: e.isDirectory() || e.isSymbolicLink(), size: 0, mtime: 0, broken: true }
    }
  }))
}

async function mkdir(dir, name) { await fsp.mkdir(path.join(dir, name)) }
async function rename(dir, from, to) { await fsp.rename(path.join(dir, from), path.join(dir, to)) }

// Удаление — только в корзину Windows, чтобы ошибку можно было исправить
async function trash(dir, names) {
  const errors = []
  for (const n of names) {
    try { await shell.trashItem(path.join(dir, n)) } catch (e) { errors.push(n + ': ' + e.message) }
  }
  return errors
}

// Начало файла для встроенного просмотрщика (F3)
async function head(file, max = 4 * 1024 * 1024) {
  const fh = await fsp.open(file, 'r')
  try {
    const st = await fh.stat()
    const len = Math.min(st.size, max)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)
    return { data: buf, size: st.size, truncated: st.size > max }
  } finally { await fh.close() }
}

module.exports = { drives, list, space, mkdir, rename, trash, head }
