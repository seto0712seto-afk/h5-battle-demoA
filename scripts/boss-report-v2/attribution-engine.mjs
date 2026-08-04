import { matchesV2Event } from './mechanic-dsl.mjs';

const DIRECT_OUTCOME_TYPES = new Set(['damage', 'shield_absorb', 'unit_death', 'replacement_scheduled', 'replacement_completed']);

export function analyzeMechanicWindows({ battle, bossMechanicConfig, metricRegistry }) {
  const windows = bossMechanicConfig.mechanics.flatMap((mechanic) => buildWindowsForMechanic(battle, mechanic));
  attachMatchedBaselines(battle, windows);
  const attributions = attributeOverlaps(battle.events, windows, bossMechanicConfig.attribution);
  const attributionByEvent = new Map(attributions.map((item) => [item.eventId, item]));
  const postAttributions = attributePostImpact(battle.events, windows);
  const postWeights = postWeightsByMechanic(postAttributions);
  for (const window of windows) finalizeWindow(window, battle, metricRegistry, attributionByEvent, postWeights.get(window.mechanicId));
  const events = materializeWindowEvents(battle.events, windows);
  const indexById = new Map(events.map((event) => [event.eventId, event.eventIndex]));
  windows.forEach((window) => {
    window.startEventIndex = indexById.get(window.startEventId);
    window.endEventIndex = indexById.get(window.endEventId);
  });
  return {
    events,
    windows,
    attributions: [...attributions, ...postAttributions],
    overlap: summarizeOverlap([...attributions, ...postAttributions], battle.battleId),
    overlapConfidenceThreshold: bossMechanicConfig.attribution.overlapConfidenceThreshold
  };
}

function buildWindowsForMechanic(battle, mechanic) {
  const windows = [];
  let open = null;
  const endSelector = mechanic.window.end === 'resolve_event' ? mechanic.resolve : mechanic.window.endSelector;
  for (const event of battle.events) {
    if (open && matchesV2Event(event, mechanic.resolve)) {
      open.resolveEventId = event.eventId;
      open.resolveEventIndex = event.eventIndex;
    }
    if (open && matchesV2Event(event, endSelector) && event.eventIndex > open.startEventIndex) {
      closeWindow(open, event, 'configured_end');
      open = null;
    }
    if (matchesV2Event(event, mechanic.trigger)) {
      if (open) closeWindow(open, event, 'superseded');
      const boundary = mechanic.window.start === 'trigger_action_start'
        ? [...battle.events].reverse().find((candidate) => candidate.eventType === 'action_start' && candidate.actionIndex === event.actionIndex && candidate.eventIndex <= event.eventIndex)
        : event;
      open = createWindow(battle, mechanic, windows.length + 1, event, boundary ?? event);
      windows.push(open);
      if (matchesV2Event(event, mechanic.resolve)) {
        open.resolveEventId = event.eventId;
        open.resolveEventIndex = event.eventIndex;
      }
    }
    if (event.eventType === 'battle_end' && open) {
      closeWindow(open, event, open.resolveEventId ? 'battle_end_after_resolve' : 'battle_end_unresolved');
      open = null;
    }
  }
  if (open) closeWindow(open, battle.events.at(-1), 'trace_end_unresolved');
  return windows;
}

function createWindow(battle, mechanic, ordinal, trigger, boundary) {
  return {
    windowId: `${battle.battleId}:window:${mechanic.mechanicId}:${ordinal}`,
    battleId: battle.battleId,
    mechanicId: mechanic.mechanicId,
    displayName: mechanic.displayName,
    mechanicType: mechanic.mechanicType,
    priority: mechanic.priority ?? 0,
    config: mechanic,
    triggerEventId: trigger.eventId,
    startEventId: boundary.eventId,
    startEventIndex: boundary.eventIndex,
    startRound: boundary.round,
    resolveEventId: null,
    resolveEventIndex: null,
    endEventId: null,
    endEventIndex: null,
    endRound: null,
    resolution: null,
    lockedTargetId: trigger.targetId ?? trigger.metadata?.lockedTargetId ?? trigger.metadata?.targetIds?.[0] ?? null,
    lockedSlotIndex: trigger.metadata?.lockedSlotIndex ?? trigger.metadata?.lockedOriginSlotIndex ?? null,
    legalActionCount: 0,
    responseClassification: 'no_opportunity',
    effectiveResponses: [],
    invalidResponses: [],
    incidentalActions: [],
    responseTags: [],
    outcomes: {},
    postImpact: {}
  };
}

function attachMatchedBaselines(battle, windows) {
  const actions = collectPlayerActions(battle.events);
  for (const window of windows) {
    const matching = window.config.baseline?.matching ?? [];
    const windowFeatures = actionFeatures(
      actions.find((action) => window.startEventIndex >= action.startIndex && window.startEventIndex <= action.endIndex)?.startEvent ??
      battle.events.find((event) => event.eventId === window.startEventId)
    );
    const candidates = actions.filter((action) => {
      if (windows.some((candidate) => action.startIndex >= candidate.startEventIndex && action.startIndex <= candidate.endEventIndex)) return false;
      const features = actionFeatures(action.startEvent);
      return matching.every((field) => features[field] === windowFeatures[field]);
    });
    const matched = candidates.map((action) => ({
      rootActionId: action.rootActionId,
      round: action.startEvent.round,
      responseTags: [...responseTags(window, action.events)]
    }));
    const effective = matched.filter((action) => window.config.validResponses.some((response) =>
      response.requiredTags.every((tag) => action.responseTags.includes(tag))
    ));
    window.baselineMatching = matching;
    window.baselineCandidateCount = matched.length;
    window.baselineEffectiveCount = effective.length;
    window.baselineResponseRate = matched.length ? effective.length / matched.length : 0;
  }
}

function collectPlayerActions(events) {
  const groups = new Map();
  for (const event of events) {
    const sourceSide = event.metadata?.sourceSide ?? event.metadata?.side;
    if (sourceSide !== 'player' || !event.rootActionId) continue;
    if (!groups.has(event.rootActionId)) groups.set(event.rootActionId, []);
    groups.get(event.rootActionId).push(event);
  }
  return [...groups.entries()].flatMap(([rootActionId, actionEvents]) => {
    const ordered = [...actionEvents].sort((a, b) => a.eventIndex - b.eventIndex);
    const startEvent = ordered.find((event) => event.eventType === 'action_start');
    return startEvent ? [{ rootActionId, startEvent, events: ordered, startIndex: ordered[0].eventIndex, endIndex: ordered.at(-1).eventIndex }] : [];
  });
}

function actionFeatures(event) {
  const slots = event?.metadata?.playerSlots ?? event?.metadata?.slots ?? [];
  const aliveOnField = Array.isArray(slots) ? slots.filter((slot) => Number(slot?.hp ?? 0) > 0).length : 0;
  const reserves = event?.metadata?.reserveIds ?? [];
  const aliveCount = aliveOnField + (Array.isArray(reserves) ? reserves.length : 0);
  const resource = Number(event?.resourceBefore ?? event?.resourceAfter ?? event?.metadata?.mana ?? 0);
  return {
    alive_count: aliveCount,
    resource_band: resource <= 2 ? 'low' : resource <= 5 ? 'mid' : 'high'
  };
}

function closeWindow(window, event, resolution) {
  window.endEventId = event?.eventId ?? window.startEventId;
  window.endEventIndex = event?.eventIndex ?? window.startEventIndex;
  window.endRound = event?.round ?? window.startRound;
  window.resolution = resolution;
}

function finalizeWindow(window, battle, metricRegistry, attributionByEvent, postEventWeights = new Map()) {
  const scoped = battle.events.filter((event) => event.eventIndex >= window.startEventIndex && event.eventIndex <= window.endEventIndex);
  const responseEvents = scoped.filter((event) => event.metadata?.sourceSide === 'player' || event.metadata?.side === 'player' || event.eventType === 'skill_confirm');
  window.legalActionCount = new Set(responseEvents.filter((event) => event.eventType === 'action_start').map((event) => event.rootActionId)).size;
  const tags = responseTags(window, scoped);
  window.responseTags = [...tags];
  window.effectiveResponses = window.config.validResponses
    .filter((response) => response.requiredTags.every((tag) => tags.has(tag)))
    .map((response) => response.responseId);
  window.invalidResponses = (window.config.invalidResponses ?? []).filter((response) => invalidResponseSeen(response, tags));
  window.incidentalActions = (window.config.incidentalActions ?? []).filter((response) => incidentalSeen(response, tags));
  window.responseClassification = window.legalActionCount === 0
    ? 'no_opportunity'
    : window.effectiveResponses.length
      ? 'effective'
      : window.invalidResponses.length
        ? 'invalid'
        : window.incidentalActions.length
          ? 'incidental'
          : 'ignored';
  const attributed = scoped.filter((event) => {
    if (!DIRECT_OUTCOME_TYPES.has(event.eventType)) return true;
    return attributionByEvent.get(event.eventId)?.primaryMechanicId === window.mechanicId;
  });
  for (const metricId of window.config.outcomeMetrics) {
    window.outcomes[metricId] = metricRegistry.evaluate(metricId, attributed);
  }
  const postEndRound = (window.resolveEventIndex ? battle.events.find((event) => event.eventId === window.resolveEventId)?.round : window.endRound) ?? window.endRound;
  const postEvents = battle.events.filter((event) => event.round > postEndRound && event.round <= postEndRound + (window.config.postImpact?.rounds ?? 0));
  for (const metricId of window.config.postImpact?.metrics ?? []) {
    window.postImpact[metricId] = metricRegistry.evaluate(metricId, postEvents, { eventWeights: postEventWeights });
  }
}

function attributePostImpact(events, windows) {
  const results = [];
  for (const event of events) {
    const containing = windows.filter((window) => {
      const resolveRound = window.resolveEventIndex
        ? events.find((candidate) => candidate.eventId === window.resolveEventId)?.round
        : window.endRound;
      const horizon = window.config.postImpact?.rounds ?? 0;
      return horizon > 0 && event.round > resolveRound && event.round <= resolveRound + horizon;
    });
    if (!containing.length) continue;
    const unique = [...new Map(containing.sort((a, b) => b.priority - a.priority).map((window) => [window.mechanicId, window])).values()];
    const weight = 1 / unique.length;
    results.push({
      eventId: event.eventId,
      primaryMechanicId: unique[0].mechanicId,
      secondaryMechanicIds: unique.slice(1).map((window) => window.mechanicId),
      overlapGroupId: unique.length > 1 ? unique.map((window) => window.mechanicId).sort().join('+') : undefined,
      attributionMode: 'weighted',
      weights: Object.fromEntries(unique.map((window) => [window.mechanicId, weight])),
      attributionScope: 'post_impact'
    });
  }
  return results;
}

function postWeightsByMechanic(attributions) {
  const result = new Map();
  for (const attribution of attributions) {
    for (const [mechanicId, weight] of Object.entries(attribution.weights ?? {})) {
      if (!result.has(mechanicId)) result.set(mechanicId, new Map());
      result.get(mechanicId).set(attribution.eventId, weight);
    }
  }
  return result;
}

function responseTags(window, events) {
  const tags = new Set();
  const targetMatch = (event) => event.targetId === window.lockedTargetId ||
    (window.lockedSlotIndex !== null && event.metadata?.targetSlotIndex === window.lockedSlotIndex) ||
    (window.lockedSlotIndex !== null && event.metadata?.slotIndex === window.lockedSlotIndex);
  for (const event of events) {
    const sourceSide = event.metadata?.sourceSide ?? event.metadata?.side;
    if (event.eventType === 'skill_confirm' && sourceSide === 'player') {
      const categories = event.metadata?.skill?.actionCategories ?? [];
      if (categories.includes('attack')) tags.add('generic_attack');
      if (categories.includes('recover')) tags.add('generic_heal');
      if (categories.includes('protect')) tags.add('generic_shield');
      if (categories.includes('energy')) tags.add('generic_resource_gain');
      if (categories.includes('attack') && Number(event.metadata?.actualCost ?? event.resourceDelta ?? 0) >= 3) tags.add('high_cost_attack');
    }
    if (event.eventType === 'heal' && sourceSide === 'player') {
      tags.add('generic_heal');
      if (targetMatch(event)) tags.add('heal_target');
    }
    if (event.eventType === 'shield_gain' && sourceSide === 'player') {
      tags.add('generic_shield');
      if (targetMatch(event)) tags.add('shield_target');
    }
    if (event.eventType === 'resource_gain' && sourceSide === 'player') tags.add('generic_resource_gain');
    if (event.eventType === 'swap' && !event.metadata?.forced) {
      tags.add('generic_swap');
      if (event.sourceId === window.lockedTargetId || targetMatch(event)) tags.add('swap_target');
    }
    if (event.eventType === 'position_change') tags.add('position_change');
    if (event.eventType === 'unit_death' && event.metadata?.targetSide === 'enemy') tags.add('prevent_by_boss_kill');
  }
  return tags;
}

function invalidResponseSeen(response, tags) {
  if (response === 'position_change_that_does_not_break_lock' || response === 'position_change_without_pressure_reduction') return tags.has('position_change');
  return tags.has(response);
}

function incidentalSeen(response, tags) {
  return tags.has(response);
}

function attributeOverlaps(events, windows, attributionConfig) {
  const results = [];
  for (const event of events) {
    const containing = windows.filter((window) => event.eventIndex >= window.startEventIndex && event.eventIndex <= window.endEventIndex);
    if (!containing.length) continue;
    const sorted = [...containing].sort((a, b) => b.priority - a.priority || (a.endEventIndex - a.startEventIndex) - (b.endEventIndex - b.startEventIndex));
    const direct = DIRECT_OUTCOME_TYPES.has(event.eventType);
    const mode = direct ? attributionConfig.directOutcomeMode : attributionConfig.responseMode;
    const primary = sorted[0];
    const secondary = sorted.slice(1);
    results.push({
      eventId: event.eventId,
      primaryMechanicId: primary.mechanicId,
      secondaryMechanicIds: secondary.map((window) => window.mechanicId),
      overlapGroupId: sorted.length > 1 ? sorted.map((window) => window.mechanicId).sort().join('+') : undefined,
      attributionMode: mode,
      weights: mode === 'weighted' ? Object.fromEntries(sorted.map((window) => [window.mechanicId, 1 / sorted.length])) : undefined
    });
  }
  return results;
}

function summarizeOverlap(attributions, battleId) {
  const groups = new Map();
  for (const attribution of attributions) {
    const key = attribution.overlapGroupId ?? attribution.primaryMechanicId;
    if (!groups.has(key)) groups.set(key, { mechanicCombination: key, eventIds: new Set(), battleIds: new Set() });
    groups.get(key).eventIds.add(attribution.eventId);
    groups.get(key).battleIds.add(battleId);
  }
  const total = attributions.length;
  return [...groups.values()].map((group) => ({
    mechanicCombination: group.mechanicCombination,
    events: group.eventIds.size,
    battles: group.battleIds.size,
    share: total ? group.eventIds.size / total : 0,
    overlapping: group.mechanicCombination.includes('+')
  }));
}

function materializeWindowEvents(events, windows) {
  const entries = events.map((event) => ({ order: event.eventIndex * 10, event }));
  for (const window of windows) {
    const start = events.find((event) => event.eventId === window.startEventId) ?? events[0];
    const end = events.find((event) => event.eventId === window.endEventId) ?? events.at(-1);
    entries.push({ order: window.startEventIndex * 10 + 1, event: derivedWindowEvent(start, window, 'mechanic_window_start', `${window.windowId}:start`) });
    entries.push({ order: window.endEventIndex * 10 + 9, event: derivedWindowEvent(end, window, 'mechanic_window_end', `${window.windowId}:end`) });
  }
  return entries.sort((a, b) => a.order - b.order).map((entry, index) => ({ ...entry.event, eventIndex: index + 1 }));
}

function derivedWindowEvent(source, window, eventType, eventId) {
  return {
    ...source,
    eventId,
    eventType,
    mechanicId: window.mechanicId,
    windowId: window.windowId,
    parentEventId: source.eventId,
    tags: [eventType, `mechanic:${window.mechanicId}`],
    metadata: { derived: true, resolution: window.resolution, triggerEventId: window.triggerEventId }
  };
}
