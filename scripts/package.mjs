// Сборка dist/GoogleCommander (папка программы), переносного архива и установщика Inno Setup.
// Запуск: npm run icon && npm run package
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createPackageWithOptions } from '@electron/asar'
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'
import { createRequire } from 'node:module'
const _rc = createRequire(import.meta.url)('rcedit')
const rcedit = _rc.rcedit || _rc.default || _rc

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const dist = join(root, 'dist')
const appDir = join(dist, 'GoogleCommander')
const stage = join(dist, '.app')
const EXE = 'GoogleCommander.exe'
// Inno Setup: переменная ISCC или стандартная папка установки
const ISCC = process.env.ISCC || 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe'
const step = (s) => console.log(`\n▸ ${s}`)

if (!existsSync(join(root, 'resources', 'icon.ico'))) throw new Error('нет resources/icon.ico — выполните npm run icon')

step('чистая папка dist/GoogleCommander')
rmSync(appDir, { recursive: true, force: true })
rmSync(stage, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
cpSync(join(root, 'node_modules', 'electron', 'dist'), appDir, { recursive: true })
renameSync(join(appDir, 'electron.exe'), join(appDir, EXE))
rmSync(join(appDir, 'resources', 'default_app.asar'), { force: true })
for (const f of readdirSync(join(appDir, 'locales'))) if (!['ru.pak', 'en-US.pak'].includes(f)) rmSync(join(appDir, 'locales', f))

step('app.asar')
cpSync(join(root, 'app'), join(stage, 'app'), { recursive: true })
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version, description: pkg.description, main: pkg.main, author: pkg.author }, null, 2))
await createPackageWithOptions(stage, join(appDir, 'resources', 'app.asar'), {})
rmSync(stage, { recursive: true, force: true })

step('значок и сведения о версии')
const retry = async (fn, times = 6) => {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= times) throw e
      console.log(`  повтор ${i} через ${i * 3} с: ${String(e.stderr || e.message).trim()}`)
      await new Promise((r) => setTimeout(r, i * 3000))
    }
  }
}
await retry(() => rcedit(join(appDir, EXE), {
  icon: join(root, 'resources', 'icon.ico'),
  'file-version': version, 'product-version': version,
  'version-string': {
    ProductName: 'Google Commander', FileDescription: 'Google Commander - two-panel file manager for Google Drive',
    CompanyName: 'Google Commander', LegalCopyright: '© 2026 MIT License', OriginalFilename: EXE, InternalName: 'GoogleCommander',
  },
}))

step('фьюзы Electron')
await flipFuses(join(appDir, EXE), {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
})

step('переносная версия')
const zip = join(dist, `GoogleCommander-${version}-portable.zip`)
rmSync(zip, { force: true })
execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', dist, 'GoogleCommander'], { stdio: 'inherit' })
console.log(`  ${zip} — ${(statSync(zip).size / 1e6).toFixed(0)} МБ`)

if (existsSync(ISCC)) {
  step('установщик Inno Setup')
  await retry(async () => {
    try { execFileSync(ISCC, ['/Qp', `/DAppVersion=${version}`, join(root, 'installer', 'google-commander.iss')], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) {
      const lines = String(e.stdout || '').split('\n').filter((l) => /error|ошиб/i.test(l)).slice(-3)
      throw new Error('ISCC: ' + (lines.join(' | ') || e.message))
    }
  }, 4)
  const setup = join(dist, `GoogleCommander-${version}-setup.exe`)
  if (existsSync(setup)) console.log(`\n✓ ${setup} — ${(statSync(setup).size / 1e6).toFixed(0)} МБ`)
} else console.log('\n(Inno Setup не найден — установщик не собран)')
