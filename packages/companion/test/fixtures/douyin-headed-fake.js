import fs from 'node:fs';
import path from 'node:path';
const dir=process.env.DOUYIN_LOGIN_SESSION_DIR;
process.send({type:'display',socket:path.join(dir,'display.sock'),token:'a'.repeat(64)});
if (process.env.FAKE_SUCCESS === '1') setTimeout(()=>{
  fs.writeFileSync(path.join(dir,'cookies.json'),JSON.stringify([{name:'sessionid',value:'synthetic'}]));
  fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'success'}));
  process.exit(0);
},120);
process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(path.join(dir,'late'),'late'); process.exit(0);},120));
setInterval(()=>{},1000);
