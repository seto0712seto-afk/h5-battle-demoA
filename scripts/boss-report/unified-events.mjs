export const UNIFIED_EVENT_TYPES = [
  'battle_start', 'battle_end', 'round_start', 'round_end', 'action_start', 'action_end',
    'skill_confirm', 'skill_resolve', 'damage', 'heal', 'shield_gain', 'shield_absorb', 'shield_consume',
  'resource_gain', 'resource_spend', 'status_apply', 'status_remove', 'target_lock',
  'telegraph_start', 'telegraph_end', 'mechanic_window_start', 'mechanic_window_end',
  'unit_death', 'replacement_scheduled', 'replacement_completed', 'position_change',
  'swap', 'phase_change', 'boss_mechanic_trigger', 'ai_decision'
];

const TYPE_SET = new Set(UNIFIED_EVENT_TYPES);

export function normalizeTraceEvents(trace) {
  const normalized = [];
  const battleId = String(trace.battleId ?? trace.seed);
  let timestampOrder = 0;
  let actionIndex = 0;
  let currentRound = 0;
  let currentAction = null;

  const emit = (eventType, raw = {}, override = {}) => {
    const event = unifiedEvent({
      battleId,
      seed: trace.seed,
      round: override.round ?? raw.round ?? currentRound,
      actionIndex: override.actionIndex ?? currentAction?.actionIndex ?? actionIndex,
      eventType,
      sourceId: override.sourceId ?? sourceId(raw),
      targetId: override.targetId ?? targetId(raw),
      targetPosition: override.targetPosition ?? raw.targetRow ?? raw.rowAfter ?? null,
      skillId: override.skillId ?? raw.skillId ?? currentAction?.skillId ?? null,
      mechanicId: override.mechanicId ?? null,
      value: override.value ?? eventValue(eventType, raw),
      resourceCost: override.resourceCost ?? raw.actualCost ?? raw.spent ?? 0,
      statusId: override.statusId ?? raw.statusId ?? null,
      phaseId: override.phaseId ?? raw.phaseId ?? null,
      timestampOrder: ++timestampOrder,
      metadata: { ...raw, ...(override.metadata ?? {}) }
    });
    normalized.push(event);
    return event;
  };

  const endAction = () => {
    if (!currentAction) return;
    if (currentAction.skillId && currentAction.side === 'player' && !currentAction.resolved) {
      emit('skill_resolve', {}, {
        round: currentAction.round,
        actionIndex: currentAction.actionIndex,
        sourceId: currentAction.sourceId,
        skillId: currentAction.skillId,
        metadata: { side: 'player', synthesized: true }
      });
    }
    emit('action_end', {}, {
      round: currentAction.round,
      actionIndex: currentAction.actionIndex,
      sourceId: currentAction.sourceId,
      metadata: { side: currentAction.side, synthesized: true }
    });
    currentAction = null;
  };

  const enterRound = (round) => {
    if (!round || round === currentRound) return;
    if (currentRound > 0) emit('round_end', {}, { round: currentRound, metadata: { synthesized: true } });
    currentRound = round;
    emit('round_start', {}, { round, metadata: { synthesized: true } });
  };

  for (const raw of trace.events ?? []) {
    if (raw.type !== 'battle_start') {
      const nextRound = (raw.round ?? currentRound) || 1;
      if (currentAction && currentRound > 0 && nextRound !== currentRound) endAction();
      enterRound(nextRound);
    }
    if (raw.type === 'action_start') {
      endAction();
      actionIndex += 1;
      currentAction = { actionIndex, round: raw.round ?? currentRound, sourceId: raw.unitId, side: raw.side, skillId: null, resolved: false };
      emit('action_start', raw, { sourceId: raw.unitId, metadata: { ...raw, sourceSide: raw.side } });
      continue;
    }
    if (raw.type === 'battle_start') {
      emit('battle_start', raw, { round: 0, actionIndex: 0 });
      continue;
    }
    if (raw.type === 'skill_confirmed') {
      if (currentAction) currentAction.skillId = raw.skillId;
      emit('skill_confirm', raw, { sourceId: raw.actorId, targetId: raw.targetId ?? null });
      continue;
    }
    if (raw.type === 'skill_resolved') {
      if (currentAction) {
        currentAction.skillId = raw.skillId;
        currentAction.resolved = true;
      }
      emit('skill_resolve', raw, { sourceId: raw.actorId, targetId: raw.targetId ?? raw.targetIds?.[0] ?? null });
      continue;
    }
    if (raw.type === 'ai_decision') {
      emit('ai_decision', raw, { sourceId: raw.actorId, metadata: { ...raw, sourceSide: 'player' } });
      continue;
    }
    if (raw.type === 'damage') {
      emit('damage', raw, { sourceId: raw.sourceId, targetId: raw.targetId, targetPosition: raw.targetRow ?? null });
      if ((raw.absorbed ?? 0) > 0) emit('shield_absorb', raw, { value: raw.absorbed });
      continue;
    }
    if (raw.type === 'healing') {
      emit('heal', raw, { sourceId: raw.actorId, targetId: raw.targetId, value: raw.effective });
      continue;
    }
    if (raw.type === 'shield') {
      emit('shield_gain', raw, { sourceId: raw.actorId, targetId: raw.targetId, value: raw.granted });
      continue;
    }
    if (raw.type === 'shield_absorbed') {
      emit('shield_absorb', raw, {
        sourceId: raw.sourceUnitId,
        targetId: raw.targetId,
        skillId: raw.sourceSkillId ?? null,
        value: raw.absorbedDamage
      });
      continue;
    }
    if (raw.type === 'shield_consumed') {
      emit('shield_consume', raw, {
        sourceId: raw.sourceUnitId,
        targetId: raw.targetId,
        skillId: raw.consumedBySkillId ?? raw.sourceSkillId ?? null,
        value: raw.shieldConsumed
      });
      continue;
    }
    if (raw.type === 'status_changed') {
      emit(raw.change === 'remove' ? 'status_remove' : 'status_apply', raw, {
        sourceId: raw.sourceUnitId ?? null,
        targetId: raw.targetUnitId,
        skillId: raw.sourceSkillId ?? null,
        statusId: raw.statusId,
        value: raw.stackDelta ?? raw.stackAfter ?? 0
      });
      continue;
    }
    if (raw.type === 'energy') {
      if ((raw.spent ?? 0) > 0) emit('resource_spend', raw, { value: raw.spent, resourceCost: raw.spent });
      if ((raw.attemptedGain ?? 0) > 0 || (raw.gained ?? 0) > 0) emit('resource_gain', raw, { value: raw.gained ?? 0, resourceCost: 0 });
      continue;
    }
    if (raw.type === 'switch') {
      emit('swap', raw, { sourceId: raw.outgoingId ?? null, targetId: raw.incomingId, targetPosition: raw.rowAfter });
      continue;
    }
    if (raw.type === 'row_switch') {
      emit('position_change', raw, { sourceId: raw.unitId, targetId: raw.unitId, targetPosition: raw.rowAfter });
      continue;
    }
    if (raw.type === 'replacement') {
      if (raw.status === 'scheduled') emit('replacement_scheduled', raw, { targetId: raw.defeatedUnitId ?? null });
      if (raw.status === 'completed') emit('replacement_completed', raw, { targetId: raw.incomingId ?? null });
      continue;
    }
    if (raw.type === 'boss_skill') {
      if (raw.telegraph) {
        emit('telegraph_start', raw, { sourceId: raw.enemyId, targetId: raw.targetIds?.[0] ?? raw.lockedTargetId ?? null });
        if (raw.targetIds?.length || raw.lockedSlotIndex !== undefined || raw.lockedTargetId) {
          emit('target_lock', raw, { sourceId: raw.enemyId, targetId: raw.targetIds?.[0] ?? raw.lockedTargetId ?? null });
        }
      } else {
        if (raw.source === 'forced_followup') emit('telegraph_end', raw, { sourceId: raw.enemyId, targetId: raw.targetIds?.[0] ?? null });
        emit('skill_resolve', raw, { sourceId: raw.enemyId, targetId: raw.targetIds?.[0] ?? null, metadata: { ...raw, sourceSide: 'enemy' } });
      }
      continue;
    }
    if (raw.type === 'defeated') {
      emit('unit_death', raw, { sourceId: raw.sourceId, targetId: raw.unitId, metadata: { ...raw, targetSide: raw.side } });
      continue;
    }
    if (raw.type === 'battle_end') {
      endAction();
      emit('battle_end', raw);
    }
  }

  endAction();
  if (currentRound > 0 && normalized.at(-1)?.eventType !== 'round_end') {
    emit('round_end', {}, { round: currentRound, metadata: { synthesized: true } });
  }
  return normalized;
}

export function unifiedEvent(value) {
  const event = {
    battleId: String(value.battleId),
    seed: value.seed,
    round: Number(value.round ?? 0),
    actionIndex: Number(value.actionIndex ?? 0),
    eventType: value.eventType,
    sourceId: value.sourceId ?? null,
    targetId: value.targetId ?? null,
    targetPosition: value.targetPosition ?? null,
    skillId: value.skillId ?? null,
    mechanicId: value.mechanicId ?? null,
    value: Number(value.value ?? 0),
    resourceCost: Number(value.resourceCost ?? 0),
    statusId: value.statusId ?? null,
    phaseId: value.phaseId ?? null,
    timestampOrder: Number(value.timestampOrder ?? 0),
    metadata: value.metadata ?? {}
  };
  if (!TYPE_SET.has(event.eventType)) throw new Error(`Unknown unified event type: ${event.eventType}`);
  return event;
}

export function validateUnifiedEvents(events) {
  const issues = [];
  let previousOrder = -1;
  events.forEach((event, index) => {
    for (const key of ['battleId', 'seed', 'round', 'actionIndex', 'eventType', 'sourceId', 'targetId', 'targetPosition', 'skillId', 'mechanicId', 'value', 'resourceCost', 'statusId', 'phaseId', 'timestampOrder', 'metadata']) {
      if (!(key in event)) issues.push({ index, issue: `missing:${key}` });
    }
    if (!TYPE_SET.has(event.eventType)) issues.push({ index, issue: `eventType:${event.eventType}` });
    if (event.timestampOrder <= previousOrder) issues.push({ index, issue: 'timestampOrder:not-increasing' });
    previousOrder = event.timestampOrder;
  });
  return issues;
}

export function matchesEvent(event, selector) {
  if (!selector) return false;
  if (selector.eventType && event.eventType !== selector.eventType) return false;
  if (selector.skillIds?.length && !selector.skillIds.includes(event.skillId)) return false;
  if (selector.sourceSide && event.metadata.sourceSide !== selector.sourceSide && event.metadata.side !== selector.sourceSide) return false;
  if (selector.targetSide && event.metadata.targetSide !== selector.targetSide) return false;
  if (selector.statusIds?.length && !selector.statusIds.includes(event.statusId)) return false;
  if (selector.phaseIds?.length && !selector.phaseIds.includes(event.phaseId)) return false;
  if (selector.metadataEquals && Object.entries(selector.metadataEquals).some(([key, value]) => event.metadata[key] !== value)) return false;
  return true;
}

function sourceId(raw) {
  return raw.sourceId ?? raw.actorId ?? raw.enemyId ?? raw.unitId ?? null;
}

function targetId(raw) {
  return raw.targetId ?? raw.targetIds?.[0] ?? raw.incomingId ?? null;
}

function eventValue(type, raw) {
  if (type === 'damage') return raw.actual ?? 0;
  if (type === 'heal') return raw.effective ?? 0;
  if (type === 'shield_gain') return raw.granted ?? 0;
  if (type === 'shield_absorb') return raw.absorbed ?? 0;
  if (type === 'shield_consume') return raw.shieldConsumed ?? 0;
  if (type === 'resource_gain') return raw.gained ?? 0;
  if (type === 'resource_spend') return raw.spent ?? raw.actualCost ?? 0;
  return raw.value ?? raw.power ?? 0;
}
