const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function createAlphabet(id, zhLabel, enLabel, downloadSlug, fontFamily) {
  return Object.freeze({
    id,
    zhLabel,
    enLabel,
    downloadSlug,
    fontFamily,
    fontPath: `./assets/fonts/cybertron-${id}.woff2`,
    manifest: Object.freeze([...LETTERS].map((letter) => Object.freeze({
      letter,
      path: `./assets/glyphs/${id}/${letter}.png`,
    }))),
  });
}

export const DEFAULT_ALPHABET_ID = 'autobot';

export const TRANSLATION_DIRECTIONS = Object.freeze({
  ENGLISH_TO_CYBERTRON: 'english-to-cybertron',
  CYBERTRON_TO_ENGLISH: 'cybertron-to-english',
});

export const ALPHABET_REGISTRY = Object.freeze({
  autobot: createAlphabet('autobot', '汽车人', 'AUTOBOT', 'autobot', 'Cybertron Autobot'),
  decepticon: createAlphabet('decepticon', '霸天虎', 'DECEPTICON', 'decepticon', 'Cybertron Decepticon'),
});

const TOP_LITERALS = new Set(["'", '"', '‘', '’', '“', '”']);

export function tokenizeInput(value, manifest = ALPHABET_REGISTRY[DEFAULT_ALPHABET_ID].manifest) {
  const input = String(value ?? '');
  const glyphsByLetter = new Map(manifest.map((glyph) => [glyph.letter, glyph]));
  return Array.from(input, (character) => {
    if (/^[A-Za-z]$/.test(character)) {
      const letter = character.toUpperCase();
      return { type: 'glyph', value: letter, source: character, glyph: glyphsByLetter.get(letter) };
    }
    if (character === '\n' || character === '\r') {
      return { type: 'newline', value: character };
    }
    if (/^\s$/.test(character)) {
      return { type: 'space', value: character };
    }
    return {
      type: 'literal',
      value: character,
      placement: TOP_LITERALS.has(character) ? 'top' : 'baseline',
    };
  });
}

export function countLiterals(tokens) {
  return tokens.filter((token) => token.type === 'literal').length;
}