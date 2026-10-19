import {spawnCompiler} from './compiler.mjs';
import {spawnSync} from 'node:child_process';
import {mkdirSync,copyFileSync,cpSync,writeFileSync,renameSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {bundleOIDN} from './viewer-oidn.mjs';
import {summarizeCoverage} from './diagnostics.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??resolve(root,'.native-build/viewer'));
const target=resolve(process.env.CARGO_TARGET_DIR??resolve(out,'cargo-target'));
const compiler=process.env.MUTRACER_SCRIPTC??'scriptc';
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('This experimental viewer currently targets macOS arm64.');
mkdirSync(out,{recursive:true});
const env={...process.env,CARGO_TARGET_DIR:target,MUTRACER_AOT_ARCHIVE:resolve(out,'render-core.lib.a')};
function run(command,args){const r=(command===compiler?spawnCompiler:spawnSync)(command,args,{cwd:root,env,stdio:'inherit'});if(r.error||r.status!==0)throw new Error(`${command} failed: ${r.error?.message??r.status}`);}
const version=spawnCompiler(compiler,['--version'],{encoding:'utf8'});if(version.status!==0||version.stdout.trim()!=='0.3.2')throw new Error('Set MUTRACER_SCRIPTC to scriptc 0.3.2.');
const coverage=spawnCompiler(compiler,['coverage','native/render-core.ts','--print','diagnostics','--fail-on','blockers'],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});
writeFileSync(resolve(out,'coverage.json'),coverage.stdout??'');
if(coverage.nativeMatrixPrecision!==64)throw new Error('Native viewer requires Float64 CPU matrix storage.');
if(coverage.error||!summarizeCoverage(JSON.parse(coverage.stdout),coverage.status).passed)throw new Error('AOT compilation graph failed; see coverage.json.');
run(compiler,['build','--lib','--profile','native/render-core-profile.json','-o',env.MUTRACER_AOT_ARCHIVE]);
run(process.execPath,['native/generate-display.mjs','--check']);
run('cargo',['build','--release','--locked','--manifest-path','native/viewer/Cargo.toml']);
const app=resolve(out,'MuTracer.app'),contents=resolve(app,'Contents');mkdirSync(resolve(contents,'MacOS'),{recursive:true});mkdirSync(resolve(contents,'Resources'),{recursive:true});
const staged=resolve(contents,'MacOS/.mutracer-viewer.build');
copyFileSync(resolve(target,'release/mutracer-viewer'),staged);
renameSync(staged,resolve(contents,'MacOS/mutracer-viewer'));
copyFileSync(resolve(root,'native/viewer/assets/sample.glb'),resolve(contents,'Resources/sample.glb'));
writeFileSync(resolve(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>mutracer-viewer</string>
<key>CFBundleIdentifier</key><string>com.meimu.mutracer.native-viewer</string>
<key>CFBundleName</key><string>MuTracer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>0.0.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
bundleOIDN(out, contents);
// Mirror component notice paths, including shared renderer attribution, in the
// standalone package. OIDN's upstream runtime notices keep their existing folder.
const licenses=resolve(contents,'Resources/licenses');
for(const component of ['', 'native', 'native/viewer']) {
  const destination=resolve(licenses,component);mkdirSync(destination,{recursive:true});
  cpSync(resolve(root,component,'LICENSES'),resolve(destination,'LICENSES'),{recursive:true});
  copyFileSync(resolve(root,component,'THIRD_PARTY_NOTICES.md'),resolve(destination,'THIRD_PARTY_NOTICES.md'));
}
copyFileSync(resolve(root,'LICENSE'),resolve(licenses,'LICENSE'));
run('/usr/bin/codesign',['--force','--sign','-',app]);
console.log(`Native app: ${app}`);
const args=process.argv.slice(2);if(!args.includes('--build-only'))run('/usr/bin/open',['-n',app,...(args.length?['--args',...args.map(a=>resolve(a))]:[])]);
