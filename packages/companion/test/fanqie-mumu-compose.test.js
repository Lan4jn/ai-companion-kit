import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractReliableCandidates} from '../src/fanqie-device-navigation.js';
const pkg='com.dragon.read';
function fixture(){
 const root={id:'com.dragon.read:id/f9y',className:'androidx.compose.ui.platform.ComposeView'};
 const wrapper={parent:root};
 const card={parent:wrapper,className:'android.view.View',clickable:true,enabled:true,packageName:pkg,bounds:'[20,800][530,1720]'};
 const text=(v,b)=>({parent:card,className:'android.widget.TextView',packageName:pkg,enabled:true,text:v,bounds:b});
 const nodes=[{text:'书城'},card,text('8.7分','[39,1535][90,1559]'),text('虚构小说名','[39,1587][399,1622]'),text('这是虚构测试书籍的简介，主人公踏上旅途并探索群山之中的古老秘密。','[39,1629][515,1697]')];
 return nodes;
}
test('Compose book card requires same parent, valid bounds and score',()=>{
 const n=fixture();assert.deepEqual(extractReliableCandidates(n).map(c=>[c.title,c.x,c.y]),[['虚构小说名',219,1605]]);
 for(const mutate of [n=>n[4].parent={}, n=>n[4].bounds='[0,0][0,0]', n=>n[2].text='人气榜', n=>n[1].clickable=false, n=>n[3].packageName='other',n=>n.push({text:'隐私协议'}),n=>n[1].parent.parent.id='other:id/f9y']) {const x=fixture();mutate(x);assert.deepEqual(extractReliableCandidates(x),[]);}
});
