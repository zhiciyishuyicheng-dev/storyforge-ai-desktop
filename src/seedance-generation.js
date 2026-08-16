export const SEEDANCE_GENERATION_MODE_BATCH = 'batch';
export const SEEDANCE_GENERATION_MODE_CONFIRM = 'confirm';

export function normalizeSeedanceGenerationMode(value) {
  return value === SEEDANCE_GENERATION_MODE_CONFIRM
    ? SEEDANCE_GENERATION_MODE_CONFIRM
    : SEEDANCE_GENERATION_MODE_BATCH;
}

export function selectSeedanceGenerationIndexes(items, { indexes = null, force = false, mode = SEEDANCE_GENERATION_MODE_BATCH } = {}) {
  const list = Array.isArray(items) ? items : [];
  const explicit = Array.isArray(indexes);
  const candidates = explicit
    ? indexes.filter((index, position) => Number.isInteger(index) && index >= 0 && index < list.length && indexes.indexOf(index) === position)
    : list.map((_item, index) => index).filter((index) => force || list[index]?.status !== 'success');
  const normalizedMode = normalizeSeedanceGenerationMode(mode);
  return {
    candidates,
    requested: normalizedMode === SEEDANCE_GENERATION_MODE_CONFIRM ? candidates.slice(0, 1) : candidates,
    reset: force ? candidates : [],
  };
}
