import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(root, 'dist')
let html = await readFile(resolve(dist, 'index.html'), 'utf8')
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)]
const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)]
if (scripts.length !== 1 || styles.length !== 1) throw new Error('Unexpected Vite output: expected one script and stylesheet')
for (const [tag, src] of scripts) {
  const js = await readFile(resolve(dist, src.replace(/^(?:\.\/|\/)/, '')), 'utf8')
  if (/\bimport\s*(?:\(|[^;]*?\bfrom\s*['"])/.test(js)) throw new Error('Standalone output must not import additional modules')
  html = html.replace(tag, () => `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`)
}
for (const [tag] of styles) {
  const href = tag.match(/href="([^"]+)"/)?.[1]
  if (!href) throw new Error('Missing stylesheet path')
  const css = await readFile(resolve(dist, href.replace(/^(?:\.\/|\/)/, '')), 'utf8')
  html = html.replace(tag, () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
}
html = html.replace(/\s*<link\b[^>]*rel="manifest"[^>]*>/g, '')
const icon = await readFile(resolve(dist, 'favicon.svg'), 'utf8')
html = html.replace(/href="(?:\.\/|\/)?favicon\.svg"/, () => `href="data:image/svg+xml,${encodeURIComponent(icon)}"`)
const output = resolve(dist, 'MANGO-FX.html')
await writeFile(output, html)
console.log(`Standalone application: ${output} (${Math.round(Buffer.byteLength(html) / 1024)} KB)`)
