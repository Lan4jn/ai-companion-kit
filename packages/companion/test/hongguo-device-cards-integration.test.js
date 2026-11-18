import test from 'node:test';
import assert from 'node:assert/strict';
import { createHongguoDeviceDriver } from '../src/hongguo-device-driver.js';
const xml = '<hierarchy><node class="androidx.compose.ui.platform.ComposeView"><node class="android.view.View" clickable="true" enabled="true" bounds="[10,20][210,320]"><node><node class="android.widget.TextView" text="真实剧名" bounds="[20,30][150,70]" /></node></node></node></hierarchy>';
test('device reads observed cards and only taps a freshly matching card', async () => {
 let taps=0;
 const run=async (_cmd,args)=>{const a=args.slice(2).join(' ');if(a==='shell dumpsys activity activities')return {stdout:'mResumedActivity: ActivityRecord{a u0 com.example.drama/.Main t1}'};if(a==='shell uiautomator dump /sdcard/_hongguo_ui.xml')return {stdout:'ok'};if(a==='shell cat /sdcard/_hongguo_ui.xml')return {stdout:xml};if(a.startsWith('shell input tap ')){taps++;return {stdout:''};}throw Error(a)};
 const driver=createHongguoDeviceDriver({serial:'phone1',packageName:'com.example.drama',run});
 const snap=await driver.observeCards();assert.equal(snap.cards[0].title,'真实剧名');
 assert.equal(await driver.tapCard(snap.cards[0]),true);assert.equal(taps,1);
 assert.equal(await driver.tapCard({...snap.cards[0],title:'其他剧名'}),false);assert.equal(taps,1);
});

test('failed hierarchy dump cannot reuse stale catalogue for a tap', async () => {
 let taps=0;
 const run=async (_cmd,args)=>{const a=args.slice(2).join(' ');if(a==='shell dumpsys activity activities')return {stdout:'mResumedActivity: ActivityRecord{a u0 com.example.drama/.Main t1}'};if(a==='shell uiautomator dump /sdcard/_hongguo_ui.xml')return {stdout:'',stderr:'ERROR: could not get idle state.'};if(a==='shell cat /sdcard/_hongguo_ui.xml')return {stdout:xml};if(a.startsWith('shell input tap ')){taps++;return {stdout:''}};throw Error(a)};
 const driver=createHongguoDeviceDriver({serial:'phone1',packageName:'com.example.drama',run});
 const snapshot=await driver.observeCards();
 assert.equal(snapshot.blocked,true);assert.equal(snapshot.cards.length,0);assert.equal(taps,0);
});
