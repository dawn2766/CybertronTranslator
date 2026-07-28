import { readFile, stat } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALPHABET_REGISTRY,
  DEFAULT_ALPHABET_ID,
  TRANSLATION_DIRECTIONS,
  countLiterals,
  tokenizeInput,
} from '../app/translator.js';

test('translation directions are stable', () => {
  assert.deepEqual(TRANSLATION_DIRECTIONS, {
    ENGLISH_TO_CYBERTRON: 'english-to-cybertron',
    CYBERTRON_TO_ENGLISH: 'cybertron-to-english',
  });
  assert.equal(Object.isFrozen(TRANSLATION_DIRECTIONS), true);
});

test('registry is deeply immutable and contains two complete independent alphabets', async () => {
  assert.equal(DEFAULT_ALPHABET_ID, 'decepticon');
  assert.equal(Object.isFrozen(ALPHABET_REGISTRY), true);
    assert.deepEqual(Object.keys(ALPHABET_REGISTRY), ['autobot', 'decepticon']);
  assert.deepEqual(
    Object.values(ALPHABET_REGISTRY).map(({ id, zhLabel, enLabel, downloadSlug, fontFamily, fontPath }) => ({
      id, zhLabel, enLabel, downloadSlug, fontFamily, fontPath,
    })),
    [
      {
        id: 'autobot', zhLabel: '汽车人', enLabel: 'AUTOBOT', downloadSlug: 'autobot',
        fontFamily: 'Cybertron Autobot', fontPath: './assets/fonts/cybertron-autobot.woff2',
      },
      {
        id: 'decepticon', zhLabel: '霸天虎', enLabel: 'DECEPTICON', downloadSlug: 'decepticon',
        fontFamily: 'Cybertron Decepticon', fontPath: './assets/fonts/cybertron-decepticon.woff2',
      },
    ],
  );

  const allPaths = [];
  for (const alphabet of Object.values(ALPHABET_REGISTRY)) {
    assert.equal(Object.isFrozen(alphabet), true);
    assert.equal(Object.isFrozen(alphabet.manifest), true);
    assert.equal(alphabet.manifest.length, 26);
    assert.deepEqual(alphabet.manifest.map(({ letter }) => letter), [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']);
    assert.ok(alphabet.manifest.every((glyph) => Object.isFrozen(glyph)));

    for (const glyph of alphabet.manifest) {
      assert.equal(glyph.path, `./assets/glyphs/${alphabet.id}/${glyph.letter}.png`);
      allPaths.push(glyph.path);
      const asset = await stat(new URL(`../app/${glyph.path.slice(2)}`, import.meta.url));
      assert.ok(asset.isFile(), `${alphabet.id}/${glyph.letter} asset must be a file`);
      assert.ok(asset.size > 0, `${alphabet.id}/${glyph.letter} asset must not be empty`);
    }

    const fontContents = await readFile(new URL(`../app/${alphabet.fontPath.slice(2)}`, import.meta.url));
    assert.equal(fontContents.subarray(0, 4).toString('ascii'), 'wOF2');
  }

  assert.equal(new Set(allPaths).size, 52);
  for (const letter of ['A', 'M', 'Z']) {
    const autobot = ALPHABET_REGISTRY.autobot.manifest.find((glyph) => glyph.letter === letter);
    const decepticon = ALPHABET_REGISTRY.decepticon.manifest.find((glyph) => glyph.letter === letter);
    assert.notEqual(autobot.path, decepticon.path);
  }
  assert.throws(() => { ALPHABET_REGISTRY.autobot.zhLabel = 'changed'; }, TypeError);
  assert.throws(() => { ALPHABET_REGISTRY.decepticon.manifest.push({}); }, TypeError);
});

test('tokenizer maps Cybertron case-insensitively with the default or selected manifest', () => {
  const defaultTokens = tokenizeInput('Cybertron');
  const decepticonTokens = tokenizeInput('Cybertron', ALPHABET_REGISTRY.decepticon.manifest);
  assert.deepEqual(defaultTokens.map((token) => token.value), [...'CYBERTRON']);
  assert.deepEqual(defaultTokens.map((token) => token.glyph.letter), [...'CYBERTRON']);
  assert.ok(defaultTokens.every((token) => token.glyph.path.includes('/decepticon/')));
  assert.ok(decepticonTokens.every((token) => token.glyph.path.includes('/decepticon/')));
  assert.deepEqual(
    decepticonTokens.map((token) => token.source ?? token.value),
    defaultTokens.map((token) => token.source ?? token.value),
  );
});

test('tokenizer preserves complete prose order and classifies literal punctuation', () => {
  const source = '“Hello,” we\'re here.';
  const tokens = tokenizeInput(source);
  assert.equal(tokens.length, [...source].length);
  assert.equal(tokens.map((token) => token.source ?? token.value).join(''), source);
  const literals = tokens.filter((token) => token.type === 'literal');
  assert.equal(literals.map((token) => token.value).join(''), '“,”\'.');
  assert.deepEqual(literals.map((token) => token.placement), ['top', 'baseline', 'top', 'top', 'baseline']);
  assert.equal(countLiterals(tokens), 5);
  assert.equal(tokens.filter((token) => token.type === 'space').length, 2);
  assert.equal(tokens.filter((token) => token.type === 'newline').length, 0);
  assert.ok(tokens.filter((token) => token.type === 'glyph').every((token) => token.glyph.letter === token.value));
});

test('tokenizer preserves unknown text and digits as plain literals', () => {
  const source = '火种 2048';
  const tokens = tokenizeInput(source);
  assert.equal(tokens.map((token) => token.source ?? token.value).join(''), source);
  assert.deepEqual(tokens.map((token) => token.type), [
    'literal', 'literal', 'space', 'literal', 'literal', 'literal', 'literal',
  ]);
});

test('tokenizer preserves all 600 characters without a product limit', () => {
  const source = 'A'.repeat(600);
  const tokens = tokenizeInput(source);
  assert.equal(tokens.length, 600);
  assert.equal(tokens.map((token) => token.source).join(''), source);
  assert.ok(tokens.every((token) => token.type === 'glyph' && token.value === 'A'));
});