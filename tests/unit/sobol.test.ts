import { expect, it } from 'vitest';
import { sobol2D, owen, zIndex, morton2 } from './sobolReference';
import { zSobolLog2SPP, samplingPatternCode } from '../../src/renderer/sampling';
function net(points: number[][], k: number) {
  // Coordinate bounds are independent of the elementary-interval partition.
  expect(points.find(([x, y]) => !(x >= 0 && x < 1 && y >= 0 && y < 1))).toBeUndefined();
  for (let a = 0; a <= k; a++) {
    const counts = new Uint16Array(2**k);
    for (const [x,y] of points) {
      counts[Math.floor(x*2**a) + Math.floor(y*2**(k-a))*2**a]++;
    }
    expect(Array.from(counts)).toEqual(Array(2**k).fill(1));
  }
}
it('preserves every elementary interval in progressive scrambled 2D nets', () => {
  for (const s of [0,1,12345,0xffffffff]) for (let k = 0; k <= 10; k++)
    net(Array.from({length: 2**k}, (_, i) => sobol2D(i,s)), k);
  expect(sobol2D(0,1)).not.toEqual(sobol2D(0,2));
});
it('Owen is bijective and preserves nested prefixes', () => {
  const values = Array.from({length: 4096}, (_,i)=>owen(i,77));
  expect(new Set(values).size).toBe(values.length);
  expect(new Set(values.map(v=>v >>> 12)).size).toBe(1);
});
it('ZSobol is a bijection for odd and even spp and each pixel has a 2D net', () => {
  for (let k=0;k<=7;k++) for (const dim of [0,1,9,0x80000001]) {
    const indices: number[] = [];
    for (let y=0;y<4;y++) for (let x=0;x<4;x++) {
      const pixelIndices = Array.from({length:2**k},(_,i)=>zIndex((morton2(x,y,2)<<k)|i,dim,k,2));
      indices.push(...pixelIndices);
      net(pixelIndices.map(i=>sobol2D(i,123)),k);
    }
    expect(new Set(indices).size).toBe(16*2**k);
    expect(Math.max(...indices)).toBeLessThan(16*2**k);
  }
});
it('handles the full 32-bit index, sample budget and invalid patterns', () => {
  expect(zIndex(0xffffffff, 0,16)).toBeGreaterThanOrEqual(0);
  expect(zSobolLog2SPP(17)).toBe(5); expect(zSobolLog2SPP(Infinity)).toBe(16);
  expect(zSobolLog2SPP(2**20)).toBe(16);
  expect(()=>samplingPatternCode('invalid' as any)).toThrow();
});

it('packs all ZSobol permutations without changing any digit mapping', async () => {
  const { zSobolPackedPermutations, zSobolPermutations } = await import('../../src/renderer/sampling');
  for (let p = 0; p < 24; p++) {
    const unpacked = zSobolPackedPermutations[p >>> 2] >>> (8 * (p & 3)) & 255;
    expect(unpacked).toBe(zSobolPermutations[p]);
    expect(new Set(Array.from({length:4}, (_,d) => unpacked >>> (2*d) & 3)).size).toBe(4);
  }
});

it('blue-noise-first keeps sample zero independent of the planned budget without duplicating sample one', async () => {
  const {referenceSample} = await import('./sobolReference');
  for (const seed of [0,11,0xffffffff]) for (const [px,py] of [[0,0],[255,256],[512,91]]) {
    const first = referenceSample('zsobol',px,py,1024,0,14,0,seed);
    for (const log of [0,1,4,16]) {
      expect(referenceSample('zsobol',px,py,1024,0,14,log,seed)).toEqual(first);
      expect(referenceSample('zsobol',px,py,1024,1,14,log,seed)).not.toEqual(first);
    }
  }
  expect(()=>samplingPatternCode('zsobol-first' as any)).toThrow();
});

it('variable traversal uses per-pixel Sobol regardless of the structured pattern', async () => {
  const {referenceSample} = await import('./sobolReference');
  for (const i of [0,1,17,65536]) {
    const args = [256,9,1024,i] as const;
    for (const pattern of ['sobol','zsobol'] as const) {
      expect(referenceSample(pattern,...args,0x80001234,8,12,true)).toEqual(referenceSample('sobol',...args,0x80001234,8,12));
    }
  }
});

it('the five-step Sobol butterfly equals the direction recurrence for every binary basis vector', async () => {
  const {sobolD1Steps} = await import('../../src/renderer/sampling');
  const {reverse} = await import('./sobolReference');
  const naive = (index: number) => {
    let r=0,v=0x80000000;
    for (;index;index>>>=1,v^=v>>>1) if(index&1)r^=v;
    return r>>>0;
  };
  const inputs = [0,0xffffffff,...Array.from({length:32},(_,i)=>(1<<i)>>>0),
    ...Array.from({length:4096},(_,i)=>Math.imul(i,0x9e3779b9)>>>0)];
  for(const i of inputs){
    let r=reverse(i);
    for(const [shift,mask]of sobolD1Steps)r^=(r<<shift)&mask;
    expect(r>>>0).toBe(naive(i));
  }
});
