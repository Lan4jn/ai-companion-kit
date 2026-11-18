import {register} from 'node:module';
import {OneBot} from '../src/transport-onebot.js';
register('./memory-brain-fake-ws-loader.js', import.meta.url);
export async function tiebaMessage({userId=1, type='private', groupId, text='你玩过星露谷物语吗', id=123}={}) {
 let resolve; const got = new Promise(r => {resolve=r});
 const bot = new OneBot({wsUrl:'ws://fixture',onMessage:resolve});
 bot.api=async()=>({ok:false}); bot.getMyGroupCard=async()=>'';
 while (!bot.ws) await new Promise(r=>setTimeout(r,1));
 bot.ws.emit('open');
 bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:type,user_id:userId,group_id:groupId,message_id:id,message:[{type:'text',data:{text}}]}));
 const msg=await got; bot.close(); return msg;
}
