"""First path divergence must not be hidden by an earlier accepted difference."""
import importlib.util,json,tempfile,unittest
from pathlib import Path
import numpy as np
spec=importlib.util.spec_from_file_location('path_consistency',Path(__file__).with_name('path-consistency.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class PathConsistency(unittest.TestCase):
    def test_first_difference_and_unpaired_queries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for side,backend,counts in [('software',0,[3,2,2]),('hardware',1,[3,2,1])]:
                folder=root/side;folder.mkdir()
                header=np.zeros((3,16),dtype='<u4');header[:,0]=counts;header[:,2]=backend;header.tofile(folder/'headers.bin')
                events=np.zeros(sum(counts),dtype=m.EVENT);events['hit']['hit']=1;events['hit']['instance']=7;events['hit']['record']=20;events['hit']['t']=2;events['hit']['bary']=[.2,.3,.5]
                if side=='hardware':
                    events['hit']['record'][1]=21 # allowed tie at query 1
                    events['hit']['t'][2]=20 # later error must not replace the first tie
                    events['hit']['bary'][4]=[.3,.3,.4] # same-record over-budget error
                events.tofile(folder/'events.bin')
                (folder/'info.json').write_text(json.dumps({'actualBackend':backend,'width':3,'height':1}))
            result=m.analyze(root,points=lambda hits:hits['bary'][:,1:])
            self.assertEqual(result['firstDifferenceCounts'],{'agree':0,'edge':0,'tie':1,'other':1})
            self.assertEqual(result['unpairedAfterConsistentPrefix'],1)
            self.assertFalse(result['pass'])
            self.assertEqual(np.fromfile(root/'first-difference-query.i16',dtype='<i2').tolist(),[1,1,1])
if __name__=='__main__':unittest.main()
