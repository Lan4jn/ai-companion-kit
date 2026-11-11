export function createReadingScheduler({want,run,intervalMs=45*60*1000}){
 let running=false,timer=null,stopped=true;
 async function tick(){if(running)return {ok:false,reason:'busy'};running=true;try{if(!await want())return {ok:false,reason:'not-interested'};return await run()}finally{running=false}}
 async function loop(){try{const r=await tick();console.log('[FanqieScheduler]',JSON.stringify(r))}catch(e){console.warn('[FanqieScheduler] 失败:',e.message)}finally{if(!stopped){timer=setTimeout(loop,intervalMs);timer.unref?.()}}}
 return {tick,start(){if(!stopped)return;stopped=false;timer=setTimeout(loop,intervalMs);timer.unref?.()},stop(){stopped=true;clearTimeout(timer)}};
}
