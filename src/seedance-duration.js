export const SEEDANCE_MIN_DURATION = 4;
export const SEEDANCE_MAX_DURATION = 15;

const CHINESE_DIGITS = {
  '零': 0,
  '一': 1,
  '二': 2,
  '两': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9,
};
const DURATION_VALUE_PATTERN = '(\\d{1,2}(?:\\.\\d+)?|[零一二两三四五六七八九十]{1,3})';

function chineseNumber(value) {
  const text = String(value || '').trim();
  if (!text) return Number.NaN;
  if (text === '十') return 10;
  if (text.includes('十')) {
    const [tens, units] = text.split('十');
    const tensValue = tens ? CHINESE_DIGITS[tens] : 1;
    const unitsValue = units ? CHINESE_DIGITS[units] : 0;
    if (tensValue === undefined || unitsValue === undefined) return Number.NaN;
    return (tensValue * 10) + unitsValue;
  }
  return CHINESE_DIGITS[text] ?? Number.NaN;
}

function numericValue(value) {
  if (typeof value === 'number') return value;
  const text = String(value ?? '').trim();
  if (!text) return Number.NaN;
  const arabic = text.match(/\d{1,2}(?:\.\d+)?/);
  if (arabic) return Number(arabic[0]);
  const chinese = text.match(/[零一二两三四五六七八九十]{1,3}/);
  return chinese ? chineseNumber(chinese[0]) : Number.NaN;
}

export function normalizeSeedanceDuration(value, fallback = 5) {
  const fallbackValue = numericValue(fallback);
  const parsed = numericValue(value);
  const duration = Number.isFinite(parsed) ? parsed : Number.isFinite(fallbackValue) ? fallbackValue : 5;
  return Math.max(SEEDANCE_MIN_DURATION, Math.min(SEEDANCE_MAX_DURATION, Math.ceil(duration)));
}

export function extractSeedanceDuration(prompt, fallback = 5) {
  const text = String(prompt || '');
  if (!text.trim()) return normalizeSeedanceDuration(fallback);

  const declaredPatterns = [
    new RegExp(`(?:视频总时长|总时长|视频时长|时长)[：:为是\\s]*${DURATION_VALUE_PATTERN}\\s*秒`, 'i'),
    new RegExp(`生成[^。；\\n]{0,24}?${DURATION_VALUE_PATTERN}\\s*秒`, 'i'),
    new RegExp(`${DURATION_VALUE_PATTERN}\\s*秒(?:的|竖屏|短剧|视频)`, 'i'),
  ];
  for (const pattern of declaredPatterns) {
    const match = text.match(pattern);
    if (match) return normalizeSeedanceDuration(match[1], fallback);
  }

  const rangePattern = new RegExp(`${DURATION_VALUE_PATTERN}\\s*(?:至|到|-|—|~|～)\\s*${DURATION_VALUE_PATTERN}\\s*秒`, 'gi');
  const endpoints = [...text.matchAll(rangePattern)].map((match) => numericValue(match[2])).filter(Number.isFinite);
  if (endpoints.length) return normalizeSeedanceDuration(Math.max(...endpoints), fallback);

  return normalizeSeedanceDuration(fallback);
}

export function resolveSeedanceDuration(explicitDuration, prompt, fallback = 5) {
  if (Number.isFinite(numericValue(explicitDuration))) return normalizeSeedanceDuration(explicitDuration, fallback);
  return extractSeedanceDuration(prompt, fallback);
}
