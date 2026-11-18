import test from 'node:test';
import assert from 'node:assert/strict';
import { createHongguoIntegration } from '../src/hongguo-integration.js';

test('screen-only playback is observed rather than mistaken for a catalogue', async () => {
  const old=process.env.PHONE_SERIAL; process.env.PHONE_SERIAL='emulator-5554';
  try {
    let n=0; const run=async (_cmd,args)=>{
      const cmd=args.slice(2).join(' ');
      if(cmd==='shell dumpsys activity activities') return {stdout:'mResumedActivity: ActivityRecord{a u0 com.example.hongguo/.Main t1}'};
      if(cmd==='shell dumpsys media_session') return {stdout:'no sessions'};
      if(cmd==='shell uiautomator dump /sdcard/_hongguo_ui.xml') return {stdout:'dumped'};
      if(cmd==='shell cat /sdcard/_hongguo_ui.xml') return {stdout:'<hierarchy></hierarchy>'};
      if(cmd==='exec-out screencap -p') return {stdout:Buffer.from(`frame${++n}`)};
      throw Error('catalogue must not be consulted for verified current playback: '+cmd);
    };
    const app=createHongguoIntegration({enabled:true,serial:'emulator-5554',packageName:'com.example.hongguo',run,now:(()=>{let t=0;return()=>++t})(),wait:async()=>{},recognize:async()=>['重回1977从一把猎枪开始赶山娶老婆 >','第17集','屏幕文字'],screenProgress:async image=>image.toString()==='frame1'?.2:.23});
    const r=await app.tick({permission:true,brain:{complete:async()=>'{"want":true}'}});
    assert.equal(r.status,'verified'); assert.equal(n,2);
  } finally {if(old===undefined) delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=old;}
});
