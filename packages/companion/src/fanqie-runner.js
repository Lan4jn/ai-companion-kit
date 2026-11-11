export function createFanqieRunner({exclusive,navigate,read}) {
 return async()=>{let result;const acquired=await exclusive(async()=>{const nav=await navigate();if(!nav?.ok){result=nav||{ok:false,reason:'navigation-failed'};return;}result=await read(nav);});return acquired?result:{ok:false,reason:'busy'};};
}
