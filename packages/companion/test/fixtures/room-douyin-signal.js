import { startVirtualRoomServer } from '../../src/virtual-room.js';
import { setupProductionFanqie } from '../../src/index.js';
let release;
const room = startVirtualRoomServer({host:'127.0.0.1',port:0,dataDir:process.env.FIXTURE_DIR,douyinLiving:{browseDouyinLive(){process.send({event:'started'}); return new Promise((resolve,reject)=>{release=()=>process.env.MODE === 'reject' ? reject(new Error('synthetic failure')) : resolve();});}}});
setupProductionFanqie({cfg:{},start:()=>null,shutdownTimeoutMs:400,stopOthers:()=>[room.stop()],drain:async()=>process.send({event:'drained'})});
process.on('message', msg=>{if(msg==='release') release?.();});
const {port} = await room.ready;
process.send({event:'ready',port});
