const { contextBridge, ipcRenderer, webUtils } = require('electron')

const call = (ch) => async (...a) => {
  const r = await ipcRenderer.invoke(ch, ...a)
  if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e }
  return r.value
}
const chans = [
  'app:init', 'app:saveState', 'app:setLang', 'app:quit', 'app:fullscreen', 'app:clipboard', 'app:paste', 'app:openUrl',
  'auth:status', 'auth:setClient', 'auth:importClient', 'auth:login', 'auth:cancel', 'auth:logout',
  'fs:drives', 'fs:list', 'fs:space', 'fs:mkdir', 'fs:rename', 'fs:trash', 'fs:open', 'fs:edit', 'fs:head', 'fs:exists', 'fs:shell', 'fs:explorer',
  'gd:about', 'gd:list', 'gd:mkdir', 'gd:rename', 'gd:trash',
  'xfer:start', 'xfer:answer', 'xfer:cancel',
]
const api = {}
for (const c of chans) {
  const [ns, fn] = c.split(':')
  ;(api[ns] ||= {})[fn] = call(c)
}
api.onXfer = (cb) => ipcRenderer.on('xfer:event', (_e, m) => cb(m))
api.pathForFile = (f) => webUtils.getPathForFile(f)

contextBridge.exposeInMainWorld('dcBridge', api)
