import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.env.MUTRACER_NATIVE_OUTPUT ?? resolve(root, '../.native-build'));
const multiple = process.env.MUTRACER_REFERENCE_SCENES === '1';
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    let directory = output;
    if (multiple) {
      const match = /^\/([a-z0-9-]+)(\/.*)$/.exec(url.pathname);
      if (!match) throw new Error('Use /image/, /textures/, or another verified scene fixture.');
      directory = resolve(output, match[1], 'reference');
      url.pathname = match[2];
    }
    const scene = resolve(directory, 'scene');
    const reference = resolve(directory, 'browser-reference');
    mkdirSync(reference, {recursive: true});
    if (request.method === 'POST' && url.pathname.startsWith('/result/')) {
      const filenames = { '/result/hdr': 'render.rgba32f', '/result/normal': 'normal.rgba32f', '/result/albedo': 'albedo.rgba32f', '/result/info': 'result.json', '/result/error': 'error.txt' };
      const file = filenames[url.pathname]; if (!file) throw new Error('Unknown result');
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new Error('Result too large'); chunks.push(chunk); }
      writeFileSync(resolve(reference, file), Buffer.concat(chunks));
      response.end('saved'); console.log(`Browser reference saved: ${file}`); return;
    }
    if (request.method !== 'GET') throw new Error('Unsupported method');
    let file;
    if (url.pathname.startsWith('/scene/')) {
      file = resolve(scene, decodeURIComponent(url.pathname.slice(7)));
      if (!file.startsWith(scene + sep)) throw new Error('Invalid scene path');
    } else if (url.pathname === '/browser-reference.mjs') file = resolve(root, 'browser-reference.mjs');
    else if (url.pathname === '/') file = resolve(root, 'browser-reference.html');
    else { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', ({'.mjs':'text/javascript','.html':'text/html','.json':'application/json','.wgsl':'text/plain'})[extname(file)] ?? 'application/octet-stream');
    response.end(readFileSync(file));
  } catch (error) { response.writeHead(400); response.end(String(error)); }
});
server.listen(Number(process.env.MUTRACER_REFERENCE_PORT ?? 4178), '127.0.0.1', () => console.log(`Reference page: http://127.0.0.1:${server.address().port}/`));
