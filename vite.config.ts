import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/** Generate an exact, versioned app shell after Vite has emitted hashed assets. */
function offlineAppShell(): Plugin {
  let outputDirectory = ''
  return {
    name: 'mango-fx-offline-shell',
    apply: 'build',
    configResolved(config) { outputDirectory = resolve(config.root, config.build.outDir) },
    async closeBundle() {
      const files: string[] = []
      async function visit(directory: string) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const fullPath = join(directory, entry.name)
          if (entry.isDirectory()) await visit(fullPath)
          else if (entry.isFile()) {
            const path = relative(outputDirectory, fullPath).split(sep).join('/')
            if (['index.html', 'manifest.webmanifest', 'favicon.svg'].includes(path) || path.startsWith('assets/') || path.startsWith('icons/')) files.push(path)
          }
        }
      }
      await visit(outputDirectory)
      files.sort()
      for (const required of ['index.html', 'manifest.webmanifest', 'icons/mango-fx-192.png', 'icons/mango-fx-512.png', 'icons/mango-fx-maskable-512.png']) {
        if (!files.includes(required)) throw new Error(`PWA app shell is missing ${required}`)
      }
      // Worker implementation changes must also use a new cache, so failed
      // installs cannot delete the cache belonging to the still-active worker.
      const hash = createHash('sha256').update(offlineAppShell.toString())
      for (const file of files) { hash.update(file); hash.update(await readFile(join(outputDirectory, file))) }
      const version = hash.digest('hex').slice(0, 20)
      const source = `/* MANGO FX offline shell; generated at build time. */
const VERSION = ${JSON.stringify(version)};
const SCOPE = self.registration.scope;
const CACHE_PREFIX = 'mango-fx-shell:' + new URL(SCOPE).pathname + ':';
const CACHE_NAME = CACHE_PREFIX + VERSION;
const ASSET_URLS = ${JSON.stringify(files)}.map(path => new URL(path, SCOPE).href);
const ASSET_SET = new Set(ASSET_URLS);
const INDEX_URL = new URL('index.html', SCOPE).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // A partial cache must never activate. Keep the previous version if a fetch fails.
    try {
      await cache.addAll(ASSET_URLS.map(url => new Request(url, { cache: 'reload', credentials: 'same-origin' })));
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return;
  if (request.mode === 'navigate') {
    // Keep HTML and its hashed assets on the same version until an update is accepted.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(INDEX_URL) || fetch(request);
    })());
    return;
  }
  if (ASSET_SET.has(url.href)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(request) || fetch(request);
    })());
  }
  // Leave APIs, exports, external resources, and unrelated pages outside this cache.
});
`;
      await writeFile(join(outputDirectory, 'service-worker.js'), source)
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [offlineAppShell()],
})
