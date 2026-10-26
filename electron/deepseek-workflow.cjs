const { createHash } = require('node:crypto');
const {
  makeSystemPrompt, makeAuditSystemPrompt, makeUserPrompt, makeAuditPrompt,
  makeRepairPrompt, normalizeContext,
} = require('./deepseek-prompt.cjs');
const defaultPolicy = require('./storyboard-policy.cjs');
const { VERSION, SKILL_SHA256, SKILL_TEXT } = require('./storyboard-skill.cjs');
const { stageSkillReferences } = require('./stage-skills.cjs');
const { createWorkflowTiming } = require('./workflow-timing.cjs');
const { ensureStoryboardOutline, migrateLegacyOutline } = require('./storyboard-outline.cjs');
const { STAGES, normalizeConfirmedOutline, confirmedOutlineErrors, stageContext, runIndependentStage } = require('./generation-stages.cjs');

function workflowError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function issueText(errors) {
  return errors.slice(0, 3).map((item) => typeof item === 'string' ? item : item.message || item.code || '检查未通过').join('；');
}

// Audit failures may be explicitly ignored after the one user-authorized repair.
// Local content checks also become warnings; only unusable data stays blocked.
function createWorkflowRunner({ request, policy = defaultPolicy, maxRepairs = 1, onProgress = () => {}, now = Date.now,
  provider = 'deepseek', model = 'deepseek-flash', reasoningEffort = 'high' } = {}) {
  if (typeof request !== 'function') throw new TypeError('Workflow request is required');
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 1) throw new TypeError('maxRepairs must be 0 or 1');

  return async function generateWorkflow(script, options = {}) {
    if (typeof script !== 'string' || !script.trim()) throw workflowError('剧本不能为空。', 'EMPTY_SCRIPT');
    let context = normalizeContext(options);
    if (options?.stage !== undefined && !STAGES.has(options.stage)) throw workflowError('无效的生成步骤。', 'INVALID_WORKFLOW_STAGE');
    if (context.stage === 'outline' || context.stage === 'assets') return runIndependentStage(script, context, { request, maxRepairs, onProgress, now, provider, model, reasoningEffort });
    if (context.stage === 'storyboard') {
      const inputSha256 = context.confirmedOutline?.verification?.inputSha256;
      if (typeof inputSha256 === 'string' && inputSha256 !== createHash('sha256').update(script).digest('hex')) throw workflowError('原始剧本已更改，请先重新生成并确认分镜大纲。', 'STALE_CONFIRMED_OUTLINE');
      context = stageContext({ ...context, confirmedOutline: normalizeConfirmedOutline(context.confirmedOutline, context) });
    }
    const originalScript = script;
    const records = [];
    const timing = createWorkflowTiming({ script, onProgress, now, maxRepairs, provider, model, reasoningEffort,
      skillChars: (context.stageSkills.storyboard?.content.length ?? SKILL_TEXT.length) + (context.stageSkills.assets?.content.length || 0) });
    const publishCandidate = (data, audit, auditSummary, repairCount, auditIgnored = false) => {
      if (context.stage === 'storyboard') data.outline = structuredClone(context.confirmedOutline);
      ensureStoryboardOutline(data);
      data.storyboard.skillVersion = VERSION;
      data.storyboard.unifiedSuffix = '';
      data.storyboard.auditSummary = auditSummary;
      data.storyboard.auditRecord = structuredClone(audit);
      data.storyboard.verification = {
        skillVersion: VERSION, skillSha256: context.stageSkills.storyboard?.sha256 || SKILL_SHA256,
        builtinSkillApplied: !context.stageSkills.storyboard,
        auditBasis: context.stageSkills.storyboard ? '用户 Skill' : '内置 Skill',
        stageSkills: stageSkillReferences(context.stageSkills),
        generation: { provider, model: records.at(-1)?.model || model, reasoningEffort },
        inputSha256: createHash('sha256').update(originalScript).digest('hex'),
        repairCount, requestCount: records.length, scope: auditSummary.scope || '文本与计划',
        auditIgnored, auditPassed: !auditIgnored, auditStatus: auditSummary.finalStatus,
        verifiedAt: new Date().toISOString(),
      };
      const usageRecords = records.filter(record => record.usage);
      const usage = usageRecords.length ? {
        prompt_tokens: usageRecords.reduce((sum, record) => sum + (Number(record.usage.prompt_tokens) || 0), 0),
        completion_tokens: usageRecords.reduce((sum, record) => sum + (Number(record.usage.completion_tokens) || 0), 0),
        total_tokens: usageRecords.reduce((sum, record) => sum + (Number(record.usage.total_tokens) || 0), 0),
      } : null;
      const progress = timing.complete({ auditIgnored });
      return { ...(context.stage ? { stage: context.stage } : {}), data, usage, provider, reasoningEffort, model: records.at(-1)?.model || model, progress };
    };
    const invoke = async (buildMessages, phase, repairCount) => {
      const preparationStarted = timing.prepare();
      const messages = buildMessages();
      timing.prepared(preparationStarted, messages);
      const id = timing.beginRequest(phase, repairCount, messages);
      try {
        const result = await request(messages, { phase, onProgress: event => timing.updateRequest(id, event) });
        if (!result || typeof result !== 'object') throw workflowError('模型返回了无效响应，未交付候选分镜。', 'INVALID_MODEL_RESPONSE');
        timing.endRequest(id, result.timing);
        records.push({ phase, usage: result.usage || null, model: result.model || model });
        return result;
      } catch (error) { timing.endRequest(id, error.timing, error); throw error; }
    };

    try {
      let response = await invoke(() => [
        { role: 'system', content: makeSystemPrompt(context) },
        { role: 'user', content: makeUserPrompt(originalScript, context) },
      ], 'candidate', 0);
      let repairCount = 0;
      let lastErrors = [];

      for (;;) {
        const candidate = response.data && typeof response.data === 'object' && !Array.isArray(response.data)
          ? migrateLegacyOutline(structuredClone(response.data)) : null;
        // No model-supplied pass marker or fabricated retry count is authoritative.
        if (candidate?.storyboard) {
          delete candidate.storyboard.auditSummary;
          delete candidate.storyboard.auditRecord;
          delete candidate.storyboard.verification;
        }
        timing.validating(repairCount);
        let validationStarted = now();
        const validation = policy.validateCandidate(candidate, { script: originalScript, context });
        timing.addValidation(validationStarted);
        const confirmedErrors = confirmedOutlineErrors(candidate, context);
        const localErrors = [...validation.errors, ...confirmedErrors];
        if (response.truncated) localErrors.push({ code: 'TRUNCATED_RESPONSE', message: '候选被输出长度上限截断，不能缩减指定范围后伪装完整交付。' });
        if (!candidate) localErrors.push({ code: 'INVALID_JSON', message: '候选不是有效的工作流 JSON，必须重新生成。' });
        let audit = null;
        let gate = { valid: false, errors: [] };

        if (candidate && !response.truncated) {
          const reviewed = await invoke(() => [
            { role: 'system', content: makeAuditSystemPrompt(context) },
            { role: 'user', content: makeAuditPrompt(originalScript, candidate, { context, localErrors }) },
          ], 'audit', repairCount);
          audit = reviewed.truncated ? null : reviewed.data;
          timing.validating(repairCount);
          validationStarted = now();
          gate = policy.validateAudit(candidate, audit, { script: originalScript, context, localErrors });
          timing.addValidation(validationStarted);
        }

        const blockNos = Array.isArray(candidate?.storyboard?.shots)
          ? candidate.storyboard.shots.map((block) => String(block?.no ?? '')) : [];
        const accepted = gate.acceptedBlockNos || [];
        const allPublishedBlocksAccepted = blockNos.length > 0 && accepted.length === blockNos.length
          && blockNos.every((no, index) => accepted[index] === no);
        if (validation.valid && !localErrors.length && gate.valid && allPublishedBlocksAccepted) {
          return publishCandidate(candidate, audit, policy.buildAuditSummary(candidate, audit, { repairCount, context }), repairCount);
        }

        if (gate.blocked === true && !accepted.length && gate.blockers?.length) {
          throw workflowError(`分镜需要补充信息：${gate.blockers.map((blocker) => blocker.question || blocker.missingInformation || blocker.reason).join('；')}`, 'STORYBOARD_BLOCKED', { blockers: gate.blockers });
        }
        lastErrors = [...localErrors, ...(gate.errors || [])];
        if (candidate && !allPublishedBlocksAccepted) lastErrors.push({ code: 'UNAPPROVED_BLOCKS', message: '正式结果只能包含独立审计通过的生成块；受阻内容须移至阻塞与顺延记录后重新审计。' });
        if (!lastErrors.length) lastErrors.push({ code: 'AUDIT_NOT_PASSED', message: '独立审计未确认全部适用检查通过。' });
        if (repairCount >= maxRepairs) {
          if (repairCount >= 1 && !response.truncated && !confirmedErrors.length && policy.canPublishIgnoredCandidate(candidate, { context })
            && !policy.hasGenuineBlockers(candidate, audit)) {
            return publishCandidate(candidate, audit, policy.buildIgnoredAuditSummary(candidate, audit, {
              repairCount, context, issues: lastErrors,
            }), repairCount, true);
          }
          throw workflowError(`分镜审计未通过：已自动回炉 ${repairCount} 次，仍有检查未通过，未交付候选。${issueText(lastErrors)}`, 'STORYBOARD_AUDIT_FAILED', { repairCount, issues: lastErrors });
        }

        repairCount += 1;
        response = await invoke(() => [
          { role: 'system', content: makeSystemPrompt(context) },
          { role: 'user', content: makeRepairPrompt(originalScript, candidate || { invalidResponse: response.rawContent || '' }, {
            context, localErrors: lastErrors, audit, attempt: repairCount,
          }) },
        ], 'repair', repairCount);
      }
    } catch (error) { timing.fail(error); throw error; }
  };
}

module.exports = { createWorkflowRunner };
