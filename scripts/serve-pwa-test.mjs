// Local-only production fixture server. Never used as a deployment server.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = process.env.MANGO_PWA_TEST_ROOT ? resolve(process.env.MANGO_PWA_TEST_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' }
let revision = 0
createServer(async (request,response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/__test/advance-version' && request.method === 'POST') {
      revision += 1; response.writeHead(200); response.end(String(revision)); return
    }
    let path = decodeURIComponent(url.pathname)
    if (path === '/mango67A') { response.writeHead(301,{Location:'/mango67A/'});response.end();return }
    if (path.startsWith('/mango67A/')) path = path.slice('/mango67A'.length)
    if (path.endsWith('/')) path += 'index.html'
    const file = resolve(root, `.${path}`)
    if (!file.startsWith(root + sep)) { response.writeHead(403);response.end();return }
    if (!(await stat(file)).isFile()) throw new Error('Not a file')
    let data = await readFile(file)
    if (extname(file) === '.js' && file.endsWith('service-worker.js') && revision) data = Buffer.from(data.toString().replace(/const VERSION = "[^"]+";/, `const VERSION = "fixture-update-${revision}";`))
    response.writeHead(200,{'Content-Type':types[extname(file)] || 'application/octet-stream','Cache-Control':'no-store'})
    response.end(data)
  } catch { response.writeHead(404); response.end('Not found') }
}).listen(Number(process.env.MANGO_PWA_TEST_PORT || 4174),'127.0.0.1',()=>console.log('PWA production fixture ready'))
