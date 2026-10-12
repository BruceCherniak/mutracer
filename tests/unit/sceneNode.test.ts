import {expect,it} from 'vitest';
import Camera from '../../src/scene/Camera';
import {mat4} from '../../src/math';
it('writes translation without changing orientation or scale',()=>{
 const node=new Camera({projection: 'perspective'});mat4.fromScaling(node.transform,[2,3,4]);const previous=Array.from(node.transform);
 node.position=[5,6,7];expect(node.position).toEqual([5,6,7]);expect(Array.from(node.transform.slice(0,12))).toEqual(previous.slice(0,12));expect(node.transform[15]).toBe(previous[15]);
 const copy=node.position;copy[0]=10;expect(node.position[0]).toBe(5);
});
it('points local -Z at a target, preserving translation and scale',()=>{
 const node=new Camera({projection: 'perspective'});mat4.fromScaling(node.transform,[2,3,4]);node.position=[1,2,3];
 expect(node.lookAt([4,6,3])).toBe(node);expect(node.position).toEqual([1,2,3]);
 const m=node.transform;expect(-m[8]/4).toBeCloseTo(.6);expect(-m[9]/4).toBeCloseTo(.8);expect(-m[10]/4).toBeCloseTo(0);
 for(let i=0;i<3;i++)expect(Math.hypot(m[i*4],m[i*4+1],m[i*4+2])).toBeCloseTo(i+2);
});

it('keeps a valid basis when the target direction is parallel to default up',()=>{
 const node=new Camera({projection: 'perspective'});node.position=[0,4,0];node.lookAt([0,0,0]);
 for(let i=0;i<3;i++)expect(Math.hypot(...Array.from(node.transform.slice(i*4,i*4+3)))).toBeCloseTo(1);
 expect(-node.transform[9]).toBeCloseTo(-1);
});
