import {prepareTinyBvh} from '../../scripts/fetch-tinybvh.mjs';
import {spawnCompiler} from './compiler.mjs';
import {spawnSync} from 'node:child_process';
import {mkdirSync,copyFileSync,cpSync,writeFileSync,renameSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {summarizeCoverage} from '../validation/diagnostics.mjs';
import {archiveName,executable,nativeToolchainEnv,viewerPlatform} from './platform.mjs';
import {prepareDxc} from './fetch-dxc.mjs';
import {bundleWindowsRuntime} from './windows-redist.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??resolve(root,'.native-build/viewer'));
const target=resolve(process.env.CARGO_TARGET_DIR??resolve(out,'cargo-target'));
const compiler=process.env.MUTRACER_SCRIPTC??'scriptc';
const platform=viewerPlatform(),mac=platform==='macos-arm64';
mkdirSync(out,{recursive:true});
// native:ci passes the archive it already built.
const prebuilt=process.env.MUTRACER_AOT_PREBUILT;
const env={...nativeToolchainEnv(),CARGO_TARGET_DIR:target,MUTRACER_AOT_ARCHIVE:resolve(prebuilt??resolve(out,archiveName('render-core')))};
function run(command,args){const r=(command===compiler?spawnCompiler:spawnSync)(command,args,{cwd:root,env,stdio:'inherit'});if(r.error||r.status!==0)throw new Error(`${command} failed: ${r.error?.message??r.status}`);}
const version=spawnCompiler(compiler,['--version'],{encoding:'utf8'});if(version.status!==0||version.stdout.trim()!=='0.4.4')throw new Error('Set MUTRACER_SCRIPTC to scriptc 0.4.4.');
const coverage=spawnCompiler(compiler,['coverage','native/src/render-core.ts','--print','diagnostics','--fail-on','blockers'],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});
writeFileSync(resolve(out,'coverage.json'),coverage.stdout??'');
if(coverage.nativeMatrixPrecision!==64)throw new Error('Native viewer requires Float64 CPU matrix storage.');
if(coverage.error||!summarizeCoverage(JSON.parse(coverage.stdout),coverage.status).passed)throw new Error('AOT compilation graph failed; see coverage.json.');
if(!prebuilt)run(compiler,['build','--lib','--profile','native/src/render-core-profile.json','-o',env.MUTRACER_AOT_ARCHIVE]);
run(process.execPath,['native/scripts/generate-display.mjs','--check']);
await prepareTinyBvh();
run('cargo',['build','--release','--locked','--manifest-path','native/viewer/Cargo.toml',...(process.env.MUTRACER_VIEWER_DLSS==='1'?['--features','dlss-rr']:[])]);
const app=resolve(out,mac?'MuTracer.app':'MuTracer'),contents=mac?resolve(app,'Contents'):app;
const bin=mac?resolve(contents,'MacOS'):contents,resources=mac?resolve(contents,'Resources'):contents;
mkdirSync(bin,{recursive:true});mkdirSync(resources,{recursive:true});
// Optional NGX components are staged only by dlss-build after this build. A
// regular build into a previously used directory must not retain those DLLs
// after replacing their license directory or produce a misleading launcher.
for(const name of ['mutracer_ngx.dll','nvngx_dlssd.dll','MuTracer-DLSS.cmd','dlss-build.json'])
  rmSync(resolve(bin,name),{force:true});
const staged=resolve(bin,'.mutracer-viewer.build');
copyFileSync(resolve(target,'release',executable('mutracer-viewer')),staged);
renameSync(staged,resolve(bin,executable('mutracer-viewer')));
copyFileSync(resolve(root,'native/viewer/assets/sample.glb'),resolve(resources,'sample.glb'));
if(mac) {
  // ic08 carries the existing 256px PNG without another image tool or dependency.
  const png=readFileSync(resolve(root,'site/src/assets/mutracer-logo.png'));
  if(png.readUInt32BE(16)!==256||png.readUInt32BE(20)!==256)throw new Error('App icon requires the shared 256px logo.');
  const header=Buffer.alloc(16);header.write('icns');header.writeUInt32BE(png.length+16,4);
  header.write('ic08',8);header.writeUInt32BE(png.length+8,12);
  writeFileSync(resolve(resources,'MuTracer.icns'),Buffer.concat([header,png]));
  writeFileSync(resolve(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>mutracer-viewer</string>
<key>CFBundleIdentifier</key><string>com.meimu.mutracer.native-viewer</string>
<key>CFBundleName</key><string>MuTracer</string>
<key>CFBundleIconFile</key><string>MuTracer.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>0.0.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
}
// Discard obsolete SDK files when rebuilding into an older app directory.
if(mac)rmSync(resolve(contents,'Frameworks'),{recursive:true,force:true});
else for(const name of readdirSync(contents))if(/^(?:lib)?OpenImageDenoise|^tbb|^libtbb/.test(name))rmSync(resolve(contents,name),{force:true});
// Mirror component notice paths, including shared renderer attribution, in the
// standalone package.
const licenses=resolve(resources,'licenses');
rmSync(licenses,{recursive:true,force:true});
for(const component of ['', 'native', 'native/viewer']) {
  const destination=resolve(licenses,component);mkdirSync(destination,{recursive:true});
  cpSync(resolve(root,component,'LICENSES'),resolve(destination,'LICENSES'),{recursive:true});
  copyFileSync(resolve(root,component,'THIRD_PARTY_NOTICES.md'),resolve(destination,'THIRD_PARTY_NOTICES.md'));
}
copyFileSync(resolve(root,'LICENSE'),resolve(licenses,'LICENSE'));
if(process.platform==='win32') {
  bundleWindowsRuntime(bin,licenses);
  const dxc=prepareDxc(),notices=resolve(licenses,'DXC');mkdirSync(notices,{recursive:true});
  for(const name of ['dxcompiler.dll','dxil.dll'])copyFileSync(resolve(dxc,'bin/x64',name),resolve(bin,name));
  for(const name of ['LICENSE-LLVM.txt','LICENSE-MS.txt','LICENSE-MIT.txt'])copyFileSync(resolve(dxc,name),resolve(notices,name));
}
if(mac)run('/usr/bin/codesign',['--force','--sign','-',app]);
console.log(`Native app: ${app}`);
const args=process.argv.slice(2);if(!args.includes('--build-only')) {
  if(mac)run('/usr/bin/open',['-n',app,...(args.length?['--args',...args.map(a=>resolve(a))]:[])]);
  else run(resolve(bin,executable('mutracer-viewer')),args);
}
