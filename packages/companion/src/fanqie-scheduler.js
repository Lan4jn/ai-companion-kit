export function createReadingScheduler({want,run,intervalMs=45*60*1000}){
 let running=false,timer=null,stopped=true,generation=0,closed=false,inFlight=null;
 function tick(scheduledGeneration){
  if(closed)return Promise.resolve({ok:false,reason:'stopped'});
  if(running)return Promise.resolve({ok:false,reason:'busy'});
  running=true;
  const task=(async()=>{try{if(!await want())return {ok:false,reason:'not-interested'};if(closed || (scheduledGeneration!==undefined && (stopped || generation!==scheduledGeneration)))return {ok:false,reason:'stopped'};return await run()}finally{running=false}})();
  inFlight=task;
  task.then(()=>{if(inFlight===task)inFlight=null},()=>{if(inFlight===task)inFlight=null});
  return task;
 }
 async function loop(){const current=generation;try{const r=await tick(current);const reasons=['busy','not-interested','no-candidates','selection-unavailable','screen-changed','open-failed','reader-unverified','other-app-active','navigation-failed','reader-changed','no-content','progress-unverified','content-unavailable','text-change-unverified','reading-unavailable','understanding-unavailable','turn-unverified','device-offline','chapter-changed','integration-error','step-limit'];const status=r?.ok===true?'success':reasons.includes(r?.reason)?r.reason:'failed';console.log('[FanqieScheduler]',status)}catch{console.warn('[FanqieScheduler]','error')}finally{if(!stopped && current===generation){timer=setTimeout(loop,intervalMs);timer.unref?.()}}}
 return {tick,start(){if(!stopped)return;closed=false;stopped=false;generation++;timer=setTimeout(loop,intervalMs);timer.unref?.()},stop(){closed=true;stopped=true;generation++;clearTimeout(timer);return inFlight ? inFlight.then(()=>{},()=>{}) : Promise.resolve()}};
}
