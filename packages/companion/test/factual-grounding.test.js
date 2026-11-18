import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';

test('serious current question searches before answering and reports unavailable search honestly', async t => {
 const calls=[];
 t.mock.method(globalThis,'fetch',async (url,opts)=>{ calls.push(String(url)); if(String(url).includes('chat/completions')) return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'瞎编答案'}}]})}; throw Error('offline'); });
 const brain=new Brain({apiKey:'unused',baseUrl:'https://model.invalid',model:'test',dataDir:process.env.TMPDIR});
 brain.search = async (_name,{query}) => { calls.push('/search?'+query); return {success:false}; };
 const result=await brain.reply({key:'private:42',userId:'42',text:'影之刃零最新发售时间是什么？',record:false});
 assert.ok(calls.some(x=>x.includes('/search?')));
 assert.ok(calls.some(x=>x.includes('chat/completions')),'检索失败后仍要走模型，不再返回固定兜底话术');
 assert.doesNotMatch(String(result.text||''),/无法安全查证|没查到可靠资料，我无法查证/);
});


test('only current standalone question is searched and snippets are labelled', async t => {
 let payload, query;
 t.mock.method(globalThis,'fetch',async (_url,opts)=>{payload=JSON.parse(opts.body);return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'来源尚未确认'}}]})}});
 const brain=new Brain({apiKey:'unused',baseUrl:'https://model.invalid',model:'test',dataDir:process.env.TMPDIR});
 brain.search=async (_name,args)=>{query=args.query;return {success:true,text:'相关摘要 https://example.com/a'}};
 await brain.reply({key:'group:1',userId:'42',text:'群友：影之刃零最新发售时间是什么？',factualSearchText:'影之刃零最新发售时间是什么？',history:[{text:'PRIVATE_SECRET'}],record:false});
 assert.equal(query,'影之刃零最新发售时间是什么？'); assert.match(JSON.stringify(payload.messages),/非已核实事实/);
});

test('casual chat is not searched; sensitive and disabled paths fail closed', async t => {
let k=0;
t.mock.method(globalThis,'fetch',async ()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'聊天'+(++k)}}]})}));
const brain=new Brain({apiKey:'unused',baseUrl:'https://model.invalid',model:'test',dataDir:process.env.TMPDIR});
let n=0; brain.search=async()=>{n++;return {success:true,text:'https://example.com'}};
assert.match((await brain.reply({key:'private:42',userId:'42',text:'今天吃什么呀',record:false})).text,/^聊天/);
for(const input of [{text:'我的病历显示药物剂量是多少？'},{text:'最新游戏发售时间是什么？',tools:false},{text:'最新游戏发售时间是什么？',factualSearchText:''}]) {
  const out=await brain.reply({key:'private:42',userId:'42',record:false,...input});
  assert.match(String(out.text||''),/^聊天/, '不能安全检索时应交回模型，而不是固定话术');
  assert.doesNotMatch(String(out.text||''),/无法安全查证/);
}
assert.equal(n,0);
});

test('quoted text never becomes the searched question', async t => {
 let searched=false, chats=0;
 t.mock.method(globalThis,'fetch',async ()=>{chats++;return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'在啊，咋了'+chats}}]})}});
 const brain=new Brain({apiKey:'unused',baseUrl:'https://model.invalid',model:'test',dataDir:process.env.TMPDIR});
 brain.search=async()=>{searched=true;return {success:true,text:'https://example.com'}};
 const out=await brain.reply({key:'group:1',userId:'42',text:'【引用 群友：现在最新iPhone多少钱？】在吗',factualSearchText:'在吗',currentTurnText:'在吗',record:false});
 assert.equal(searched,false,'引用里的问题不能被当成本轮提问去检索');
 assert.ok(chats>0,'应正常调用模型回答');
 assert.match(String(out.text||''),/^在啊/);
});

test('model search cannot exfiltrate history in a generated query', async t => {
 let n=0, calls=0;
 t.mock.method(globalThis,'fetch',async ()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:++calls===1?{tool_calls:[{id:'x',type:'function',function:{name:'web_search',arguments:JSON.stringify({query:'PRIVATE_SECRET'})}}]}:{content:'不知道'}}]})}));
 const brain=new Brain({apiKey:'unused',baseUrl:'https://model.invalid',model:'test',dataDir:process.env.TMPDIR}); brain.search=async()=>{n++;throw Error('must not run')};
 await brain.reply({key:'private:42',userId:'42',text:'你好',history:[{text:'PRIVATE_SECRET'}],record:false}); assert.equal(n,0);
});
