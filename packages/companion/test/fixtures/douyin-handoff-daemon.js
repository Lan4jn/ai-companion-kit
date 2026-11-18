import {createHeadedDisplay} from '../../src/douyin-headed-display.js';
import {startDaemon} from '../../src/douyin-qr-daemon.js';
const controller=new AbortController();let display;
const stop=()=>controller.abort();process.on('SIGTERM',stop);process.on('disconnect',stop);
try {
 display=await createHeadedDisplay({root:process.env.DOUYIN_LOGIN_SESSION_DIR,ttlMs:90000});
 display.closed.then(stop);process.send({type:'display',socket:display.socket,token:display.token});
 await startDaemon({sessionDir:process.env.DOUYIN_LOGIN_SESSION_DIR,headed:true,displayEnv:display.env,url:process.env.SYNTHETIC_URL,delays:{initial:100,qr:100,poll:100},signal:controller.signal});
} finally {await display?.close();if(process.connected)process.disconnect();}
