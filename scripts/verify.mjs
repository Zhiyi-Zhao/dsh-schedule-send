/**
 * Static checks for the package manifest, the two runtime entries, the locale
 * metadata, and the browser artifact's self-identification. Runs without
 * dependencies, so CI needs no install step.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let failed = false

/**
 * Report one failed assertion.
 * @param message - what is wrong.
 */
function fail(message) {
  failed = true
  console.error(`FAIL ${message}`)
}

/**
 * Read one UTF-8 file under the package root.
 * @param relative - path relative to the package root.
 * @returns File text.
 */
function read(relative) {
  return readFileSync(join(root, relative), 'utf8')
}

/**
 * Require one file to exist.
 * @param relative - path relative to the package root.
 */
function requireFile(relative) {
  if (!existsSync(join(root, relative))) fail(`missing file: ${relative}`)
}

const manifest = JSON.parse(read('package.json'))
if (manifest.name !== 'dsh-schedule-send') fail(`unexpected package name: ${manifest.name}`)
if (manifest.private === true) fail('package.json must not be private when publishing')
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/.test(manifest.version)) fail('invalid version')
if (manifest.main !== './index.js') fail(`unexpected main: ${manifest.main}`)
if (manifest.exports?.['.'] !== './index.js') fail('exports["."] must be ./index.js')
if (manifest.exports?.['./client'] !== './client.js') fail('exports["./client"] must be ./client.js')
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch must be ./cordis.patch.yml')
if (manifest.dsh?.client?.platform !== 'web') fail('dsh.client.platform must be web')

requireFile('index.js')
requireFile('client.js')
requireFile('cordis.patch.yml')
requireFile('icon.svg')
requireFile('README.md')
requireFile('README.zh.md')
requireFile('LICENSE')

const patch = read('cordis.patch.yml')
if (!patch.includes('name: dsh-schedule-send')) fail('cordis.patch.yml does not mount dsh-schedule-send')
if (!patch.includes('id: dsh-schedule-send')) fail('cordis.patch.yml has no row id')

const host = read('index.js')
for (const marker of ["'schedule-send'", "'schedule-send-cancel'", 'sessionController', 'queue.json']) {
  if (!host.includes(marker)) fail(`index.js is missing ${marker}`)
}

const client = read('client.js')
if (!client.includes("id: 'dsh-schedule-send'")) fail('client.js factory id must equal the package name')
for (const slot of ['conversation.input.right', 'conversation.chat.commandview']) {
  if (!client.includes(slot)) fail(`client.js does not register into ${slot}`)
}
if (!client.includes("require('react')")) fail('client.js must use the shared react module')

for (const locale of ['en', 'zh']) {
  const file = `locale/${locale}.json`
  requireFile(file)
  const dictionary = JSON.parse(read(file))
  if (typeof dictionary.meta?.title !== 'string' || dictionary.meta.title === '') fail(`${file} needs meta.title`)
  if (typeof dictionary.meta?.description !== 'string' || dictionary.meta.description === '') {
    fail(`${file} needs meta.description`)
  }
}

const icon = read('icon.svg')
if (!icon.trimStart().startsWith('<svg')) fail('icon.svg is not an SVG document')

if (failed) process.exit(1)
console.log('verify: ok')
