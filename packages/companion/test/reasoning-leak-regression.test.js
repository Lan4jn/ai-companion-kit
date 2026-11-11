import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAllToolArtifacts } from '../src/safety.js';
test('拦截无标签草稿而不是发出去',()=>{
 for (const s of ['月月查好感度。之前说过62、74。 这次随便报个数值，气鼓鼓的。 极简。 回：“翻了下 68”','猫的薛定谔纯表情包。斗图就甩表情包或者短接。前面刚骂他记不住账。气鼓鼓。就回个表情包。 end','回应“这是你的福分”，气鼓鼓傲娇，短促吐槽。回一句怼回去']) assert.equal(cleanAllToolArtifacts(s),'');
});
test('正常聊天和讨论思维链不被误伤',()=>{for(const s of ['我有点气鼓鼓的','思维链是什么？','好感度是多少？','我来回复你']) assert.equal(cleanAllToolArtifacts(s),s)});
