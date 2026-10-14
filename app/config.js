// Настройки программы: userData/config.json. Токены Google хранятся зашифрованными (safeStorage = DPAPI Windows).
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

let file = null
let data = {}

function load() {
  file = path.join(app.getPath('userData'), 'config.json')
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { data = {} }
}

function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

const get = (k, def) => (k in data ? data[k] : def)
function set(k, v) { if (v === undefined) delete data[k]; else data[k] = v; save() }

function getSecret(k) {
  const v = data[k]
  if (!v) return null
  try {
    if (v.enc) return safeStorage.decryptString(Buffer.from(v.enc, 'base64'))
    return v.plain ?? null
  } catch { return null }
}

function setSecret(k, value) {
  if (value == null) return set(k, undefined)
  if (safeStorage.isEncryptionAvailable()) set(k, { enc: safeStorage.encryptString(value).toString('base64') })
  else set(k, { plain: value })
}

module.exports = { load, get, set, getSecret, setSecret }
