"""Compare actual software/HWRT guide-open query sequences, pixel by pixel."""
import importlib.util,json,argparse
from pathlib import Path
import numpy as np
spec=importlib.util.spec_from_file_location('hit_consistency',Path(__file__).with_name('hit-consistency.py'))
hc=importlib.util.module_from_spec(spec);spec.loader.exec_module(hc)
EVENT=np.dtype([('hit',hc.HIT),('origin','<f4',(3,)),('flags','<u4'),('direction','<f4',(3,)),('previousRecord','<i4')])
def analyze(directory, geometry=None, points=None):
 p=Path(directory);pair = hc.GeometryPair(p) if points is None and geometry is None and json.loads((p/'hardware/layout.json').read_text()).get('indexed',False) else None;points = points or hc.PackedGeometry(geometry or p/'software').points;sinfo=json.loads((p/'software/info.json').read_text());hinfo=json.loads((p/'hardware/info.json').read_text());assert sinfo['actualBackend']==0 and hinfo['actualBackend']==3
 headers=[np.fromfile(p/side/'headers.bin',dtype='<u4').reshape(-1,16) for side in ['software','hardware']]
 events=[np.fromfile(p/side/'events.bin',dtype=EVENT) for side in ['software','hardware']]
 counts=[a[:,0].astype(np.int64) for a in headers];offsets=[np.r_[0,np.cumsum(c)] for c in counts]
 assert all(offsets[i][-1]==len(events[i]) for i in range(2));assert all(not a[:,1].any() for a in headers)
 n=len(headers[0]);first=np.full(n,-1,dtype=np.int16);codes=np.zeros(n,dtype=np.uint8);unpaired=np.zeros(n,dtype=bool);ray_delta=np.zeros(n);examples=[];steps=[]
 for step in range(int(max(c.max() for c in counts))):
  active=first<0;paired=active&(counts[0]>step)&(counts[1]>step);ids=np.flatnonzero(paired)
  sw,hw=[events[i][offsets[i][ids]+step] for i in range(2)]
  if pair: code,stats=pair.compare(sw['hit'],hw['hit'])
  else:
   distance=np.linalg.norm(points(sw['hit'])-points(hw['hit']),axis=1);code,stats=hc.classify(sw['hit'],hw['hit'],distance)
  steps.append({'query':step,'paired':len(ids),'classification':stats})
  bad=code!=0;which=ids[bad];first[which]=step;codes[which]=code[bad]
  if len(which):
   ray_delta[which]=np.maximum(np.max(np.abs(sw['origin'][bad].astype(float)-hw['origin'][bad].astype(float)),axis=1),np.max(np.abs(sw['direction'][bad].astype(float)-hw['direction'][bad].astype(float)),axis=1))
  # A path that closes its guide sooner cannot be called an equivalent query.
  lone=active&((counts[0]>step)!=(counts[1]>step));first[lone]=step;unpaired[lone]=True
 for pixel in np.flatnonzero((codes==3)|unpaired)[:100]:
  step=int(first[pixel]);row={'pixel':int(pixel),'x':int(pixel%sinfo['width']),'yBottomFirst':int(pixel//sinfo['width']),'query':step,'unpaired':bool(unpaired[pixel]),'rayMaxAbsDelta':float(ray_delta[pixel])}
  for i,side in enumerate(['software','hardware']):
   if counts[i][pixel]>step:
    event=events[i][offsets[i][pixel]+step];row[side]={**{k:event['hit'][k].tolist() for k in ['hit','instance','record','t','bary']},'origin':event['origin'].tolist(),'direction':event['direction'].tolist(),'flags':int(event['flags']),'previousRecord':int(event['previousRecord'])}
  examples.append(row)
 result={'pixels':n,'width':sinfo['width'],'height':sinfo['height'],'samples':1,'actualBackends':[0,3],
  'firstDifferenceCounts':{k:int(np.sum((codes==i)&~unpaired)) for i,k in enumerate(['agree','edge','tie','other'])},
  'unpairedAfterConsistentPrefix':int(unpaired.sum()),'softwareQueries':len(events[0]),'hardwareQueries':len(events[1]),'maxQueriesPerPixel':[int(c.max()) for c in counts],
  'firstDifferenceRayMaxAbsDelta':float(ray_delta.max()),'querySteps':steps,'otherOrUnpairedExamples':examples,
  'pass':bool(not np.any(codes==3) and not unpaired.any()),'interpretation':'First difference uses the plan numerical budget; every preceding same-instance/record query must fit that budget. Unpaired branch divergence is reported separately, never silently accepted.'}
 codes.tofile(p/'first-difference.u8');first.tofile(p/'first-difference-query.i16');(p/'classification.json').write_text(json.dumps(result,indent=2));return result
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directory',type=Path);parser.add_argument('--geometry',type=Path);a=parser.parse_args();r=analyze(a.directory,a.geometry);print(json.dumps(r,indent=2));raise SystemExit(0 if r['pass'] else 1)
