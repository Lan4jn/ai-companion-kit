import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSocialAction, decideSocialAction } from '../src/hongguo-social.js';

test('verifies a like only with a same-target state transition', () => {
  const result = assessSocialAction({ action: 'like', target: { contentId: 'episode-1' }, before: { contentId: 'episode-1', capturedAt: 1, liked: false }, after: { contentId: 'episode-1', capturedAt: 2, liked: true } });
  assert.equal(result.verified, true);
});

test("defaults to watching when no genuine interest is expressed", () => {
  assert.deepEqual(decideSocialAction({}), { action: "skip", reason: "no-interest" });
});

test("permits an independently chosen comment only with interest, consent and privacy approval", () => {
  assert.deepEqual(decideSocialAction({consent: true, interest: "剧情反转", choice: {action: "comment", text: "这个反转真意外"}, ownerIds: ["123456"]}), {action: "comment", text: "这个反转真意外"});
  assert.equal(decideSocialAction({interest: "剧情", choice: {action: "comment", text: "好看"}, ownerIds: []}).action, "skip");
  assert.equal(decideSocialAction({consent: true, choice: {action: "comment", text: "好看"}, ownerIds: []}).action, "skip");
  assert.equal(decideSocialAction({consent: true, interest: "剧情", choice: {action: "comment", text: "QQ 123456"}, ownerIds: ["123456"]}).action, "skip");
});

test("verifies a newly visible exact comment on the intended content", () => {
  const input = { action: "comment", target: {contentId: "ep"}, text: "好看", before: {contentId: "ep", capturedAt: 1, commentIds: []}, after: {contentId: "ep", capturedAt: 2, comment: {id: "c1", text: "好看", authorIsSelf: true}} };
  assert.equal(assessSocialAction(input).verified, true);
  assert.equal(assessSocialAction({...input, before: {...input.before, commentIds: ["c1"]}}).verified, false);
});

test("reply evidence must identify the intended parent comment", () => {
  const input = {action: "reply", target: {contentId: "ep", commentId: "parent"}, text: "是啊", before: {contentId: "ep", capturedAt: 1, commentIds: []}, after: {contentId: "ep", capturedAt: 2, comment: {id: "r1", parentId: "parent", text: "是啊", authorIsSelf: true}}};
  assert.equal(assessSocialAction(input).verified, true);
  assert.equal(assessSocialAction({...input, target: {contentId: "ep", commentId: "other"}}).verified, false);
});

test("rejects absent, stale, wrong-target or unchanged like evidence", () => {
 const base = {action: "like", target: {contentId: "ep"}, before: {contentId: "ep", capturedAt: 1, liked: false}, after: {contentId: "ep", capturedAt: 2, liked: true}};
 for (const changes of [{after: null}, {after: {...base.after, capturedAt: 1}}, {after: {...base.after, contentId: "other"}}, {before: {...base.before, liked: true}}]) assert.equal(assessSocialAction({...base, ...changes}).verified, false);
});

test("comment and reply fail closed without a valid owner ID", () => {
  for (const ownerIds of [undefined, null, [], [''], ['abc'], ['1234'], [null, {}, -12345], ['123456', 'invalid']]) {
    for (const action of ['comment', 'reply']) {
      assert.deepEqual(decideSocialAction({consent: true, interest: '剧情', ownerIds, choice: {action, text: '好看'}}), {action: 'skip', reason: 'invalid-or-private'}, `${action}: ${JSON.stringify(ownerIds)}`);
    }
  }
});

test('valid owner IDs still block CQ codes and disguised owner IDs for comments and replies', () => {
  for (const action of ['comment', 'reply']) {
    for (const text of ['[CQ:at,qq=999999]', '账号１ ２３-４５６', '123\u200b456']) {
      assert.equal(decideSocialAction({consent: true, interest: '剧情', ownerIds: [123456], choice: {action, text}}).action, 'skip', `${action}: ${text}`);
    }
    assert.deepEqual(decideSocialAction({consent: true, interest: '剧情', ownerIds: ['123456'], choice: {action, text: '好看'}}), {action, text: '好看'});
  }
});

test('likes and watching do not require owner IDs', () => {
  assert.deepEqual(decideSocialAction({consent: true, interest: '剧情', ownerIds: [], choice: {action: 'like'}}), {action: 'like'});
  assert.deepEqual(decideSocialAction({consent: true, interest: '剧情', choice: {action: 'skip'}}), {action: 'skip', reason: 'declined'});
});

test("explicit skip remains normal even with interest, and privacy check fails closed without owner IDs", () => {
 assert.equal(decideSocialAction({consent: true, interest: "剧情", choice: {action: "skip"}}).action, "skip");
 assert.equal(decideSocialAction({consent: true, interest: "剧情", choice: {action: "reply", text: "你好"}}).action, "skip");
 assert.equal(decideSocialAction({consent: true, interest: "剧情", ownerIds: [], choice: {action: "comment", text: "[CQ:at,qq=123456]"}}).action, "skip");
});
