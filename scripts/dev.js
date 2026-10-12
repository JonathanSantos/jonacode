// Dev server: recompiles `src` on change (tsc --watch) and serves the repo on http://localhost:5173
import { spawn } from 'node:child_process'
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const port = Number(process.env.PORT) || 5173
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json',
  '.ts': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

if (!process.argv.includes('--no-watch')) {
  spawn('npx', ['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], { cwd: root, stdio: 'inherit' })
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/') {
    res.writeHead(302, { location: '/examples/' })
    return res.end()
  }
  let file = normalize(join(root, decodeURIComponent(url.pathname)))
  if (!file.startsWith(root)) return res.writeHead(403).end()
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html')
    statSync(file)
  } catch {
    return res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  createReadStream(file).pipe(res)
}).listen(port, () => console.log(`\n  Jonacode playground → http://localhost:${port}/examples/\n`))
