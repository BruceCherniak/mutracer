"""Behavior checks for the first-hit comparison contract."""
import importlib.util
from pathlib import Path
import unittest
import tempfile,json
import numpy as np
spec = importlib.util.spec_from_file_location('hit_consistency', Path(__file__).with_name('hit-consistency.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class HitConsistency(unittest.TestCase):
    def classify(self, a, b, world_distance=None):
        if world_distance is None:
            world_distance = np.linalg.norm((a['bary']-b['bary'])[:,1:],axis=1)
        return m.classify(a,b,world_distance)

    def pair(self):
        a = np.zeros(1, dtype=m.HIT)
        a['hit'], a['instance'], a['record'], a['t'], a['bary'] = 1, 7, 20, 2., [.2, .3, .5]
        return a, a.copy()
    def test_world_points_include_vertex_offset_stride_and_affine_transform(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)
            (folder/'layout.json').write_text(json.dumps({'attributeStrideBytes':32,'positionOffsetBytes':16,'isEmpty':False}))
            np.array([[0,1,2,0]],dtype='<u4').tofile(folder/'native-1.bin')
            ins=np.zeros((1,40),dtype='<u4');ins[0,1]=3
            matrix=np.array([[0,-2,0,4],[3,0,0,5],[0,0,.5,6],[0,0,0,1]],dtype='<f4')
            ins[0,20:36]=matrix.T.ravel().view('<u4');ins.tofile(folder/'native-2.bin')
            attributes=np.zeros((6,8),dtype='<f4');attributes[3:6,4:7]=[[0,0,0],[1,0,0],[0,1,0]];attributes.tofile(folder/'native-3.bin')
            hit=np.zeros(1,dtype=m.HIT);hit['hit']=1;hit['bary']=[.2,.3,.5]
            np.testing.assert_allclose(m.PackedGeometry(folder).points(hit),[[3,5.9,6]],rtol=1e-7)

    def test_categories_and_edge_priority(self):
        a, b = self.pair()
        self.assertEqual(self.classify(a, b)[0].tolist(), [0])
        b['record'] = 21
        self.assertEqual(self.classify(a, b)[0].tolist(), [2])
        b['t'] = 3
        self.assertEqual(self.classify(a, b)[0].tolist(), [3])
        a['bary'] = [.0009, .4, .5991]
        self.assertEqual(self.classify(a, b)[0].tolist(), [1])
    def test_miss_cannot_supply_zero_barycentric_edge(self):
        a, b = self.pair()
        b['hit'], b['bary'], b['t'] = 0, 0, 9999
        self.assertEqual(self.classify(a, b)[0].tolist(), [3])
        a['bary'] = [0., .4, .6]
        self.assertEqual(self.classify(a, b)[0].tolist(), [1])
        a['hit'] = 0
        self.assertEqual(self.classify(a, b)[0].tolist(), [0])
    def test_invalid_data_never_passes_as_tie_or_edge(self):
        a, b = self.pair()
        b['bary'] = [float('nan'), 0., 1.]
        self.assertEqual(self.classify(a, b)[0].tolist(), [3])
    def test_same_primitive_budget_and_distinct_triangle_tie(self):
        a, b = self.pair()
        b['t'] = 2.00019
        self.assertEqual(self.classify(a, b)[0].tolist(), [0])
        b['t'] = 2.00021
        self.assertEqual(self.classify(a, b)[0].tolist(), [3])
        # A near-edge same-primitive over-budget hit is still other.
        a['bary'] = b['bary'] = [0., .4, .6]
        self.assertEqual(self.classify(a, b)[0].tolist(), [3])
        a, b = self.pair()
        b['bary'] = [.2003, .3, .4997]
        self.assertEqual(self.classify(a, b)[0].tolist(), [3])
        # Large barycentric error on a small triangle is not a world-space error.
        b['bary'] = [.22, .3, .48]
        self.assertEqual(self.classify(a,b,[5.3e-6])[0].tolist(),[0])
        self.assertEqual(self.classify(a,b,[.0003])[0].tolist(),[3])
        b['bary'] = [.2000001, .3, .4999999]
        self.assertEqual(self.classify(a, b)[0].tolist(), [0])
        self.assertEqual(self.classify(a, b)[1]['sameIdentityNumericDifferences'], 1)
        b['record'] = 21
        b['t'] = 2.000019
        self.assertEqual(self.classify(a, b)[0].tolist(), [2])
        b['t'] = 2.000021
        self.assertEqual(self.classify(a, b)[0].tolist(), [3])

if __name__ == '__main__':
    unittest.main()
