"""Unmodified ABI measurement; each invocation owns a fresh process/context."""
import os,argparse,ctypes as c,json,pathlib as p,time,resource,statistics,struct,hashlib,subprocess,datetime
parser=argparse.ArgumentParser();parser.add_argument('directory',type=p.Path);parser.add_argument('key');parser.add_argument('mode',type=int);parser.add_argument('round',type=int);parser.add_argument('--thermal-helper');parser.add_argument('--single',action='store_true');parser.add_argument('--edits',action='store_true');parser.add_argument('--library',required=True);parser.add_argument('--manifest',required=True);a=parser.parse_args();out=a.directory;mode=a.mode
case=next(row for row in json.loads(p.Path(a.manifest).read_text()) if row['key']==a.key)
thermal=[]
if a.thermal_helper:
 while True:
  state=int(subprocess.check_output([a.thermal_helper],text=True))
  thermal.append(dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),state=state))
  if state==0:break
  time.sleep(1)
# Request timestamp capability only for HWRT profiling. Software is an image gate.
gpuProfiling=mode==1 and os.environ.get('MUTRACER_NATIVE_GPU_TIMESTAMPS')=='1'
if mode==0:os.environ.pop('MUTRACER_NATIVE_GPU_TIMESTAMPS',None)
lib=c.CDLL(a.library)
u=c.c_uint32;h=c.c_uint64;n=c.c_size_t;v=c.c_void_p
sigs={'create_with_backend':[u,c.POINTER(h)],'commit':[h,v,n],'render':[h,u],'reset':[h],'read_pixels':[h,u,v,n,c.POINTER(n)],'destroy':[h],'backend':[h,c.POINTER(u),v,n],'update_transform':[h,v,n],'update_geometry':[h,v,n]}
for key,args in sigs.items():getattr(lib,'mt_context_'+key).argtypes=args+[v,n];getattr(lib,'mt_context_'+key).restype=c.c_int32
err=c.create_string_buffer(4096)
def call(key,*args):
 status=getattr(lib,'mt_context_'+key)(*args,err,len(err))
 if status:raise RuntimeError(f'{key}: {err.value.decode()}')
def clock():return time.perf_counter()*1000
def backend():
 active=u();reason=c.create_string_buffer(1024);call('backend',ctx,c.byref(active),reason,len(reason));return dict(active=active.value,reason=reason.value.decode())
def run():
 t=clock()
 for i in range(8):call('render',ctx,8)
 return clock()-t
def measure_edits(raw,ctx):
 def u32(i):return struct.unpack_from('<I',raw,i*4)[0]
 def floats(offset,count):return list(struct.unpack_from('<'+'f'*count,raw,offset*4))
 geometry=max(range(u32(4)),key=lambda i:u32(u32(9)+i*12+1))
 mesh=next(i for i in range(u32(5)) if u32(u32(10)+i*20)==geometry)
 mo=u32(10)+mesh*20;matrix=floats(mo+4,16);changed=matrix.copy();changed[12]+=0.0001
 transform=struct.pack('<IIII16f',1,mesh,0,0,*changed);restoreTransform=struct.pack('<IIII16f',1,mesh,0,0,*matrix)
 go=u32(9)+geometry*12;count=u32(go);positions=floats(u32(go+2),count*3);normal=floats(u32(go+4),count*3) if u32(go+4) else []
 tangent=floats(u32(go+8),count*4) if u32(0)>=2 and u32(go+8) else [];flags=bool(normal)|(bool(tangent)<<1)
 original=struct.pack('<IIII',1,geometry,count,flags)+struct.pack('<'+'f'*(len(positions)+len(normal)+len(tangent)),*(positions+normal+tangent))
 positions[(count//2)*3]+=0.0001
 edit=struct.pack('<IIII',1,geometry,count,flags)+struct.pack('<'+'f'*(len(positions)+len(normal)+len(tangent)),*(positions+normal+tangent))
 records={}
 for kind,data,restore in [('transform',transform,restoreTransform),('geometry',edit,original)]:
  records[kind]=[]
  for i in range(12):
   t=clock()
   try:call('update_'+kind,ctx,data,len(data))
   except RuntimeError as e:
    records[kind].append(dict(iteration=i,error=str(e)));break
   elapsed=clock()-t;records[kind].append(dict(iteration=i,ms=elapsed));assert backend()==initialBackend
   call('update_'+kind,ctx,restore,len(restore))
 return dict(geometry=geometry,mesh=mesh,edits=records)

ctx=h();raw=p.Path(case['input']).read_bytes();assert hashlib.sha256(raw).hexdigest()==case['sha256'];t=clock();call('create_with_backend',mode,c.byref(ctx));deviceMs=clock()-t
folder=out/('single' if a.single else 'baseline')/(f'{a.round}-{a.key}-native-{mode}');folder.mkdir(parents=True,exist_ok=True)
try:
 t=clock();call('commit',ctx,raw,len(raw));initialCommit=clock()-t;initialBackend=backend()
 assert (mode!=0 or initialBackend['active']==0)
 if mode!=0:
  expected=case['expectedHardware'];assert initialBackend==expected,(expected,initialBackend)
 if a.edits:
  row=dict(key=a.key,requested=mode,round=a.round,thermal=thermal,backend=initialBackend,**measure_edits(raw,ctx))
  folder=out/'edit-baseline'/f'{a.round}-{a.key}-native-{mode}';folder.mkdir(parents=True,exist_ok=True)
  (folder/'info.json').write_text(json.dumps(row,indent=2));print(json.dumps(row),flush=True)
  raise SystemExit(0)
 commits=[]
 for i in range(12 if not a.single else 0):
  t=clock();call('commit',ctx,raw,len(raw));elapsed=clock()-t
  actual=backend();assert actual==initialBackend,(initialBackend,actual)
  commits.append(dict(iteration=i,ms=elapsed,backend=actual))
 # Formal wall-clock data has no timestamp queries; profiling follows the
 # durable image/info write so a diagnostic failure cannot lose a valid group.
 if gpuProfiling:os.environ.pop('MUTRACER_NATIVE_GPU_TIMESTAMPS')
 firstMs=run();warm=[]
 if mode==0:firstMs=None
 for i in range(6 if mode==1 and not a.single else 0):
  call('reset',ctx);warm.append(run())
 gpuProfileRuns=[]
 counts=None
 images={}
 for k,kind in enumerate(['hdr','normal','albedo']):
  length=n();call('read_pixels',ctx,k,None,0,c.byref(length));buf=c.create_string_buffer(length.value);call('read_pixels',ctx,k,buf,len(buf),c.byref(length));(folder/(kind+'.bin')).write_bytes(buf.raw);images[kind]=hashlib.sha256(buf.raw).hexdigest()
 row=dict(key=a.key,requested=mode,round=a.round,thermal=thermal,discardRender=1,discardCommit=2,backend=initialBackend,deviceMs=deviceMs,initialCommitMs=initialCommit,commits=commits,firstMs=firstMs,warm=warm,gpuProfileRuns=gpuProfileRuns,steadyGpuTimestamps=False,counts=list(counts) if counts is not None else None,images=images,peakProcessRssBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,renderMsMedian=statistics.median(warm[1:]) if warm else None)
 (folder/'info.json').write_text(json.dumps(row,indent=2));print(json.dumps(row),flush=True)
 if gpuProfiling and not a.single:
  os.environ['MUTRACER_NATIVE_GPU_TIMESTAMPS']='1'
  for i in range(2):
   try:
    call('reset',ctx);gpuProfileRuns.append(dict(ms=run()))
   except RuntimeError as e:gpuProfileRuns.append(dict(error=str(e)))
  (folder/'profile.json').write_text(json.dumps(gpuProfileRuns,indent=2))
finally:call('destroy',ctx)
