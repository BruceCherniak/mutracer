import { build } from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, basename } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
if (!args.includes('--output') || !args.includes('--manifest') || !args.includes('--library'))
    throw Error('Usage: node native/benchmark/benchmark.mjs --output DIRECTORY --manifest INPUTS.json --library LIBRARY [--port 4201]');
const rounds = args.includes('--rounds') ? Number(option('--rounds')) : 1;
if (![1, 3].includes(rounds)) throw Error('Rounds must be 1 or 3');
const dir = resolve(option('--output')), manifest = resolve(option('--manifest')), librarySource = resolve(option('--library'));
if (dir === root || dir.startsWith(root + '/'))
    throw Error('Benchmark evidence must be outside the repository');
const cases = JSON.parse(readFileSync(manifest));
mkdirSync(dir, { recursive: true });
const thermalHelper = process.platform === 'darwin' ? resolve(dir, 'thermal-state') : null;
if (thermalHelper) execFileSync('xcrun', ['swiftc', resolve(root, 'native/benchmark/thermal.swift'), '-o', thermalHelper]);
const thermalReadings = async () => {
    const readings = [];
    if (!thermalHelper) return { state: null, readings, unavailable: 'ProcessInfo thermalState requires macOS' };
    let state;
    do {
        state = Number(execFileSync(thermalHelper, { encoding: 'utf8' }).trim());
        if (!Number.isInteger(state) || state < 0 || state > 3) throw Error('Invalid ProcessInfo thermalState');
        readings.push({ at: new Date().toISOString(), state });
        if (state !== 0) await new Promise(resolve => setTimeout(resolve, 1000));
    } while (state !== 0);
    return { state, readings };
};
const library = resolve(dir, basename(librarySource));
if (library !== librarySource) copyFileSync(librarySource, library);
const nativeClient = resolve(dir, 'native-client.py');
copyFileSync(resolve(root, 'native/benchmark/benchmark-native.py'), nativeClient);
writeFileSync(resolve(dir,'source.diff'),execFileSync('git',['diff','HEAD'],{cwd:root}));
for (const row of cases) {
    if (!/^[a-zA-Z0-9_-]+$/.test(row.key))
        throw Error('Invalid case key');
    row.input = resolve(dirname(manifest), row.input);
    if (createHash('sha256').update(readFileSync(row.input)).digest('hex') !== row.sha256)
        throw Error('Input checksum mismatch: ' + row.key);
}
const configuredManifest = resolve(dir, 'inputs.json');
copyFileSync(fileURLToPath(import.meta.url),resolve(dir,'server-source.mjs'));
writeFileSync(configuredManifest, JSON.stringify(cases, null, 2));
writeFileSync(resolve(dir, 'run.json'), JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), node: process.version, library, librarySha256: createHash('sha256').update(readFileSync(library)).digest('hex'), sourceDirty: execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='', gpuTimestamps: 'hardware-only', manifest, rounds, commitIterations: 12, commitDiscard: 2, renderIterations: {web: 6, hardware: 6, software: 1}, renderDiscard: 1, profileIterations: 2, samples: 64, seed: 12345, batch: 8, webWorkers: 8 }, null, 2));
const modules = ['scene/Geometry', 'scene/Mesh', 'scene/OpenPBRMaterial', 'scene/Texture', 'scene/Camera', 'scene/RectLight', 'scene/SphereLight', 'scene/DirectionalLight', 'scene/SpotLight', 'renderer/WGPURayTracePass', 'scene/EnvironmentLight', 'scene/InstancedMesh', 'scene/IESProfile'];
let reference = readFileSync(root + '/native/scene-reference.mjs', 'utf8');
reference = reference.replace(/^import .*from 'node:[^']+';\n/gm, '').replace(/^import .*capture-device.*\n/m, '').replace(/^const materialProperties =.*$/m, 'const materialProperties = ' + readFileSync(root + '/native/material-properties.json', 'utf8') + ';');
const begin = reference.indexOf('    installWebGPUConstants();');
if (begin < 0 || !reference.includes("const load = path => import(pathToFileURL(resolve(sourceRoot, 'src', path)).href);"))
    throw Error('Descriptor oracle structure changed; update benchmark adapter');
reference = reference.slice(0, begin) + `    if(u[20])lights.push(new Environment({map:textures[u[20]-1]}));const flags=u[22];return{scene:{meshes,lights,background:flags&4?undefined:u[21]?textures[u[21]-1]:Array.from(f.slice(16,20))},camera,flags,width:u[2],height:u[3]};}\n`;
reference = modules.map((p, i) => `import * as m${i} from '@core/${p}.ts';`).join('\n') + '\n' + reference.replace("const load = path => import(pathToFileURL(resolve(sourceRoot, 'src', path)).href);", 'const load = path => Promise.resolve({' + modules.map((p, i) => JSON.stringify(p + '.js') + ':m' + i).join(',') + '}[path]);');
const plugin = { name: 'core', setup(b) { b.onResolve({ filter: /^@core\// }, a => ({ path: resolve(root, 'src', a.path.slice(6)) })); b.onResolve({ filter: /^@reference$/ }, () => ({ path: 'reference', namespace: 'generated' })); b.onLoad({ filter: /.*/, namespace: 'generated' }, () => ({ contents: reference, loader: 'js', resolveDir: root + '/native' })); } };
const main = await build({ entryPoints: [resolve(root, 'native/benchmark/benchmark-browser.mjs')], bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [plugin], nodePaths: [root + '/node_modules'] });
writeFileSync(dir + '/browser.js', main.outputFiles[0].contents);
const worker = await build({ entryPoints: [root + '/src/renderer/bvh.worker.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', nodePaths: [root + '/node_modules'] });
writeFileSync(dir + '/worker.js', worker.outputFiles[0].contents);
writeFileSync(resolve(dir,'harness-sha256.json'),JSON.stringify(Object.fromEntries(['browser.js','worker.js','native-client.py'].map(name=>[name,createHash('sha256').update(readFileSync(resolve(dir,name))).digest('hex')])),null,2));
import { spawn } from 'node:child_process';
createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/config') {
            res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({rounds})); return;
        }
        if (url.pathname === '/thermal') {
            res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(await thermalReadings())); return;
        }
        if (url.pathname === '/cases') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(cases));
            return;
        }
        if (url.pathname === '/native' && req.method === 'POST') {
            const parts = [];
            for await (const c of req)
                parts.push(c);
            const job = JSON.parse(Buffer.concat(parts));
            if (!cases.some(c => c.key === job.key) || ![0, 1].includes(job.mode) || ![0, 1, 2].includes(job.round))
                throw Error('Invalid job');
            const log = dir + `/${job.edits ? 'edits-' : ''}native-${job.round}-${job.key}-${job.mode}.log`;
            const child = spawn('python3', [nativeClient, dir, job.key, String(job.mode), String(job.round), '--library', library, '--manifest', configuredManifest, ...(thermalHelper ? ['--thermal-helper', thermalHelper] : []), ...(job.edits ? ['--edits'] : [])], { env: { ...process.env, MUTRACER_NATIVE_PROFILE: '1', MUTRACER_NATIVE_GPU_TIMESTAMPS: job.mode === 1 ? '1' : '0' } });
            const logs = [];
            child.stdout.on('data', c => logs.push(c));
            child.stderr.on('data', c => logs.push(c));
            child.on('close', code => { writeFileSync(log, Buffer.concat(logs)); res.writeHead(code === 0 ? 200 : 500); res.end(JSON.stringify({ code, log })); });
            return;
        }
        if (req.method === 'POST' && url.pathname.startsWith('/save/')) {
            const path = url.pathname.slice(6);
            if (!/^[a-zA-Z0-9/_.-]+$/.test(path) || path.includes('..'))
                throw Error('Invalid path');
            const parts = [];
            for await (const c of req)
                parts.push(c);
            const target = resolve(dir, 'baseline', path);
            mkdirSync(resolve(target, '..'), { recursive: true });
            writeFileSync(target, Buffer.concat(parts));
            res.end('saved');
            return;
        }
        if (url.pathname.startsWith('/input/')) {
            const key = url.pathname.split('/').at(-1);
            if (!cases.some(c => c.key === key))
                throw Error('Unknown case');
            res.end(readFileSync(cases.find(c => c.key === key).input));
            return;
        }
        if (url.pathname.endsWith('.wasm')) {
            res.setHeader('content-type', 'application/wasm');
            res.end(readFileSync(root + '/src/tinybvh/tinybvh.wasm'));
            return;
        }
        if (url.pathname.endsWith('.js') || url.pathname.endsWith('bvh.worker.ts')) {
            res.setHeader('content-type', 'text/javascript');
            res.end(readFileSync(dir + (url.pathname.includes('bvh.worker') ? '/worker.js' : '/browser.js')));
            return;
        }
        res.setHeader('content-type', 'text/html');
        res.end('<pre>Starting descriptor benchmark</pre><canvas></canvas><script type="module" src="/browser.js"></script>');
    }
    catch (e) {
        res.statusCode = 500;
        res.end(String(e.stack ?? e));
    }
}).listen(Number(args.includes('--port') ? option('--port') : 4201), '127.0.0.1', () => console.log('Benchmark: http://127.0.0.1:' + (args.includes('--port') ? option('--port') : 4201)));
