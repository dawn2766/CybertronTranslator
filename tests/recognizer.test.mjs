import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRecognizedEnglish } from '../app/recognizer.js';

test('recognized English uses sentence case and treats a line break as a new sentence', () => {
  assert.equal(
    formatRecognizedEnglish('“HELLO,” WE\'RE\nHERE.'),
    '“Hello,” we\'re\nHere.',
  );
  assert.equal(
    formatRecognizedEnglish('FIRST LINE.\nSECOND LINE! THIRD? FOURTH.'),
    'First line.\nSecond line! Third? Fourth.',
  );
});

test('recognized English restores conventional punctuation and word spacing', () => {
  assert.equal(
    formatRecognizedEnglish('HELLO ,WORLD !HOW ARE YOU ?'),
    'Hello, world! How are you?',
  );
  assert.equal(
    formatRecognizedEnglish('WE \' RE HERE ;YES :NOW'),
    "We're here; yes: now",
  );
  assert.equal(
    formatRecognizedEnglish('( HELLO ) [ WORLD ]'),
    '(Hello) [world]',
  );
});