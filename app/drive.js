// Google Drive API v3: список папок, квота, папки, корзина, загрузка (resumable, кусками) и скачивание.
const https = require('node:https')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { once } = require('node:events')
const auth = require('./auth')
const { t } = require('./i18n')

const API = 'https://www.googleapis.com/drive/v3'
const UP = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER = 'application/vnd.google-apps.folder'
const SHORTCUT = 'application/vnd.google-apps.shortcut'
const FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,shortcutDetails,parents,capabilities(canTrash,canRename)'
const CHUNK = 8 * 1024 * 1024        // кратно 256 КБ
const SLICE = 256 * 1024

// Документы Google скачиваются экспортом в офисные форматы
const EXPORT = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
  'application/vnd.google-apps.drawing': { mime: 'image/png', ext: '.png' },
  'application/vnd.google-apps.script': { mime: 'application/vnd.google-apps.script+json', ext: '.json' },
  'application/vnd.google-apps.jam': { mime: 'application/pdf', ext: '.pdf' },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
const abortError = () => { const e = new Error(t('eCancelled')); e.code = 'CANCELLED'; return e }

const REASONS = {
  storageQuotaExceeded: 'rQuota', quotaExceeded: 'rQuota', insufficientFilePermissions: 'rPerm',
  cannotDownloadAbusiveFile: 'rAbuse', exportSizeLimitExceeded: 'rExportSize', notFound: 'rNotFound',
  fileNotDownloadable: 'rNotDl', accessNotConfigured: 'rApiOff', SERVICE_DISABLED: 'rApiOff',
}

async function apiError(status, text) {
  let msg = t('eDrive', { s: status }), reason
  try {
    const j = JSON.parse(text)
    reason = j.error?.errors?.[0]?.reason || j.error?.details?.[0]?.reason || j.error?.status
    msg = (REASONS[reason] && t(REASONS[reason])) || j.error?.message || msg
  } catch {}
  const e = new Error(msg); e.status = status; e.reason = reason
  return e
}

function netError(e) {
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return abortError()
  const x = new Error(t('eNet', { c: e.cause?.code || e.code || e.message })); x.code = 'NET'
  return x
}

async function req(url, opt = {}, attempt = 0) {
  const token = await auth.getToken(!!opt._force)
  let r
  try {
    r = await fetch(url, { ...opt, headers: { Authorization: 'Bearer ' + token, ...opt.headers } })
  } catch (e) {
    if (opt.signal?.aborted) throw abortError()
    if (attempt < 4) { await sleep(800 * 2 ** attempt); return req(url, opt, attempt + 1) }
    throw netError(e)
  }
  if (r.status === 401 && !opt._force) return req(url, { ...opt, _force: true }, attempt + 1)
  if ((r.status === 429 || r.status >= 500) && attempt < 5) {
    await sleep(1000 * 2 ** attempt + Math.random() * 500)
    return req(url, opt, attempt + 1)
  }
  if (!r.ok) throw await apiError(r.status, await r.text())
  return r
}

const json = async (url, opt) => (await req(url, opt)).json()
const url = (base, params) => base + '?' + new URLSearchParams({ supportsAllDrives: 'true', ...params })

function norm(f) {
  const sc = f.mimeType === SHORTCUT ? f.shortcutDetails : null
  const mime = sc ? sc.targetMimeType : f.mimeType
  const isDir = mime === FOLDER
  return {
    key: f.id, id: f.id, targetId: sc ? sc.targetId : f.id, name: f.name, isDir, mime,
    shortcut: !!sc, size: Number(f.size || 0), mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
    link: f.webViewLink || '', gdoc: !isDir && mime.startsWith('application/vnd.google-apps.'),
    canTrash: f.capabilities?.canTrash !== false, canRename: f.capabilities?.canRename !== false,
  }
}

async function list(folderId) {
  const query = folderId === 'shared' ? 'sharedWithMe and trashed=false' : `'${q(folderId)}' in parents and trashed=false`
  const out = []
  let pageToken
  do {
    const j = await json(url(API + '/files', {
      q: query, pageSize: '1000', fields: `nextPageToken,files(${FIELDS})`,
      includeItemsFromAllDrives: 'true', ...(pageToken ? { pageToken } : {}),
    }))
    for (const f of j.files || []) out.push(norm(f))
    pageToken = j.nextPageToken
  } while (pageToken)
  return out
}

async function about() {
  const j = await json(API + '/about?fields=' + encodeURIComponent('user(displayName,emailAddress),storageQuota'))
  const s = j.storageQuota || {}
  return {
    name: j.user?.displayName || '', email: j.user?.emailAddress || '',
    limit: s.limit ? Number(s.limit) : null, usage: Number(s.usage || 0),
    inDrive: Number(s.usageInDrive || 0), inTrash: Number(s.usageInDriveTrash || 0),
  }
}

async function findChild(parent, name) {
  const j = await json(url(API + '/files', {
    q: `'${q(parent)}' in parents and name='${q(name)}' and trashed=false`,
    fields: `files(${FIELDS})`, pageSize: '50', includeItemsFromAllDrives: 'true',
  }))
  return (j.files || []).map(norm)
}

async function mkdir(parent, name) {
  return norm(await json(url(API + '/files', { fields: FIELDS }), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
  }))
}

const patch = async (id, body, params = {}) => norm(await json(url(API + '/files/' + id, { fields: FIELDS, ...params }), {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}))
const rename = (id, name) => patch(id, { name })
const trash = (id) => patch(id, { trashed: true })
const move = (id, from, to, name) => patch(id, name ? { name } : {}, { addParents: to, removeParents: from })

async function copy(id, parent, name) {
  return norm(await json(url(API + '/files/' + id + '/copy', { fields: FIELDS }), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parents: [parent] }),
  }))
}

// ---------- загрузка с компьютера: сессия resumable, куски по 8 МБ, докачка после обрыва ----------

function putChunk(session, buf, offset, total, signal, onSent) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Length': String(buf.length) }
    headers['Content-Range'] = buf.length ? `bytes ${offset}-${offset + buf.length - 1}/${total}` : `bytes */${total}`
    const rq = https.request(new URL(session), { method: 'PUT', headers, signal }, (res) => {
      const parts = []
      res.on('data', (d) => parts.push(d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }))
      res.on('error', reject)
    })
    rq.on('error', (e) => reject(signal?.aborted ? abortError() : e))
    let sent = 0
    const pump = () => {
      while (sent < buf.length) {
        const n = Math.min(SLICE, buf.length - sent)
        const ok = rq.write(buf.subarray(sent, sent + n))
        sent += n
        onSent?.(sent)
        if (!ok) { rq.once('drain', pump); return }
      }
      rq.end()
    }
    pump()
  })
}

const nextOffset = (r) => { const m = /bytes=0-(\d+)/.exec(r.headers.range || ''); return m ? Number(m[1]) + 1 : 0 }

async function upload(localPath, { parent, name, existingId }, onProgress, signal) {
  const st = await fsp.stat(localPath)
  const total = st.size
  const meta = { name, modifiedTime: new Date(st.mtimeMs).toISOString() }
  if (!existingId) meta.parents = [parent]
  const init = await req(
    existingId ? url(UP + '/files/' + existingId, { uploadType: 'resumable', fields: FIELDS }) : url(UP + '/files', { uploadType: 'resumable', fields: FIELDS }),
    {
      method: existingId ? 'PATCH' : 'POST', signal,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(total) },
      body: JSON.stringify(meta),
    })
  const session = init.headers.get('location')
  if (!session) throw new Error(t('eNoSession'))

  const fh = await fsp.open(localPath, 'r')
  try {
    let offset = 0, fails = 0
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(total, 1)))
    for (;;) {
      if (signal?.aborted) throw abortError()
      const len = Math.min(CHUNK, total - offset)
      if (len > 0) await fh.read(buf, 0, len, offset)
      let r
      try {
        r = await putChunk(session, buf.subarray(0, len), offset, total, signal, (n) => onProgress(offset + n))
      } catch (e) {
        if (signal?.aborted || e.code === 'CANCELLED') throw abortError()
        if (++fails > 8) throw netError(e)
        await sleep(Math.min(30000, 1500 * fails))
        try { r = await putChunk(session, Buffer.alloc(0), 0, total, signal) } catch { continue }
      }
      if (r.status === 200 || r.status === 201) { onProgress(total); return norm(JSON.parse(r.body)) }
      if (r.status === 308) { offset = nextOffset(r); fails = 0; onProgress(offset); continue }
      if ((r.status >= 500 || r.status === 429) && ++fails <= 8) {
        await sleep(Math.min(30000, 1500 * fails))
        try { const s = await putChunk(session, Buffer.alloc(0), 0, total, signal); if (s.status === 308) offset = nextOffset(s); else if (s.status < 300) return norm(JSON.parse(s.body)) } catch {}
        continue
      }
      throw await apiError(r.status, r.body)
    }
  } finally {
    await fh.close()
  }
}

// ---------- скачивание на компьютер ----------

function exportInfo(file) { return file.gdoc ? EXPORT[file.mime] || null : null }

async function download(file, dest, onProgress, signal) {
  let link
  if (file.gdoc) {
    const ex = exportInfo(file)
    if (!ex) throw new Error(t('eNoExport'))
    link = url(API + '/files/' + file.targetId + '/export', { mimeType: ex.mime })
  } else link = url(API + '/files/' + file.targetId, { alt: 'media' })
  const r = await req(link, { signal })
  const tmp = dest + '.dcpart'
  const out = fs.createWriteStream(tmp)
  let done = 0
  try {
    for await (const chunk of r.body) {
      if (signal?.aborted) throw abortError()
      done += chunk.length
      if (!out.write(chunk)) await once(out, 'drain')
      onProgress(done)
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())))
  } catch (e) {
    out.destroy()
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw signal?.aborted ? abortError() : e
  }
  await fsp.rm(dest, { force: true })
  await fsp.rename(tmp, dest)
  if (file.mtime) await fsp.utimes(dest, new Date(), new Date(file.mtime)).catch(() => {})
}

module.exports = { list, about, findChild, mkdir, rename, trash, move, copy, upload, download, exportInfo, FOLDER }
