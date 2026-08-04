const SOURCE_LABELS = {
  baseScore: '基础评分',
  genericRule: '通用规则加分',
  bossSpecific: 'Boss专属加分',
  resource: '资源加分',
  survival: '生存加分',
  antiStall: '防拖延加分',
  delayRisk: '延迟风险修正'
};

export function analyzeAiScoreSources(battles) {
  const decisions = battles.flatMap((battle) => battle.events.filter((event) => event.eventType === 'ai_decision').map((event) => ({ battle, event, ...event.metadata })));
  const sources = Object.keys(SOURCE_LABELS).map((sourceId) => sourceImpact(decisions, sourceId));
  return {
    decisions: decisions.length,
    sources,
    missingSnapshots: battles.filter((battle) => !battle.events.some((event) => event.eventType === 'ai_decision')).length,
    sourceLabels: SOURCE_LABELS
  };
}

export function mergeAiScoreSources(summaries) {
  const sources = Object.keys(SOURCE_LABELS).map((sourceId) => {
    const rows = summaries.map((summary) => summary.sources.find((source) => source.sourceId === sourceId)).filter(Boolean);
    const influencedActions = rows.reduce((sum, row) => sum + row.influencedActions, 0);
    const changedFinalChoice = rows.reduce((sum, row) => sum + row.changedFinalChoice, 0);
    const decisions = summaries.reduce((sum, summary) => sum + summary.decisions, 0);
    return {
      sourceId,
      displayName: SOURCE_LABELS[sourceId],
      influencedActions,
      changedFinalChoice,
      changeRate: decisions ? changedFinalChoice / decisions : 0,
      examples: rows.flatMap((row) => row.examples).slice(0, 5)
    };
  });
  return {
    decisions: summaries.reduce((sum, summary) => sum + summary.decisions, 0),
    sources,
    missingSnapshots: summaries.reduce((sum, summary) => sum + summary.missingSnapshots, 0),
    sourceLabels: SOURCE_LABELS
  };
}

function sourceImpact(decisions, sourceId) {
  let influencedActions = 0;
  let changedFinalChoice = 0;
  const examples = [];
  for (const decision of decisions) {
    const candidates = decision.candidates ?? [];
    const selected = candidates.find((candidate) => sameChoice(candidate, decision.selected)) ?? decision.selected;
    if (!selected) continue;
    const selectedContribution = Number(selected.scoreSources?.[sourceId] ?? 0);
    if (selectedContribution !== 0) influencedActions += 1;
    if (candidates.length < 2) continue;
    const withoutSource = [...candidates].map((candidate) => ({ candidate, score: Number(candidate.score ?? 0) - Number(candidate.scoreSources?.[sourceId] ?? 0) })).sort((a, b) => b.score - a.score)[0]?.candidate;
    if (withoutSource && !sameChoice(withoutSource, decision.selected)) {
      changedFinalChoice += 1;
      if (examples.length < 5) examples.push({ seed: decision.battle.seed, round: decision.round, actorId: decision.actorId, selected: choiceKey(decision.selected), withoutSource: choiceKey(withoutSource), contribution: selectedContribution });
    }
  }
  return {
    sourceId,
    displayName: SOURCE_LABELS[sourceId],
    influencedActions,
    changedFinalChoice,
    changeRate: decisions.length ? changedFinalChoice / decisions.length : 0,
    examples
  };
}

function sameChoice(left, right) {
  return choiceKey(left) === choiceKey(right);
}

function choiceKey(choice) {
  if (!choice) return 'none';
  return `${choice.action ?? 'skill'}:${choice.skillId ?? ''}:${choice.targetId ?? ''}`;
}
