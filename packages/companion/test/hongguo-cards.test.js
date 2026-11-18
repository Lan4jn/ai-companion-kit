import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHongguoCards } from '../src/hongguo-cards.js';
const card=(title,bounds='[515,194][951,930]')=>`<node class="android.view.View" clickable="true" enabled="true" bounds="${bounds}"><node class="android.view.View" clickable="false" enabled="true" bounds="${bounds}"><node class="android.widget.TextView" text="${title}" bounds="[536,821][930,859]"/><node class="android.view.View" clickable="true" bounds="[536,872][752,910]"><node class="android.widget.TextView" text="AI剧热播榜 No.3" bounds="[544,876][719,906]"/></node></node></node>`;
const xml=s=>`<hierarchy rotation="1"><node class="androidx.compose.ui.platform.ComposeView" bounds="[21,194][1899,993]">${s}</node></hierarchy>`;
test('从无资源ID的Compose卡片提取标题、说明和真实点击范围',()=>{
 assert.deepEqual(extractHongguoCards(xml(card('持械入宋：第一季'))),[{title:'持械入宋：第一季',description:'AI剧热播榜 No.3',bounds:'[515,194][951,930]'}]);
});
test('拒绝不完整、模糊重复、登录墙',()=>{
 assert.deepEqual(extractHongguoCards(xml(card('同一剧')+card('同一剧'))),[]);
 assert.deepEqual(extractHongguoCards(xml(card('请先登录'))),[]);
 assert.deepEqual(extractHongguoCards('<hierarchy>'),[]);
});
