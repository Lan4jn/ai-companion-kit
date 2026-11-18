const {chromium}=require('playwright-core');
const assert=require('assert');
(async()=>{const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-background-networking','--disable-extensions']});
try{const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});const page=await context.newPage();page.on('pageerror',e=>console.error('PAGE',e));
await page.goto(process.env.SYNTH_URL);await page.waitForFunction(()=>document.querySelector('#status').textContent==='ready',null,{timeout:20000});
await page.waitForFunction(()=>{const d=document.querySelector('canvas').getContext('2d').getImageData(300,300,1,1).data;return d[0]===255&&d[1]===0&&d[2]===0},null,{timeout:20000});
const token=new URL(process.env.SYNTH_URL).hash.slice(1);
const replay=()=>page.evaluate(token=>new Promise((resolve,reject)=>{const s=new WebSocket(`ws://${location.host}/relay`);let got=false;s.onopen=()=>s.send(token);s.onmessage=()=>{got=true};s.onclose=()=>resolve(got);setTimeout(()=>{s.close();reject(Error('replay timeout'))},3000)}),token);
assert.deepStrictEqual(await Promise.all([replay(),replay()]),[false,false]);
const box=await page.locator('canvas').boundingBox();const tx=x=>box.x+box.width*x/1024, ty=y=>box.y+box.height*y/768;
await page.mouse.click(tx(50),ty(80));
await new Promise(resolve=>setTimeout(resolve,500));
await page.locator('#keyboard').click();
await page.keyboard.type('abc');
const pixel=async rgb=>page.waitForFunction(rgb=>{const d=document.querySelector('canvas').getContext('2d').getImageData(20,175,1,1).data;return rgb.every((x,i)=>d[i]===x)},rgb,{timeout:5000});
await pixel([1,2,3]);await page.keyboard.press('Backspace');await pixel([4,5,6]);
await page.locator('#keyboard-input').evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));});
await page.waitForTimeout(300);assert.match(await page.locator('#input-status').textContent(),/输入未发送/);await pixel([4,5,6]);
// Exercise both common IME ordering variants: no unsupported text may leak through.
for(const order of ['before','after']){
  await page.locator('#keyboard-input').evaluate((el,order)=>{
    const event=()=>el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'中文',isComposing:order==='before'}));
    el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    if(order==='before')event();
    el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
    if(order==='after')event();
  },order);
  await page.waitForTimeout(150);await pixel([4,5,6]);
}
await page.locator('#keyboard-input').evaluate(el=>{el.value='<img src=x onerror=alert(1)>';el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:el.value}));});
await pixel([10,11,12]);
const x=tx(300), y=ty(300);
if(process.env.SYNTH_MODE==='touch') await page.touchscreen.tap(x,y); else await page.mouse.click(x,y);
await page.waitForFunction(()=>{const d=document.querySelector('canvas').getContext('2d').getImageData(400,400,1,1).data;return d[0]===0&&d[1]===255&&d[2]===0},null,{timeout:10000});
await new Promise(resolve=>setTimeout(resolve,1200));
console.log('PASS');await context.close();
}catch(e){console.error(e);process.exitCode=1}finally{await browser.close()}})();
