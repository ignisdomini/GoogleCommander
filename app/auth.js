// Вход в аккаунт Google: OAuth 2.0 для настольных приложений (loopback 127.0.0.1 + PKCE).
// Окно входа Google открывается в браузере по умолчанию, пароль программа не видит.
const http = require('node:http')
const crypto = require('node:crypto')
const { shell } = require('electron')
const config = require('./config')
const { t } = require('./i18n')

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const SCOPE = 'https://www.googleapis.com/auth/drive'

let pending = null      // идущий вход: { cancel }
let refreshing = null   // общий промис обновления токена

const b64url = (buf) => buf.toString('base64url')

function client() {
  return { id: config.get('clientId', ''), secret: config.getSecret('clientSecret') || '' }
}
const hasClient = () => !!client().id

function tokens() {
  try { return JSON.parse(config.getSecret('tokens') || 'null') } catch { return null }
}
function storeTokens(t) {
  const old = tokens() || {}
  const next = {
    access: t.access_token,
    refresh: t.refresh_token || old.refresh,
    expiry: Date.now() + (Number(t.expires_in) || 3600) * 1000,
  }
  config.setSecret('tokens', JSON.stringify(next))
  return next
}
const isLoggedIn = () => !!tokens()?.refresh

async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const e = new Error(j.error_description || j.error || t('eServer', { s: r.status }))
    e.code = j.error
    throw e
  }
  return j
}

function page(title, text) {
  return `<!doctype html><meta charset="utf-8"><title>Google Commander</title>
<body style="margin:0;background:#0000aa;color:#55ffff;font:20px Consolas,monospace;display:grid;place-items:center;height:100vh">
<div style="border:6px double #55ffff;padding:32px 48px;text-align:center;max-width:640px">
<div style="background:#00aaaa;color:#000;padding:2px 12px;margin:-46px auto 24px;width:max-content">Google Commander</div>
<div style="color:#fff;font-size:24px;margin-bottom:16px">${title}</div><div>${text}</div></div></body>`
}

async function login() {
  const { id, secret } = client()
  if (!id) { const e = new Error(t('eNoClient')); e.code = 'NO_CLIENT'; throw e }
  cancel()

  const verifier = b64url(crypto.randomBytes(48))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  const state = b64url(crypto.randomBytes(16))
  const server = http.createServer()
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res) })
  const redirect = `http://127.0.0.1:${server.address().port}`

  let code
  try {
    code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t('eLoginTimeout'))), 5 * 60 * 1000)
      pending = { cancel: () => { clearTimeout(timer); const e = new Error(t('eLoginCancelled')); e.code = 'CANCELLED'; reject(e) } }
      server.on('request', (req, res) => {
        const u = new URL(req.url, redirect)
        if (u.pathname !== '/') { res.writeHead(404); res.end(); return }
        const got = u.searchParams.get('code')
        const ok = got && u.searchParams.get('state') === state
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ok
          ? page(t('pageOkTitle'), t('pageOkText'))
          : page(t('pageFailTitle'), t('pageFailText')))
        clearTimeout(timer)
        if (ok) resolve(got)
        else { const e = new Error(u.searchParams.get('error') === 'access_denied' ? t('eDenied') : t('eLoginFailed')); e.code = 'DENIED'; reject(e) }
      })
      const url = AUTH_URL + '?' + new URLSearchParams({
        client_id: id, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
        code_challenge: challenge, code_challenge_method: 'S256', state,
        access_type: 'offline', prompt: 'consent select_account',
      })
      shell.openExternal(url)
    })
  } finally {
    pending = null
    server.closeAllConnections?.()
    server.close()
  }

  const t = await tokenRequest({
    code, client_id: id, client_secret: secret, redirect_uri: redirect,
    grant_type: 'authorization_code', code_verifier: verifier,
  })
  if (!t.refresh_token && !tokens()?.refresh) throw new Error(t('eNoRefresh'))
  storeTokens(t)
}

function cancel() { pending?.cancel() }

async function getToken(force = false) {
  const t = tokens()
  if (!t?.refresh) { const e = new Error(t('eNotLogged')); e.code = 'AUTH'; throw e }
  if (!force && t.access && t.expiry - 60_000 > Date.now()) return t.access
  if (!refreshing) {
    const { id, secret } = client()
    refreshing = tokenRequest({ client_id: id, client_secret: secret, refresh_token: t.refresh, grant_type: 'refresh_token' })
      .then((j) => storeTokens(j).access)
      .catch((e) => {
        if (e.code === 'invalid_grant' || e.code === 'invalid_client' || e.code === 'unauthorized_client') {
          config.setSecret('tokens', null)
          const x = new Error(t('eExpired')); x.code = 'AUTH'; throw x
        }
        throw e
      })
      .finally(() => { refreshing = null })
  }
  return refreshing
}

async function logout() {
  const t = tokens()
  config.setSecret('tokens', null)
  if (t?.refresh) {
    try { await fetch(REVOKE_URL + '?' + new URLSearchParams({ token: t.refresh }), { method: 'POST' }) } catch {}
  }
}

module.exports = { login, cancel, logout, getToken, isLoggedIn, hasClient, client }
