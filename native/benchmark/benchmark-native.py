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
# Keep profiling JSON in stderr now that library diagnostics are opt-in.
LogCallback=c.CFUNCTYPE(None,c.c_void_p,c.c_void_p,c.c_size_t)
@LogCallback
def native_log(_user,message,length):os.write(2,c.string_at(message,length)+b'\n')
if hasattr(lib,'mt_set_log_callback'):
 lib.mt_set_log_callback.argtypes=[LogCallback,c.c_void_p]
 assert lib.mt_set_log_callback(native_log,None)==0

u=c.c_uint32;h=c.c_uint64;n=c.c_size_t;v=c.c_void_p
sigs={'create_with_backend':[u,c.POINTER(h)],'commit':[h,v,n],'render':[h,u],'reset':[h],'read_pixels':[h,u,v,n,c.POINTER(n)],'destroy':[h],'backend':[h,c.POINTER(u),v,n],'info':[h,v]}
for key,args in sigs.items():getattr(lib,'mt_context_'+key).argtypes=args+[v,n];getattr(lib,'mt_context_'+key).restype=c.c_int32
err=c.create_string_buffer(4096)
def call(key,*args):
 status=getattr(lib,'mt_context_'+key)(*args,err,len(err))
 if status:raise RuntimeError(f'{key}: {err.value.decode()}')
def clock():return time.perf_counter()*1000
def backend():
 active=u();reason=c.create_string_buffer(1024);call('backend',ctx,c.byref(active),reason,len(reason));return dict(active=active.value,reason=reason.value.decode())
class Snapshot(c.Structure):_fields_=[('struct_size',u),('width',u),('height',u),('samples',u),('state',u),('last_commit',u)]
def last_commit():
 info=Snapshot(struct_size=c.sizeof(Snapshot));call('info',ctx,c.byref(info));return info.last_commit
def run():
 t=clock()
 for i in range(8):call('render',ctx,8)
 return clock()-t
def measure_edits(raw,ctx):
 # Each edit commits a descriptor that differs from the committed one in one value.
 def u32(i):return struct.unpack_from('<I',raw,i*4)[0]
 geometry=max(range(u32(4)),key=lambda i:u32(u32(9)+i*12+1))
 mesh=next(i for i in range(u32(5)) if u32(u32(10)+i*20)==geometry)
 offsets={'transform':u32(10)+mesh*20+4+12,'geometry':u32(u32(9)+geometry*12+2)+(u32(u32(9)+geometry*12)//2)*3}
 records={}
 for kind,word in offsets.items():
  original=struct.unpack_from('<f',raw,word*4)[0];edited=bytearray(raw);struct.pack_into('<f',edited,word*4,original+0.0001);edited=bytes(edited)
  records[kind]=[]
  for i in range(12):
   t=clock()
   try:call('commit',ctx,edited,len(edited))
   except RuntimeError as e:
    records[kind].append(dict(iteration=i,error=str(e)));break
   elapsed=clock()-t;records[kind].append(dict(iteration=i,ms=elapsed,incremental=last_commit()==2));assert backend()==initialBackend
   call('commit',ctx,raw,len(raw))
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
