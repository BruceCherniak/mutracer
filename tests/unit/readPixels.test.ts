import {expect, it, vi} from 'vitest';
import {readRgbaPixels} from '../../src/renderer/WebGLReadback';
it.each([true,false])('returns float32 top-first rows from byte or float targets (bytes=%s)', bytes => {
 const source=bytes?[255,0,0,255,0,128,255,255]:[2,0,0,1,0,.5,4,1];
 const gl={RGBA:1,FLOAT:2,UNSIGNED_BYTE:3,readPixels:vi.fn((_x,_y,_w,_h,_fmt,_type,data)=>data.set(source))};
 const data=readRgbaPixels(gl as unknown as WebGL2RenderingContext,1,2,bytes);
 const scale=bytes?255:1;expect([...data]).toEqual([0,source[5]/scale,source[6]/scale,1,source[0]/scale,0,0,1].map(x=>Math.fround(x)));
});
