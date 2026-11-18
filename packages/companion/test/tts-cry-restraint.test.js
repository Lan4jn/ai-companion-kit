import test from 'node:test';
import assert from 'node:assert/strict';
import { fishText } from '../src/tts.js';

const text = '我真的很难过，那只受伤的小猫最后没有等到救助。让我缓一缓。';

test('strong sadness does not automatically become crying', () => {
  assert.equal(fishText(text, { emotion: 'sad', intensity: 'strong' }), `[very sad] ${text}`);
});

test('mild explicit crying uses a soft crying control', () => {
  assert.equal(fishText(text, { emotion: 'cry', intensity: 'mild' }), `[slightly sad][softly sobbing] ${text}`);
});

test('strong explicit crying does not force loud crying', () => {
  assert.equal(fishText(text, { emotion: 'cry', intensity: 'strong' }), `[very sad][sobbing] ${text}`);
});

test('natural speech does not add emotion controls', () => {
  assert.equal(fishText(text, { emotion: 'natural', intensity: 'strong' }), text);
});
