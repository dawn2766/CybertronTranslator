import {
  ALPHABET_REGISTRY,
  DEFAULT_ALPHABET_ID,
  TRANSLATION_DIRECTIONS,
  tokenizeInput,
} from './translator.js';
import { embedCybertronPayload, recognizeCybertronFile } from './recognizer.js';

const staticAssetUrls = typeof import.meta.glob === 'function'
  ? import.meta.glob(
    ['./assets/*-logo.png', './assets/glyphs/{autobot,decepticon}/*.png'],
    { eager: true, query: '?url', import: 'default' },
  )
  : {};

function resolveAssetUrl(path) {
  return staticAssetUrls[path] ?? path;
}

const input = document.querySelector('#source-input');
const recognitionPanel = document.querySelector('#recognition-panel');
const recognitionInput = document.querySelector('#recognition-input');
const recognitionDropzone = document.querySelector('.recognition-dropzone');
const recognitionStatus = document.querySelector('#recognition-status');
const recognitionPreview = document.querySelector('#recognition-preview');
const output = document.querySelector('#output');
const characterCount = document.querySelector('#character-count');
const glyphCount = document.querySelector('#glyph-count');
const referenceDialog = document.querySelector('#reference-dialog');
const referenceGrid = document.querySelector('#reference-grid');
const referenceButton = document.querySelector('#reference-button');
const toast = document.querySelector('#toast');
const sizeControl = document.querySelector('#target-size');
const sizeValue = document.querySelector('#target-size-value');
const alphabetSelector = document.querySelector('#alphabet-selector');
const targetFamilyLabel = document.querySelector('#target-family-label');
const referenceTitle = document.querySelector('#reference-title');
const closeReference = document.querySelector('#close-reference');
const brandGlyph = document.querySelector('#brand-glyph');
const workspace = document.querySelector('#translator-workspace');
const sourceLanguage = document.querySelector('#source-language');
const targetLanguage = document.querySelector('#target-language');
const sourceLanguageCode = document.querySelector('#source-language-code');
const targetLanguageCode = document.querySelector('#target-language-code');
const sourceLanguageLabel = document.querySelector('#source-language-label');
const sourceInputLabel = document.querySelector('#source-input-label');
const directionButton = document.querySelector('#direction-button');
const directionIcon = document.querySelector('#direction-icon');
const sampleButton = document.querySelector('#sample-button');
const sampleActionLabel = document.querySelector('#sample-action-label');
const exportButton = document.querySelector('#export-button');
const primaryActionIcon = document.querySelector('#primary-action-icon');
const primaryActionLabel = document.querySelector('#primary-action-label');
const SIZE_RANGE = Object.freeze({ min: 16, max: 52, default: 28 });
const EXPORT_BACKGROUND = '#fdfdfb';
let currentAlphabetId = DEFAULT_ALPHABET_ID;
let currentDirection = TRANSLATION_DIRECTIONS.ENGLISH_TO_CYBERTRON;
let currentTokens = [];
let currentRecognition = null;
let renderSettings = deriveRenderSettings(SIZE_RANGE.default);
let toastTimer;

function getCurrentAlphabet() {
  return ALPHABET_REGISTRY[currentAlphabetId];
}

function isEnglishToCybertron() {
  return currentDirection === TRANSLATION_DIRECTIONS.ENGLISH_TO_CYBERTRON;
}

function renderAlphabetSelector() {
  const fragment = document.createDocumentFragment();
  for (const alphabet of Object.values(ALPHABET_REGISTRY)) {
    const label = document.createElement('label');
    label.className = 'alphabet-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'alphabet';
    radio.value = alphabet.id;
    radio.checked = alphabet.id === currentAlphabetId;
    const logo = document.createElement('img');
    logo.src = `./assets/${alphabet.id}-logo.png`;
    logo.alt = '';
    const text = document.createElement('span');
    text.textContent = alphabet.zhLabel;
    const content = document.createElement('span');
    content.className = 'alphabet-option-content';
    content.append(logo, text);
    label.append(radio, content);
    fragment.append(label);
  }
  alphabetSelector.replaceChildren(fragment);
}

function updateAlphabetInterface() {
  const alphabet = getCurrentAlphabet();
  const factionLogo = resolveAssetUrl(`./assets/${alphabet.id}-logo.png`);
  document.documentElement.dataset.alphabet = alphabet.id;
  document.documentElement.style.setProperty('--cybertron-font', `"${alphabet.fontFamily}"`);
  document.documentElement.style.setProperty('--faction-logo', `url("${factionLogo}")`);
  referenceTitle.textContent = `${alphabet.zhLabel}字表`;
  closeReference.setAttribute('aria-label', `关闭${alphabet.zhLabel}字表`);
  brandGlyph.src = factionLogo;
  updateDirectionInterface();
  renderReference();
}

function updateDirectionInterface() {
  const alphabet = getCurrentAlphabet();
  const forward = isEnglishToCybertron();
  document.documentElement.dataset.direction = currentDirection;
  sourceLanguageCode.textContent = forward ? 'EN' : 'CY';
  targetLanguageCode.textContent = forward ? 'CY' : 'EN';
  sourceLanguageLabel.textContent = forward ? '英文' : `${alphabet.zhLabel}字形`;
  targetFamilyLabel.textContent = forward ? `${alphabet.zhLabel}字形` : '英文';
  (forward ? targetLanguage : sourceLanguage).append(alphabetSelector, glyphCount);
  directionIcon.dataset.direction = currentDirection;
  directionButton.setAttribute('aria-label', forward ? '切换为塞伯坦文转英文' : '切换为英文转塞伯坦文');
  workspace.setAttribute('aria-label', forward ? '英文到塞伯坦文翻译工作区' : '塞伯坦文到英文翻译工作区');
  sourceInputLabel.textContent = forward ? '输入英文文本' : `输入${alphabet.zhLabel}塞伯坦文`;
  input.placeholder = '输入英文';
  input.setAttribute('aria-label', '输入英文文本');
  input.hidden = !forward;
  input.disabled = !forward;
  recognitionPanel.hidden = forward;
  output.setAttribute('aria-label', forward ? `${alphabet.zhLabel} ${alphabet.enLabel} 字形输出` : '英文翻译输出');
  sampleButton.dataset.action = forward ? 'sample' : 'upload';
  sampleActionLabel.textContent = forward ? '示例' : '选择图片';
  sampleButton.querySelector('[data-icon="lightbulb"]').toggleAttribute('hidden', !forward);
  sampleButton.querySelector('[data-icon="upload"]').toggleAttribute('hidden', forward);
  exportButton.dataset.action = forward ? 'export' : 'copy';
  primaryActionLabel.textContent = forward ? '导出图片' : '复制译文';
  primaryActionIcon.querySelector('[data-icon="download"]').toggleAttribute('hidden', !forward);
  primaryActionIcon.querySelector('[data-icon="copy"]').toggleAttribute('hidden', forward);
}

function deriveRenderSettings(value) {
  const selectedSize = Math.min(SIZE_RANGE.max, Math.max(SIZE_RANGE.min, Number(value)));
  return Object.freeze({
    selectedSize,
    glyphHeight: selectedSize,
    literalSize: selectedSize,
    lineHeight: Math.round(selectedSize * 1.3),
    glyphGap: Math.max(1, Math.round(selectedSize / 34)),
    wordGap: Math.round(selectedSize * 0.35),
    punctuationLift: Math.max(2, Math.round(selectedSize * 0.1)),
  });
}

function applyRenderSettings(value) {
  renderSettings = deriveRenderSettings(value);
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--glyph-size', `${renderSettings.glyphHeight}px`);
  rootStyle.setProperty('--literal-size', `${renderSettings.literalSize}px`);
  rootStyle.setProperty('--line-size', `${renderSettings.lineHeight}px`);
  rootStyle.setProperty('--glyph-gap', `${renderSettings.glyphGap}px`);
  rootStyle.setProperty('--word-gap', `${renderSettings.wordGap}px`);
  rootStyle.setProperty('--punctuation-lift', `${renderSettings.punctuationLift}px`);
  sizeValue.value = `${renderSettings.selectedSize} px`;
  sizeValue.textContent = `${renderSettings.selectedSize} px`;
}

function renderReference() {
  const alphabet = getCurrentAlphabet();
  const fragment = document.createDocumentFragment();
  for (const glyph of alphabet.manifest) {
    const item = document.createElement('figure');
    item.className = 'reference-item';
    item.dataset.letter = glyph.letter;
    const image = document.createElement('img');
    image.src = resolveAssetUrl(glyph.path);
    image.alt = `${alphabet.zhLabel} ${glyph.letter} 字形`;
    image.width = 68;
    image.height = 68;
    const letter = document.createElement('strong');
    letter.textContent = glyph.letter;
    item.append(letter, image);
    fragment.append(item);
  }
  referenceGrid.replaceChildren(fragment);
}

function makeGlyphToken(token) {
  const alphabet = getCurrentAlphabet();
  const item = document.createElement('span');
  item.className = 'glyph-token';
  item.dataset.source = token.source;
  item.setAttribute('aria-label', `${alphabet.zhLabel} ${alphabet.enLabel} ${token.glyph.letter} 字形`);
  item.textContent = token.source;
  return item;
}

function renderTokens(tokens) {
  if (tokens.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-output';
    empty.textContent = '译文';
    output.replaceChildren(empty);
    return;
  }
  const flow = document.createElement('div');
  flow.className = 'token-flow';
  const fragment = document.createDocumentFragment();
  for (const [index, token] of tokens.entries()) {
    let item;
    if (token.type === 'glyph') {
      item = makeGlyphToken(token);
    } else if (token.type === 'space') {
      const space = document.createElement('span');
      space.className = 'space-token';
      space.dataset.source = token.value;
      space.setAttribute('aria-label', '空格');
      item = space;
    } else if (token.type === 'newline') {
      const newline = document.createElement('br');
      newline.className = 'newline-token';
      newline.dataset.source = token.value;
      newline.setAttribute('aria-label', '换行');
      item = newline;
    } else {
      const literal = document.createElement('span');
      literal.className = `literal-token literal-${token.placement}`;
      literal.dataset.source = token.value;
      literal.dataset.placement = token.placement;
      literal.textContent = token.value;
      literal.setAttribute('aria-label', `原字符 ${token.value}`);
      item = literal;
    }
    item.dataset.tokenIndex = String(index);
    fragment.append(item);
    if (token.type !== 'newline' && index < tokens.length - 1 && tokens[index + 1].type !== 'newline') {
      const wrapOpportunity = document.createElement('wbr');
      wrapOpportunity.className = 'wrap-opportunity';
      wrapOpportunity.setAttribute('aria-hidden', 'true');
      fragment.append(wrapOpportunity);
    }
  }
  flow.append(fragment);
  output.replaceChildren(flow);
}

function renderEnglish(value) {
  if (!value) {
    const empty = document.createElement('p');
    empty.className = 'empty-output';
    empty.textContent = '译文';
    output.replaceChildren(empty);
    return;
  }
  const translation = document.createElement('div');
  translation.className = 'english-output';
  translation.textContent = value;
  output.replaceChildren(translation);
}

function renderRecognitionResult(result) {
  currentRecognition = result;
  window.__lastRecognition = Object.freeze({
    source: result.source,
    text: result.text,
    rawText: result.rawText,
    confidence: result.confidence,
    uncertainCount: result.uncertainCount,
    lineCount: result.lineCount,
    size: result.size,
  });
  recognitionStatus.textContent = result.source === 'verified-marker'
    ? `已精确恢复 ${result.glyphs.length} 个字符，校验通过`
    : result.uncertainCount === 0
      ? `已识别 ${result.glyphs.length} 个字符，置信度 ${(result.confidence * 100).toFixed(0)}%`
    : `识别完成，${result.uncertainCount} 个字形置信度不足，已标为 ?`;
  recognitionPreview.width = result.previewCanvas.width;
  recognitionPreview.height = result.previewCanvas.height;
  const previewContext = recognitionPreview.getContext('2d');
  previewContext.clearRect(0, 0, recognitionPreview.width, recognitionPreview.height);
  previewContext.drawImage(result.previewCanvas, 0, 0);
  recognitionPreview.hidden = false;
  characterCount.value = `${result.glyphs.length} 个字形`;
  characterCount.textContent = `${result.glyphs.length} 个字形`;
  glyphCount.textContent = `${result.glyphs.length - result.uncertainCount} 个字形`;
  renderEnglish(result.text);
}

function renderRecognitionEmpty() {
  currentRecognition = null;
  window.__lastRecognition = null;
  recognitionStatus.textContent = '等待图片';
  recognitionPreview.hidden = true;
  characterCount.value = '0 个字形';
  characterCount.textContent = '0 个字形';
  glyphCount.textContent = '0 个字形';
  renderEnglish('');
}

async function recognizeFile(file) {
  if (!file) return;
  recognitionStatus.textContent = '正在本地识别…';
  try {
    const result = await recognizeCybertronFile(file, getCurrentAlphabet());
    renderRecognitionResult(result);
  } catch (error) {
    currentRecognition = null;
    recognitionPreview.hidden = true;
    recognitionStatus.textContent = error instanceof Error ? error.message : '图片识别失败';
    renderEnglish('');
  }
}

function updatePreview() {
  const forward = isEnglishToCybertron();
  if (!forward) {
    currentTokens = [];
    if (!currentRecognition) renderRecognitionEmpty();
    return;
  }
  currentTokens = tokenizeInput(input.value, getCurrentAlphabet().manifest);
  characterCount.value = `${input.value.length} 字符`;
  characterCount.textContent = `${input.value.length} 字符`;
  const glyphs = currentTokens.filter((token) => token.type === 'glyph').length;
  glyphCount.textContent = `${glyphs} 个字形`;
  renderTokens(currentTokens);
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 3000);
}

function loadSample() {
  if (!isEnglishToCybertron()) {
    showToast('反向翻译请上传塞伯坦文字图片');
    recognitionInput.click();
    return;
  }
  input.value = '“Hello,” we\'re here.';
  updatePreview();
  input.focus();
}

function clearAll() {
  input.value = '';
  if (!isEnglishToCybertron()) {
    recognitionInput.value = '';
    renderRecognitionEmpty();
    input.focus();
    return;
  }
  updatePreview();
  input.focus();
}

async function exportPng() {
  if (currentTokens.length === 0) {
    showToast('请先输入要导出的文字');
    input.focus();
    return;
  }
  const alphabet = getCurrentAlphabet();
  try {
    const padding = 32;
    const {
      selectedSize, glyphHeight, literalSize, glyphGap, wordGap, lineHeight, punctuationLift,
    } = renderSettings;
    const glyphFont = `${glyphHeight}px "${alphabet.fontFamily}"`;
    await document.fonts.load(glyphFont, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    const previewFlow = output.querySelector('.token-flow');
    const lineWidth = Math.max(1, Math.floor(previewFlow?.clientWidth ?? output.clientWidth));
    const measureCanvas = document.createElement('canvas');
    const measureContext = measureCanvas.getContext('2d');
    const literalFont = `${literalSize}px Bahnschrift, "Microsoft YaHei UI", sans-serif`;
    measureContext.font = literalFont;
    const layout = [];
    let lineIndex = 0;
    let lineWidthUsed = 0;
    for (const token of currentTokens) {
      if (token.type === 'newline') {
        layout.push({ token, lineIndex, x: lineWidthUsed, contentWidth: 0, advance: 0 });
        lineIndex += 1;
        lineWidthUsed = 0;
        continue;
      }
      let contentWidth;
      let advance;
      if (token.type === 'glyph') {
        measureContext.font = glyphFont;
        contentWidth = measureContext.measureText(token.source).width;
        advance = contentWidth + glyphGap;
      } else if (token.type === 'space') {
        contentWidth = wordGap;
        advance = wordGap;
      } else {
        measureContext.font = literalFont;
        contentWidth = measureContext.measureText(token.value).width;
        advance = contentWidth + glyphGap;
      }
      if (lineWidthUsed > 0 && lineWidthUsed + advance > lineWidth) {
        lineIndex += 1;
        lineWidthUsed = 0;
      }
      layout.push({ token, lineIndex, x: lineWidthUsed, contentWidth, advance });
      lineWidthUsed += advance;
    }
    const canvas = document.createElement('canvas');
    canvas.width = lineWidth + padding * 2;
    canvas.height = Math.max(120, padding * 2 + (lineIndex + 1) * lineHeight);
    const context = canvas.getContext('2d');
    context.fillStyle = EXPORT_BACKGROUND;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = literalFont;
    const contentTop = padding + Math.max(0, (lineHeight - glyphHeight) / 2);
    for (const entry of layout) {
      const x = padding + entry.x;
      const y = contentTop + entry.lineIndex * lineHeight;
      if (entry.token.type === 'glyph') {
        context.fillStyle = '#000000';
        context.font = glyphFont;
        context.textBaseline = 'alphabetic';
        context.fillText(entry.token.source, x, y + glyphHeight);
      } else if (entry.token.type === 'literal') {
        context.fillStyle = '#000000';
        context.font = literalFont;
        context.textBaseline = entry.token.placement === 'top' ? 'top' : 'alphabetic';
        const literalY = entry.token.placement === 'top' ? y : y + glyphHeight - punctuationLift;
        context.fillText(entry.token.value, x, literalY);
      }
    }
    embedCybertronPayload(canvas, {
      family: alphabet.id,
      size: selectedSize,
      text: input.value,
    });
    window.__lastExportLayout = {
      alphabetId: alphabet.id,
      zhLabel: alphabet.zhLabel,
      enLabel: alphabet.enLabel,
      downloadSlug: alphabet.downloadSlug,
      selectedSize,
      glyphHeight,
      literalSize,
      literalFont,
      glyphFont,
      glyphGap,
      wordGap,
      punctuationLift,
      lineHeight,
      background: EXPORT_BACKGROUND,
      recognitionMarker: 'CYIMG1',
      tokenOrder: currentTokens.map((token) => token.source ?? token.value).join(''),
      entries: layout.map((entry) => ({
        type: entry.token.type,
        value: entry.token.source ?? entry.token.value,
        placement: entry.token.placement ?? null,
        lineIndex: entry.lineIndex,
        x: entry.x,
        contentWidth: entry.contentWidth,
        advance: entry.advance,
      })),
    };
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('PNG encoding failed'));
      }, 'image/png');
    });
    const fileName = `cybertron-${alphabet.downloadSlug}.png`;
    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(blob);
    link.download = fileName;
    link.href = objectUrl;
    link.hidden = true;
    document.body.append(link);
    link.click();
    window.setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(objectUrl);
    }, 1000);
    showToast(`${alphabet.zhLabel} PNG 已导出`);
  } catch {
    showToast('字形资源加载失败，请检查本地文件后重试');
  }
}

async function runPrimaryAction() {
  if (isEnglishToCybertron()) {
    await exportPng();
    return;
  }
  if (!currentRecognition?.text) {
    showToast('请先选择要识别的图片');
    recognitionInput.click();
    return;
  }
  try {
    await navigator.clipboard.writeText(currentRecognition.text);
    showToast('英文译文已复制');
  } catch {
    showToast('复制失败，请手动选择译文');
  }
}

input.addEventListener('input', updatePreview);
recognitionInput.addEventListener('change', () => {
  const file = recognitionInput.files?.[0];
  recognitionInput.value = '';
  void recognizeFile(file);
});
recognitionDropzone.addEventListener('dragover', (event) => {
  if (!isEnglishToCybertron()) event.preventDefault();
});
recognitionDropzone.addEventListener('drop', (event) => {
  if (isEnglishToCybertron()) return;
  event.preventDefault();
  void recognizeFile(event.dataTransfer?.files?.[0]);
});
document.addEventListener('paste', (event) => {
  if (isEnglishToCybertron()) return;
  const image = [...(event.clipboardData?.items ?? [])]
    .find((item) => item.type.startsWith('image/'))?.getAsFile();
  if (!image) return;
  event.preventDefault();
  void recognizeFile(image);
});
sizeControl.addEventListener('input', () => applyRenderSettings(sizeControl.value));
alphabetSelector.addEventListener('change', (event) => {
  const selectedId = event.target instanceof HTMLInputElement ? event.target.value : '';
  if (!ALPHABET_REGISTRY[selectedId] || selectedId === currentAlphabetId) return;
  currentAlphabetId = selectedId;
  currentRecognition = null;
  updateAlphabetInterface();
  updatePreview();
});
directionButton.addEventListener('click', () => {
  currentDirection = isEnglishToCybertron()
    ? TRANSLATION_DIRECTIONS.CYBERTRON_TO_ENGLISH
    : TRANSLATION_DIRECTIONS.ENGLISH_TO_CYBERTRON;
  updateDirectionInterface();
  renderReference();
  updatePreview();
  input.focus();
});
document.querySelector('#sample-button').addEventListener('click', loadSample);
document.querySelector('#clear-button').addEventListener('click', clearAll);
exportButton.addEventListener('click', () => void runPrimaryAction());
referenceButton.addEventListener('click', () => {
  renderReference();
  referenceDialog.showModal();
});
referenceButton.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    renderReference();
    referenceDialog.showModal();
  }
});
document.querySelector('#close-reference').addEventListener('click', () => {
  referenceDialog.close();
  referenceButton.focus();
});
referenceDialog.addEventListener('click', (event) => {
  if (event.target === referenceDialog) referenceDialog.close();
});
referenceDialog.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    referenceDialog.close();
    referenceButton.focus();
  }
});

renderAlphabetSelector();
updateAlphabetInterface();
applyRenderSettings(sizeControl.value);
updatePreview();