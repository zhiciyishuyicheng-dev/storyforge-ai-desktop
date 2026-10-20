'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { importSkillDocument, LIMITS } = require('./skill-documents.cjs');

let fixtureRoot;
test.before(async () => { fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'storyforge-skill-docs-')); });
test.after(async () => {
  assert.ok(path.resolve(fixtureRoot).startsWith(path.join(path.resolve(os.tmpdir()), 'storyforge-skill-docs-')));
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});
async function fixture(name, content) {
  const target = path.join(fixtureRoot, name);
  await fs.writeFile(target, content);
  return target;
}

// Real, minimal Office Open XML fixtures: a valid uncompressed ZIP package with
// CRC32 and a central directory, rather than a mocked extraction result.
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const nameBytes = Buffer.from(name), bytes = Buffer.from(value);
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014B50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, bytes); central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function docx(paragraphs, extra = {}) {
  const escape = value => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(text => `<w:p><w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`).join('')}<w:sectPr/></w:body></w:document>`,
    ...extra,
  });
}

// A real text PDF with xref offsets. Password fixtures declare Standard Security;
// the parser must request a password before attempting to read page streams.
function pdf({ text = 'Storyboard skill: keep the dialogue.', encrypted = false, imageOnly = false } = {}) {
  const escaped = text.replace(/([\\()])/gu, '\\$1');
  const stream = imageOnly ? 'q 1 0 0 1 1 1 cm /Im1 Do Q' : `BT /F1 12 Tf 20 200 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 7 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${Math.max(300, text.length * 8)} 300] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nX\nendstream',
    '<< /S /JavaScript /JS (globalThis.__skillPdfExecuted = true) >>',
  ];
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${'11'.repeat(32)}> /U <${'22'.repeat(32)}> >>`);
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(source, 'latin1')); source += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(source, 'latin1');
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypted ? ` /Encrypt 8 0 R /ID [<${'33'.repeat(16)}><${'33'.repeat(16)}>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, 'latin1');
}

test('UTF-8/BOM 文本和 Markdown 保留正文，只返回安全元数据与正文哈希', async () => {
  for (const [name, bytes] of [['规范.TXT', Buffer.from('\uFEFF镜头规范\r\n保留原声。\r\n')], ['规范.md', Buffer.from('# 分镜 Skill\n\n保持连续运镜。')]]) {
    const target = await fixture(name, bytes);
    const result = await importSkillDocument(target);
    assert.equal(result.name, name);
    assert.equal(result.format, path.extname(name).slice(1).toLowerCase());
    assert.equal(result.size, bytes.length);
    assert.ok(result.content.includes(name.endsWith('TXT') ? '镜头规范\n保留原声。' : '# 分镜 Skill'));
    assert.equal(result.sha256, createHash('sha256').update(result.content, 'utf8').digest('hex'));
    assert.ok(Number.isFinite(Date.parse(result.importedAt)));
    assert.deepEqual(Object.keys(result).sort(), ['content', 'format', 'importedAt', 'name', 'sha256', 'size']);
    assert.equal(JSON.stringify(result).includes(fixtureRoot), false);
  }
});

test('正确识别 GB18030 及带 BOM 的 UTF-16 文本', async () => {
  const gb = await importSkillDocument(await fixture('gb18030.txt', Buffer.from('d6d0cec420536b696c6c', 'hex')));
  assert.equal(gb.content, '中文 Skill');
  const utf16 = await importSkillDocument(await fixture('utf16.txt', Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('分镜规则\n保持空间连续。', 'utf16le')])));
  assert.equal(utf16.content, '分镜规则\n保持空间连续。');
});

test('真实 DOCX 提取中文多段正文，不执行附带宏/外链或把文本当代码', async () => {
  globalThis.__skillImportExecuted = false;
  const payload = 'globalThis.__skillImportExecuted = true;';
  const bytes = docx(['分镜规范', '只在开头声明 @Image1，正文保持原声。', payload], {
    'word/vbaProject.bin': payload,
    'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://invalid.example/no-network" TargetMode="External"/></Relationships>',
  });
  const result = await importSkillDocument(await fixture('真实规范.docx', bytes));
  assert.equal(result.content, `分镜规范\n\n只在开头声明 @Image1，正文保持原声。\n\n${payload}`);
  assert.equal(result.format, 'docx');
  assert.equal(globalThis.__skillImportExecuted, false);
  delete globalThis.__skillImportExecuted;
});

test('真实文本型 PDF 可抽取文字，内置 JavaScript 不被执行', async () => {
  const result = await importSkillDocument(await fixture('真实规范.pdf', pdf()));
  assert.equal(result.content, 'Storyboard skill: keep the dialogue.');
  assert.equal(result.format, 'pdf');
  assert.equal(globalThis.__skillPdfExecuted, undefined);
});

test('扫描型和空白 PDF 明确要求 OCR，加密 PDF 明确要求解除加密', async () => {
  for (const [name, bytes, code] of [
    ['扫描.pdf', pdf({ imageOnly: true }), 'SKILL_PDF_NO_TEXT'],
    ['空白.pdf', pdf({ text: '' }), 'SKILL_PDF_NO_TEXT'],
    ['加密.pdf', pdf({ encrypted: true }), 'SKILL_PDF_ENCRYPTED'],
  ]) await assert.rejects(importSkillDocument(await fixture(name, bytes)), { code });
});

test('空白 TXT/DOCX、无效编码、二进制伪文本及坏 DOCX/PDF 明确报错', async () => {
  for (const [name, bytes, code] of [
    ['空白.txt', Buffer.from(' \n\t'), 'SKILL_EMPTY_DOCUMENT'],
    ['空白.docx', docx(['']), 'SKILL_EMPTY_DOCUMENT'],
    ['坏编码.txt', Buffer.from([0xEF, 0xBB, 0xBF, 0xC0]), 'SKILL_INVALID_ENCODING'],
    ['伪文本.txt', Buffer.from([0, 1, 2, 3]), 'SKILL_INVALID_TEXT'],
    ['损坏.docx', Buffer.from('not a zip file'), 'SKILL_DOCUMENT_INVALID'],
    ['损坏.pdf', Buffer.from('not a PDF file'), 'SKILL_DOCUMENT_INVALID'],
  ]) await assert.rejects(importSkillDocument(await fixture(name, bytes)), { code });
});

test('普通文件、扩展名和读取权限边界返回可理解错误且不暴露本地路径', async () => {
  const folder = path.join(fixtureRoot, '目录.txt');
  await fs.mkdir(folder);
  await assert.rejects(importSkillDocument(folder), { code: 'SKILL_NOT_FILE' });
  await assert.rejects(importSkillDocument(path.join(fixtureRoot, 'missing.txt')), error => error.code === 'SKILL_READ_FAILED' && !error.message.includes(fixtureRoot));
  await assert.rejects(importSkillDocument(await fixture('不支持.doc', '旧 Word 二进制格式')), { code: 'SKILL_UNSUPPORTED_FORMAT' });
  await assert.rejects(importSkillDocument(null), { code: 'SKILL_INVALID_PATH' });
});

test('文件10MiB和正文200000字符边界显式拒绝超限，绝不静默截断', async () => {
  assert.equal(LIMITS.maxFileBytes, 10 * 1024 * 1024);
  assert.equal(LIMITS.maxTextChars, 200_000);
  const target = await fixture('超大.txt', Buffer.alloc(0));
  await fs.truncate(target, LIMITS.maxFileBytes + 1);
  await assert.rejects(importSkillDocument(target), { code: 'SKILL_FILE_TOO_LARGE' });
  const exact = await importSkillDocument(await fixture('正好.txt', '字'.repeat(LIMITS.maxTextChars)));
  assert.equal(exact.content.length, LIMITS.maxTextChars);
  await assert.rejects(importSkillDocument(await fixture('正文超限.md', '字'.repeat(LIMITS.maxTextChars + 1))), { code: 'SKILL_TEXT_TOO_LARGE' });
  await assert.rejects(importSkillDocument(await fixture('正文超限.docx', docx(['字'.repeat(LIMITS.maxTextChars + 1)]))), { code: 'SKILL_TEXT_TOO_LARGE' });
  await assert.rejects(importSkillDocument(await fixture('正文超限.pdf', pdf({ text: 'x'.repeat(LIMITS.maxTextChars + 1) }))), { code: 'SKILL_TEXT_TOO_LARGE' });
});
