const SIZE_RANGE = Object.freeze({ min: 16, max: 52 });
const EXPORT_PADDING = 32;
const EXPORT_MIN_HEIGHT = 120;
const NORMALIZED_BACKGROUND = '#fdfdfb';
const TEMPLATE_SHIFT = 2;
const BEAM_WIDTH = 96;
const MAX_LINE_TOKENS = 240;
const MIN_TOKEN_SCORE = 0.38;
const MIN_ACCEPTED_SCORE = 0.56;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LITERALS = '0123456789.,!?;:\'"“”‘’()-[]{}%/+';
const TOP_LITERALS = new Set(["'", '"', '‘', '’', '“', '”']);
const MARKER_MAGIC = new TextEncoder().encode('CYIMG1');
const MARKER_HEADER_BYTES = MARKER_MAGIC.length + 8;
const MARKER_ROWS = 30;
const templateCache = new Map();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function readUint32(bytes, offset) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function markerCapacity(width, height) {
  return Math.floor(width * Math.min(MARKER_ROWS, height) * 3 / 4);
}

function writeMarkerBytes(imageData, bytes) {
  let chunkIndex = 0;
  const rowCount = Math.min(MARKER_ROWS, imageData.height);
  for (let row = 0; row < rowCount && chunkIndex < bytes.length * 4; row += 1) {
    const y = imageData.height - 1 - row;
    for (let x = 0; x < imageData.width && chunkIndex < bytes.length * 4; x += 1) {
      const pixelOffset = (y * imageData.width + x) * 4;
      for (let channel = 0; channel < 3 && chunkIndex < bytes.length * 4; channel += 1) {
        const byte = bytes[Math.floor(chunkIndex / 4)];
        const shift = 6 - (chunkIndex % 4) * 2;
        imageData.data[pixelOffset + channel] = (
          imageData.data[pixelOffset + channel] & 0xfc
        ) | ((byte >>> shift) & 0x03);
        chunkIndex += 1;
      }
    }
  }
}

function readMarkerBytes(imageData, byteCount) {
  const bytes = new Uint8Array(byteCount);
  let chunkIndex = 0;
  const rowCount = Math.min(MARKER_ROWS, imageData.height);
  for (let row = 0; row < rowCount && chunkIndex < byteCount * 4; row += 1) {
    const y = imageData.height - 1 - row;
    for (let x = 0; x < imageData.width && chunkIndex < byteCount * 4; x += 1) {
      const pixelOffset = (y * imageData.width + x) * 4;
      for (let channel = 0; channel < 3 && chunkIndex < byteCount * 4; channel += 1) {
        const shift = 6 - (chunkIndex % 4) * 2;
        bytes[Math.floor(chunkIndex / 4)] |= (
          imageData.data[pixelOffset + channel] & 0x03
        ) << shift;
        chunkIndex += 1;
      }
    }
  }
  return bytes;
}

export function embedCybertronPayload(canvas, payload) {
  const encoded = new TextEncoder().encode(JSON.stringify({
    version: 1,
    family: payload.family,
    size: payload.size,
    text: String(payload.text ?? ''),
  }));
  const packet = new Uint8Array(MARKER_HEADER_BYTES + encoded.length);
  packet.set(MARKER_MAGIC, 0);
  writeUint32(packet, MARKER_MAGIC.length, encoded.length);
  writeUint32(packet, MARKER_MAGIC.length + 4, crc32(encoded));
  packet.set(encoded, MARKER_HEADER_BYTES);
  if (packet.length > markerCapacity(canvas.width, canvas.height)) {
    throw new Error('文本过长，无法写入可校验的图片识别标记');
  }
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  writeMarkerBytes(imageData, packet);
  context.putImageData(imageData, 0, 0);
}

export function decodeCybertronPayload(imageData) {
  if (markerCapacity(imageData.width, imageData.height) < MARKER_HEADER_BYTES) return null;
  const header = readMarkerBytes(imageData, MARKER_HEADER_BYTES);
  if (!MARKER_MAGIC.every((byte, index) => header[index] === byte)) return null;
  const length = readUint32(header, MARKER_MAGIC.length);
  const expectedCrc = readUint32(header, MARKER_MAGIC.length + 4);
  if (length <= 0 || MARKER_HEADER_BYTES + length > markerCapacity(imageData.width, imageData.height)) {
    return null;
  }
  const packet = readMarkerBytes(imageData, MARKER_HEADER_BYTES + length);
  const encoded = packet.slice(MARKER_HEADER_BYTES);
  if (crc32(encoded) !== expectedCrc) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(encoded));
    return payload?.version === 1 && typeof payload.text === 'string' && typeof payload.family === 'string'
      ? payload
      : null;
  } catch {
    return null;
  }
}

function getLuminance(red, green, blue) {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function getOtsuThreshold(grayscale) {
  const histogram = new Uint32Array(256);
  for (const value of grayscale) histogram[value] += 1;
  let weightedTotal = 0;
  for (let value = 0; value < 256; value += 1) weightedTotal += value * histogram[value];

  let backgroundCount = 0;
  let backgroundWeight = 0;
  let bestVariance = -1;
  let threshold = 127;
  for (let value = 0; value < 256; value += 1) {
    backgroundCount += histogram[value];
    if (backgroundCount === 0) continue;
    const foregroundCount = grayscale.length - backgroundCount;
    if (foregroundCount === 0) break;
    backgroundWeight += value * histogram[value];
    const backgroundMean = backgroundWeight / backgroundCount;
    const foregroundMean = (weightedTotal - backgroundWeight) / foregroundCount;
    const variance = backgroundCount * foregroundCount * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = value;
    }
  }
  return threshold;
}

function countBorderPixels(mask, width, height) {
  let count = 0;
  for (let x = 0; x < width; x += 1) count += mask[x] + mask[(height - 1) * width + x];
  for (let y = 1; y < height - 1; y += 1) count += mask[y * width] + mask[y * width + width - 1];
  return count;
}

function removeNoise(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const component = [];
  const minimumArea = Math.max(2, Math.round(Math.min(width, height) * 0.004));
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    component.length = 0;
    while (head < tail) {
      const index = queue[head++];
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
        for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
          if (deltaX === 0 && deltaY === 0) continue;
          const nextX = x + deltaX;
          const nextY = y + deltaY;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    if (component.length < minimumArea) {
      for (const index of component) mask[index] = 0;
    }
  }
  return mask;
}

export function createBinaryMask(imageData) {
  const { data, width, height } = imageData;
  const grayscale = new Uint8Array(width * height);
  for (let index = 0; index < grayscale.length; index += 1) {
    const offset = index * 4;
    const alpha = data[offset + 3] / 255;
    const red = data[offset] * alpha + 255 * (1 - alpha);
    const green = data[offset + 1] * alpha + 255 * (1 - alpha);
    const blue = data[offset + 2] * alpha + 255 * (1 - alpha);
    grayscale[index] = Math.round(getLuminance(red, green, blue));
  }
  const threshold = getOtsuThreshold(grayscale);
  const dark = new Uint8Array(grayscale.length);
  const light = new Uint8Array(grayscale.length);
  for (let index = 0; index < grayscale.length; index += 1) {
    dark[index] = grayscale[index] <= threshold ? 1 : 0;
    light[index] = grayscale[index] > threshold ? 1 : 0;
  }
  const borderSize = width * 2 + Math.max(0, height - 2) * 2;
  const darkBorder = countBorderPixels(dark, width, height) / borderSize;
  const lightBorder = countBorderPixels(light, width, height) / borderSize;
  const selected = darkBorder <= lightBorder ? dark : light;
  return { mask: removeNoise(selected, width, height), width, height, threshold };
}

function getBounds(mask, width, height) {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right >= left && bottom >= top ? { left, right, top, bottom } : null;
}

function getLineHeight(size) {
  return Math.round(size * 1.3);
}

function getRenderSettings(size) {
  return {
    size,
    lineHeight: getLineHeight(size),
    glyphGap: Math.max(1, Math.round(size / 34)),
    wordGap: Math.round(size * 0.35),
    punctuationLift: Math.max(2, Math.round(size * 0.1)),
  };
}

function canvasMask(canvas) {
  return createBinaryMask(canvas.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height)).mask;
}

function drawToken(context, token, x, settings, alphabet) {
  const contentTop = Math.max(0, (settings.lineHeight - settings.size) / 2);
  context.fillStyle = '#000000';
  if (token.kind === 'glyph') {
    context.font = `${settings.size}px "${alphabet.fontFamily}"`;
    context.textBaseline = 'alphabetic';
    context.fillText(token.character, x, contentTop + settings.size);
    return;
  }
  context.font = `${settings.size}px Bahnschrift, "Microsoft YaHei UI", sans-serif`;
  context.textBaseline = TOP_LITERALS.has(token.character) ? 'top' : 'alphabetic';
  const y = TOP_LITERALS.has(token.character)
    ? contentTop
    : contentTop + settings.size - settings.punctuationLift;
  context.fillText(token.character, x, y);
}

function measureToken(context, character, settings, alphabet) {
  const kind = LETTERS.includes(character) ? 'glyph' : 'literal';
  context.font = kind === 'glyph'
    ? `${settings.size}px "${alphabet.fontFamily}"`
    : `${settings.size}px Bahnschrift, "Microsoft YaHei UI", sans-serif`;
  const contentWidth = context.measureText(character).width;
  return {
    character,
    kind,
    contentWidth,
    advance: contentWidth + settings.glyphGap,
  };
}

async function createTemplateSet(alphabet, size) {
  const cacheKey = `${alphabet.id}:${size}`;
  if (templateCache.has(cacheKey)) return templateCache.get(cacheKey);
  const pending = (async () => {
    const settings = getRenderSettings(size);
    await document.fonts.load(`${size}px "${alphabet.fontFamily}"`, LETTERS);
    const measureCanvas = document.createElement('canvas');
    const measureContext = measureCanvas.getContext('2d');
    const tokens = [...LETTERS, ...LITERALS].map((character) => (
      measureToken(measureContext, character, settings, alphabet)
    ));
    for (const token of tokens) {
      const width = Math.max(1, Math.ceil(token.advance) + TEMPLATE_SHIFT * 2 + 2);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = settings.lineHeight;
      const context = canvas.getContext('2d');
      context.fillStyle = NORMALIZED_BACKGROUND;
      context.fillRect(0, 0, width, settings.lineHeight);
      drawToken(context, token, TEMPLATE_SHIFT, settings, alphabet);
      token.mask = canvasMask(canvas);
      token.maskWidth = width;
      token.inkBounds = getBounds(token.mask, width, settings.lineHeight);
    }
    return { settings, tokens };
  })();
  templateCache.set(cacheKey, pending);
  return pending;
}

function sliceLine(mask, imageWidth, startY, lineHeight, lineWidth) {
  const line = new Uint8Array(lineWidth * lineHeight);
  for (let y = 0; y < lineHeight; y += 1) {
    const sourceY = startY + y;
    if (sourceY < 0) continue;
    for (let x = 0; x < lineWidth; x += 1) {
      line[y * lineWidth + x] = mask[sourceY * imageWidth + EXPORT_PADDING + x];
    }
  }
  return line;
}

function similarity(expected, expectedWidth, observed, observedWidth, lineHeight, offset) {
  let intersection = 0;
  let expectedCount = 0;
  let observedCount = 0;
  let union = 0;
  for (let y = 0; y < lineHeight; y += 1) {
    for (let x = 0; x < expectedWidth; x += 1) {
      const expectedPixel = expected[y * expectedWidth + x];
      const observedX = offset + x - TEMPLATE_SHIFT;
      const observedPixel = observedX >= 0 && observedX < observedWidth
        ? observed[y * observedWidth + observedX]
        : 0;
      expectedCount += expectedPixel;
      observedCount += observedPixel;
      intersection += expectedPixel && observedPixel ? 1 : 0;
      union += expectedPixel || observedPixel ? 1 : 0;
    }
  }
  if (!expectedCount || !observedCount) return 0;
  const dice = 2 * intersection / (expectedCount + observedCount);
  const iou = union ? intersection / union : 0;
  return dice * 0.65 + iou * 0.35;
}

function scoreToken(lineMask, lineWidth, lineHeight, pen, token) {
  let best = 0;
  const origin = Math.round(pen);
  for (let shift = -1; shift <= 1; shift += 1) {
    best = Math.max(best, similarity(
      token.mask,
      token.maskWidth,
      lineMask,
      lineWidth,
      lineHeight,
      origin + shift,
    ));
  }
  return best;
}

function hasInk(mask, width, height, startX, endX = width - 1) {
  const left = Math.max(0, Math.floor(startX));
  const right = Math.min(width - 1, Math.ceil(endX));
  for (let y = 0; y < height; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (mask[y * width + x]) return true;
    }
  }
  return false;
}

function renderSequenceMask(sequence, width, settings, alphabet) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = settings.lineHeight;
  const context = canvas.getContext('2d');
  context.fillStyle = NORMALIZED_BACKGROUND;
  context.fillRect(0, 0, width, settings.lineHeight);
  let pen = 0;
  for (const token of sequence) {
    if (token.kind !== 'space') drawToken(context, token, pen, settings, alphabet);
    pen += token.advance;
  }
  return canvasMask(canvas);
}

function fullLineSimilarity(first, second) {
  let intersection = 0;
  let firstCount = 0;
  let secondCount = 0;
  for (let index = 0; index < first.length; index += 1) {
    firstCount += first[index];
    secondCount += second[index];
    intersection += first[index] && second[index] ? 1 : 0;
  }
  return firstCount + secondCount ? 2 * intersection / (firstCount + secondCount) : 1;
}

function decodeLine(lineMask, lineWidth, templateSet, alphabet) {
  const { settings, tokens } = templateSet;
  const inkBounds = getBounds(lineMask, lineWidth, settings.lineHeight);
  if (!inkBounds) return { tokens: [], usedWidth: 0, confidence: 1 };
  let beam = [{ pen: 0, tokens: [], score: 0, characterCount: 0 }];
  const finished = [];

  for (let step = 0; step < MAX_LINE_TOKENS && beam.length; step += 1) {
    const nextStates = [];
    for (const state of beam) {
      if (!hasInk(lineMask, lineWidth, settings.lineHeight, state.pen - 1)) {
        finished.push(state);
        continue;
      }
      const matches = tokens.map((token) => ({ token, score: scoreToken(
        lineMask,
        lineWidth,
        settings.lineHeight,
        state.pen,
        token,
      ) })).filter((match) => match.score >= MIN_TOKEN_SCORE)
        .sort((first, second) => second.score - first.score)
        .slice(0, 5);
      for (const match of matches) {
        const pen = state.pen + match.token.advance;
        if (pen > lineWidth + settings.glyphGap) continue;
        nextStates.push({
          pen,
          tokens: [...state.tokens, { ...match.token, confidence: match.score }],
          score: state.score + match.score - MIN_TOKEN_SCORE,
          characterCount: state.characterCount + 1,
        });
      }

      const blankEnd = state.pen + settings.wordGap * 0.72;
      const previous = state.tokens.at(-1);
      if (previous?.kind !== 'space'
        && blankEnd <= lineWidth
        && !hasInk(lineMask, lineWidth, settings.lineHeight, state.pen, blankEnd)) {
        nextStates.push({
          ...state,
          pen: state.pen + settings.wordGap,
          tokens: [...state.tokens, {
            character: ' ', kind: 'space', advance: settings.wordGap, confidence: 1,
          }],
          score: state.score + 0.08,
        });
      }
    }
    const deduplicated = new Map();
    for (const state of nextStates) {
      const key = `${Math.round(state.pen * 2)}:${state.tokens.at(-1)?.character}`;
      const existing = deduplicated.get(key);
      if (!existing || state.score > existing.score) deduplicated.set(key, state);
    }
    beam = [...deduplicated.values()]
      .sort((first, second) => second.score - first.score)
      .slice(0, BEAM_WIDTH);
  }
  finished.push(...beam.filter((state) => !hasInk(
    lineMask,
    lineWidth,
    settings.lineHeight,
    state.pen - 1,
  )));
  if (!finished.length) throw new Error('无法分割图片中的字符，请使用本项目原始导出图片');

  const ranked = finished.map((state) => {
    const rendered = renderSequenceMask(state.tokens, lineWidth, settings, alphabet);
    return { ...state, lineScore: fullLineSimilarity(rendered, lineMask) };
  }).sort((first, second) => second.lineScore - first.lineScore);
  const best = ranked[0];
  return {
    tokens: best.tokens,
    usedWidth: best.pen,
    confidence: best.lineScore,
  };
}

function candidateGeometries(width, height, binaryBounds) {
  const lineWidth = width - EXPORT_PADDING * 2;
  if (lineWidth <= 0) return [];
  const candidates = [];
  for (let size = SIZE_RANGE.min; size <= SIZE_RANGE.max; size += 1) {
    const lineHeight = getLineHeight(size);
    const lineCount = height === EXPORT_MIN_HEIGHT
      ? 1
      : Math.max(1, Math.round((height - EXPORT_PADDING * 2) / lineHeight));
    const expectedHeight = Math.max(
      EXPORT_MIN_HEIGHT,
      EXPORT_PADDING * 2 + lineCount * lineHeight,
    );
    if (Math.abs(expectedHeight - height) > 1) continue;
    const expectedTop = EXPORT_PADDING + Math.max(0, (lineHeight - size) / 2);
    const topError = Math.max(0, expectedTop - binaryBounds.top - 4);
    candidates.push({ size, lineHeight, lineCount, lineWidth, geometryPenalty: topError / size });
  }
  return candidates;
}

function restoreLineBreaks(lines, lineWidth) {
  let rawText = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    rawText += line.tokens.map((token) => token.character).join('');
    const nextLine = lines[index + 1];
    if (!nextLine) continue;
    const nextVisible = nextLine.tokens.find((token) => token.kind !== 'space');
    const isSoftWrap = nextVisible && line.usedWidth + nextVisible.advance > lineWidth + 0.5;
    if (!isSoftWrap) rawText += '\n';
  }
  return rawText;
}

export function formatRecognizedEnglish(value) {
  let text = String(value ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\s+([,.;:!?%\)\]\}”’])/g, '$1')
    .replace(/([\(\[\{“‘])\s+/g, '$1')
    .replace(/([A-Za-z])\s*['’]\s*([A-Za-z])/g, "$1'$2")
    .replace(/([,;:])(?=[A-Za-z0-9“‘\(\[\{])/g, '$1 ')
    .replace(/([.!?])(?=[A-Za-z0-9“‘\(\[\{])/g, '$1 ')
    .replace(/([”’"])(?=[A-Za-z0-9])/g, '$1 ');
  let capitalizeNext = true;
  text = Array.from(text, (character) => {
    if (/^[A-Za-z]$/.test(character)) {
      const normalized = capitalizeNext ? character.toUpperCase() : character.toLowerCase();
      capitalizeNext = false;
      return normalized;
    }
    if (/[.!?]/.test(character)) capitalizeNext = true;
    return character;
  }).join('');
  return text;
}

export async function recognizeCybertronImageData(imageData, alphabet) {
  const payload = decodeCybertronPayload(imageData);
  if (payload) {
    if (payload.family !== alphabet.id) {
      throw new Error(`图片属于${payload.family === 'autobot' ? '汽车人' : '霸天虎'}字族，请切换字族后重试`);
    }
    const glyphs = Array.from(payload.text).flatMap((character, index) => (
      /\s/.test(character) ? [] : [{
        character,
        confidence: 1,
        accepted: true,
        lineIndex: payload.text.slice(0, index).split('\n').length - 1,
      }]
    ));
    return {
      text: formatRecognizedEnglish(payload.text),
      rawText: payload.text,
      glyphs,
      lineCount: payload.text.split('\n').length,
      confidence: 1,
      uncertainCount: 0,
      size: payload.size,
      threshold: null,
      source: 'verified-marker',
    };
  }
  const binary = createBinaryMask(imageData);
  const bounds = getBounds(binary.mask, binary.width, binary.height);
  if (!bounds) throw new Error('图片中没有检测到可识别的文字');
  const geometries = candidateGeometries(binary.width, binary.height, bounds);
  if (!geometries.length) throw new Error('图片尺寸与本项目导出格式不匹配');

  const results = [];
  for (const geometry of geometries) {
    try {
      const templateSet = await createTemplateSet(alphabet, geometry.size);
      const lines = [];
      for (let lineIndex = 0; lineIndex < geometry.lineCount; lineIndex += 1) {
        const startY = EXPORT_PADDING + lineIndex * geometry.lineHeight;
        const lineMask = sliceLine(
          binary.mask,
          binary.width,
          startY,
          geometry.lineHeight,
          geometry.lineWidth,
        );
        lines.push(decodeLine(lineMask, geometry.lineWidth, templateSet, alphabet));
      }
      const rawText = restoreLineBreaks(lines, geometry.lineWidth);
      const lineConfidence = lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length;
      results.push({
        ...geometry,
        lines,
        rawText,
        text: formatRecognizedEnglish(rawText),
        confidence: lineConfidence - geometry.geometryPenalty,
      });
    } catch {
      // A wrong size candidate often cannot consume a line; other candidates remain valid.
    }
  }
  if (!results.length) throw new Error('无法识别图片，请确认图片由本项目导出且字族选择正确');
  results.sort((first, second) => second.confidence - first.confidence);
  const best = results[0];
  const glyphs = best.lines.flatMap((line, lineIndex) => line.tokens
    .filter((token) => token.kind !== 'space')
    .map((token) => ({
      character: token.character,
      confidence: token.confidence,
      accepted: token.confidence >= MIN_ACCEPTED_SCORE,
      lineIndex,
    })));
  const uncertainCount = glyphs.filter((glyph) => !glyph.accepted).length;
  return {
    text: best.text,
    rawText: best.rawText,
    glyphs,
    lineCount: best.lineCount,
    confidence: best.confidence,
    uncertainCount,
    size: best.size,
    threshold: binary.threshold,
    source: 'visual-ocr',
  };
}

async function loadImageData(source) {
  const bitmap = await createImageBitmap(source);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = NORMALIZED_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { imageData: context.getImageData(0, 0, canvas.width, canvas.height), canvas };
}

export async function recognizeCybertronFile(file, alphabet) {
  if (!(file instanceof Blob) || !file.type.startsWith('image/')) {
    throw new Error('请选择 PNG、JPG 或 WebP 图片');
  }
  const { imageData, canvas } = await loadImageData(file);
  return { ...await recognizeCybertronImageData(imageData, alphabet), previewCanvas: canvas };
}
