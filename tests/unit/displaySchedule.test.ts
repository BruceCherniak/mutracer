import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import Render from '../../src/Render';
import {renderFixture} from '../helpers/renderPipeline';
const table:{cases:{name:string;events:string[];actions:string[]}[]}=JSON.parse(readFileSync(new URL('../fixtures/display-schedule.json',import.meta.url),'utf8'));
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it.each(table.cases)('browser schedule: $name',async(row:{events:string[];actions:string[]})=>{
 const {engine,targets}=renderFixture();const render=new Render(engine,{maxSamples:1});render.refine();
 await render.setDenoiser({type:'jnlm',schedule:'progressive'});
 const state=render as unknown as {_maybeDenoise(force:boolean):void;_inputsChanged():void;_cancelDenoise():void;_deviceLost(v:boolean):void;_denoisedSamples:number;_presentable:boolean;_complete:boolean};
 const actions:string[]=[];let finish:(v:boolean)=>void=()=>{},signal:AbortSignal|undefined;
 vi.mocked(targets[0].performDenoise!).mockImplementation((_f,_a,_s,s)=>{signal=s;actions.push('Filter');return new Promise(resolve=>{finish=resolve;});});
 for(const event of row.events){
  if(event==='start'){state._maybeDenoise(true);await settle();expect(render.denoising).toBe(true);expect(state._presentable).toBe(state._denoisedSamples>0);}
  else if(event==='complete'){const current=!signal?.aborted;finish(true);await settle();actions.push(current&&state._denoisedSamples>0?'Publish':'Discard');if(current)expect(state._presentable).toBe(true);}
  else if(event==='advance'){
   // Advance the real target while retaining its completed filtered output.
   render.maxSamples=2;targets[0].trace(engine.camera!,2);actions.push('Retain');
  }else{
   if(event==='revision')state._inputsChanged();else if(event==='device-lost')state._deviceLost(false);else state._cancelDenoise();
   expect(signal?.aborted).toBe(true);expect(render.denoising).toBe(false);actions.push('Cancel');
  }
 }
 expect(actions).toEqual(row.actions);engine.dispose();
});
