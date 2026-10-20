const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = '2.1';
const SKILL_PATH = path.join(__dirname, 'skills', 'storyboard-v2.1.txt');
const skillBytes = fs.readFileSync(SKILL_PATH);
const SKILL_TEXT = skillBytes.toString('utf8');
const SKILL_SHA256 = crypto.createHash('sha256').update(skillBytes).digest('hex');
const AUDIT_RULE_IDS = Object.freeze(
  Object.entries({ A: 4, B: 5, C: 9, D: 10, E: 12, F: 8, G: 7, H: 5 })
    .flatMap(([group, count]) => Array.from({ length: count }, (_, index) => `${group}${index + 1}`)),
);
const RULE_LABELS = Object.freeze(Object.fromEntries(
  [...SKILL_TEXT.matchAll(/^([A-H]\d+)\.\s+(.+)$/gm)]
    .map((match) => [match[1], match[2].trim()]),
));

if (AUDIT_RULE_IDS.some((id) => !RULE_LABELS[id]) || Object.keys(RULE_LABELS).length !== AUDIT_RULE_IDS.length) {
  throw new Error('分镜 Skill v2.1 的 60 项审计规则不完整，已停止生成。');
}

module.exports = { VERSION, SKILL_PATH, SKILL_TEXT, SKILL_SHA256, AUDIT_RULE_IDS, RULE_LABELS };
