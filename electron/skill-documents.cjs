'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxTextChars: 200_000,
  formats: Object.freeze(['txt', 'md', 'docx', 'pdf']),
  parseTimeoutMs: 30_000,
});

function documentError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeText(value, format) {
  const text = String(value ?? '').replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim();
  if (!text) throw documentError(format === 'pdf' ? 'SKILL_PDF_NO_TEXT' : 'SKILL_EMPTY_DOCUMENT', format === 'pdf'
    ? 'PDF 中没有可提取的正文，可能是扫描件或空白文件。请先进行文字识别，或改用 TXT、MD、DOCX。'
    : '文件没有可导入的正文，请选择包含文字的 Skill 文件。');
  if (text.length > LIMITS.maxTextChars) throw documentError('SKILL_TEXT_TOO_LARGE', `提取正文超过 ${LIMITS.maxTextChars.toLocaleString('en-US')} 字符，未截断或导入。请拆分后重试。`);
  if (/[\x00-\x08\x0B\x0E-\x1F\x7F]/u.test(text)) throw documentError('SKILL_INVALID_TEXT', '文件含有无效控制字符，可能不是文本文件或编码不正确。请另存为 UTF-8 文本后重试。');
  return text;
}

function decodeText(bytes) {
  const buffer = Buffer.from(bytes);
  const encoding = buffer[0] === 0xFF && buffer[1] === 0xFE ? 'utf-16le'
    : buffer[0] === 0xFE && buffer[1] === 0xFF ? 'utf-16be' : 'utf-8';
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buffer);
  } catch {
    // A BOM identifies the encoding; do not reinterpret corrupt BOM text as GBK.
    if (encoding !== 'utf-8' || (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF)) {
      throw documentError('SKILL_INVALID_ENCODING', '文本编码损坏，请另存为 UTF-8 文本后重试。');
    }
    try { return new TextDecoder('gb18030', { fatal: true }).decode(buffer); }
    catch { throw documentError('SKILL_INVALID_ENCODING', '无法识别文本编码，请另存为 UTF-8 文本后重试。'); }
  }
}

async function extractDocx(bytes) {
  const mammoth = require('mammoth');
  // Raw-text extraction receives bytes only: no document-relative file paths,
  // external file access, HTML renderer, embedded code, or Word automation.
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  if (result.messages?.some(message => message.type === 'error')) throw documentError('SKILL_DOCX_INVALID', 'DOCX 正文无法完整读取，请在 Word 中重新保存后重试。');
  return result.value;
}

async function extractPdf(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  // Only extract the text layer. Do not render pages, evaluate document actions,
  // open links, or use any URL supplied by the document.
  const task = getDocument({
    data: Uint8Array.from(bytes),
    cMapUrl: path.join(pdfRoot, 'cmaps').replace(/\\/gu, '/') + '/',
    cMapPacked: true,
    standardFontDataUrl: path.join(pdfRoot, 'standard_fonts').replace(/\\/gu, '/') + '/',
    useWorkerFetch: false,
    useWasm: false,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: true,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
    if (await doc.getPermissions() !== null) throw documentError('SKILL_PDF_ENCRYPTED', '该 PDF 已加密。请先另存为未加密的文本型 PDF，再导入。');
    const pages = [];
    let length = 0;
    for (let no = 1; no <= doc.numPages; no += 1) {
      const page = await doc.getPage(no);
      try {
        const content = await page.getTextContent({ disableNormalization: true });
        let pageText = '';
        for (const item of content.items) {
          if (typeof item.str !== 'string') continue;
          pageText += item.str + (item.hasEOL ? '\n' : '');
          if (length + pageText.length > LIMITS.maxTextChars) throw documentError('SKILL_TEXT_TOO_LARGE', `PDF 正文超过 ${LIMITS.maxTextChars.toLocaleString('en-US')} 字符，未截断或导入。请拆分后重试。`);
        }
        pages.push(pageText);
        length += pageText.length + (no < doc.numPages ? 2 : 0);
      } finally { page.cleanup(); }
    }
    return pages.join('\n\n');
  } catch (error) {
    if (error?.name === 'PasswordException') throw documentError('SKILL_PDF_ENCRYPTED', '该 PDF 已加密或需要密码。请先另存为未加密的文本型 PDF，再导入。');
    throw error;
  } finally {
    await task.destroy().catch(() => {});
  }
}

async function parseBytes(bytes, format) {
  try {
    const text = format === 'pdf' ? await extractPdf(bytes)
      : format === 'docx' ? await extractDocx(bytes) : decodeText(bytes);
    return normalizeText(text, format);
  } catch (error) {
    if (String(error?.code || '').startsWith('SKILL_')) throw error;
    throw documentError('SKILL_DOCUMENT_INVALID', format === 'pdf'
      ? 'PDF 无法完整解析，文件可能已损坏。请重新导出为文本型 PDF 后重试。'
      : format === 'docx' ? 'DOCX 无法解析，文件可能已损坏或并非真正的 DOCX。请重新保存后重试。'
        : '无法读取文本正文，请另存为 UTF-8 文本后重试。');
  }
}

function parseInWorker(bytes, format) {
  return new Promise((resolve, reject) => {
    // Isolate malformed/compressed documents from the interactive main process.
    const worker = new Worker(__filename, {
      workerData: { skillDocumentImport: true, bytes, format },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    let settled = false;
    const timer = setTimeout(() => finish(documentError('SKILL_PARSE_TIMEOUT', '文档解析耗时过长，已停止导入。请简化文件，或另存为 TXT 后重试。')), LIMITS.parseTimeoutMs);
    const finish = (error, content) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(content);
    };
    worker.once('message', result => result?.ok
      ? finish(null, result.content)
      : finish(documentError(result?.code || 'SKILL_DOCUMENT_INVALID', result?.message || '文档解析失败，请重新保存文件后重试。')));
    worker.once('error', () => finish(documentError('SKILL_DOCUMENT_INVALID', '文档无法完整解析，可能已损坏或结构过于复杂。请另存为 TXT 后重试。')));
    worker.once('exit', () => { if (!settled) finish(documentError('SKILL_DOCUMENT_INVALID', '文档解析意外结束，未导入任何内容。请重新保存后重试。')); });
  });
}

async function importSkillDocument(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) throw documentError('SKILL_INVALID_PATH', '请选择一个有效的本地 Skill 文件。');
  const format = path.extname(filePath).slice(1).toLowerCase();
  if (!LIMITS.formats.includes(format)) throw documentError('SKILL_UNSUPPORTED_FORMAT', '仅支持 TXT、MD、DOCX 和文本型 PDF 文件。');
  let handle;
  let bytes;
  try {
    const initial = await fs.stat(filePath);
    if (!initial.isFile()) throw documentError('SKILL_NOT_FILE', '请选择普通文件，不能导入文件夹或其他特殊文件。');
    if (initial.size > LIMITS.maxFileBytes) throw documentError('SKILL_FILE_TOO_LARGE', '文件超过 10 MiB，未导入。请拆分文件后重试。');
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw documentError('SKILL_NOT_FILE', '请选择普通文件，不能导入文件夹或其他特殊文件。');
    if (stat.size > LIMITS.maxFileBytes) throw documentError('SKILL_FILE_TOO_LARGE', '文件超过 10 MiB，未导入。请压缩或拆分文件后重试。');
    // Read at most the limit plus one byte even if a file grows after stat().
    const buffer = Buffer.alloc(Math.min(stat.size + 1, LIMITS.maxFileBytes + 1));
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      offset += bytesRead;
      if (!bytesRead || offset === buffer.length) break;
    }
    if (offset > LIMITS.maxFileBytes) throw documentError('SKILL_FILE_TOO_LARGE', '文件超过 10 MiB，未导入。请拆分后重试。');
    const after = await handle.stat();
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw documentError('SKILL_FILE_CHANGED', '文件在读取过程中发生变化，请保存文件后重新导入。');
    bytes = buffer.subarray(0, offset);
  } catch (error) {
    if (String(error?.code || '').startsWith('SKILL_')) throw error;
    throw documentError('SKILL_READ_FAILED', '无法读取文件，请确认文件仍然存在且有读取权限。');
  } finally { await handle?.close().catch(() => {}); }
  const content = await parseInWorker(bytes, format);
  return {
    name: path.basename(filePath), content, format, size: bytes.length,
    importedAt: new Date().toISOString(),
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}

if (!isMainThread && workerData?.skillDocumentImport === true) {
  parseBytes(workerData.bytes, workerData.format).then(
    content => parentPort.postMessage({ ok: true, content }),
    error => parentPort.postMessage({ ok: false, code: error.code, message: error.message }),
  );
}

module.exports = { importSkillDocument, LIMITS };
