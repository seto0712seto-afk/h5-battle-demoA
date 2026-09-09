import type { BattleRoundState, FieldSlot, RoundActionSlot, RuntimeSpirit, RuntimeStatus } from './types';

export interface StatusApplication {
  id: string;
  name: string;
  temporary?: boolean;
  stackable?: boolean;
  maxStacks?: number;
  stacks?: number;
  value?: number;
  duration: number;
  appliedDuringOwnerAction?: boolean;
  clearOnBench?: boolean;
  sourceId?: string;
  instanceId?: string;
  sourceUnitId?: string;
  sourceSkillId?: string;
}

export const CORE_STATUS_RULES = {
  damageAmp: {
    id: 'damage-amp',
    name: '爆发',
    stackable: true,
    maxStacks: 4,
    temporary: false,
    clearOnBench: true,
    description: '每层使下一次技能威力 +25%，最多 4 层。'
  },
  charge: {
    id: 'charge',
    name: '蓄势',
    stackable: false,
    maxStacks: 1,
    temporary: false,
    clearOnBench: true,
    description: '本回合首次受到攻击时获得 3 层【爆发】。'
  },
  regen: {
    id: 'regen',
    name: '回复',
    stackable: false,
    maxStacks: 1,
    description: '持有者行动开始时恢复 10% 最大生命。'
  },
  energySaving: {
    id: 'energy-saving',
    name: '节能',
    stackable: false,
    maxStacks: 1,
    temporary: false,
    clearOnBench: true,
    description: '下一次使用技能时，妖力消耗降低 50%。'
  },
  vulnerable: {
    id: 'vulnerable',
    name: '易伤',
    stackable: false,
    maxStacks: 1,
    description: '受到的伤害提高 50%。'
  }
} as const;

export const CHARGE_DAMAGE_AMP_STACKS_ON_HIT = 3;

export function buildRoundState(
  index: number,
  slots: FieldSlot[],
  spirits: Record<string, RuntimeSpirit>,
  bossId: string,
  bossAlive: boolean,
  bossSpeed: number
): BattleRoundState {
  const actionSlots: RoundActionSlot[] = [];
  slots.forEach((slot) => {
    const spiritId = slot.spiritId;
    if (!spiritId || spirits[spiritId]?.hp <= 0) return;
    actionSlots.push({
      key: `spirit:${spiritId}`,
      type: 'spirit',
      unitId: spiritId,
      speed: 0,
      creationOrder: slot.index,
      status: 'pending'
    });
  });
  if (bossAlive) {
    actionSlots.push({
      key: `boss:${bossId}`,
      type: 'boss',
      unitId: bossId,
      speed: bossSpeed,
      creationOrder: slots.length,
      status: 'pending'
    });
  }
  return {
    index,
    actionSlots,
    cursor: 0,
    pendingReplacementSlotIndexes: []
  };
}

export function sortRoundActionSlots(round: BattleRoundState, spiritSpeeds: Record<string, number>) {
  round.actionSlots.forEach((slot) => {
    if (slot.type === 'spirit') slot.speed = spiritSpeeds[slot.unitId] ?? 0;
  });
  round.actionSlots.sort((a, b) => b.speed - a.speed || a.creationOrder - b.creationOrder);
  return round;
}

export function mergeRuntimeStatus(current: RuntimeStatus | undefined, application: StatusApplication): RuntimeStatus {
  const stackable = application.stackable ?? false;
  const maxStacks = Math.max(1, application.maxStacks ?? (stackable ? Number.MAX_SAFE_INTEGER : 1));
  const incomingStacks = Math.max(1, application.stacks ?? 1);
  if (!current) {
    return {
      id: application.id,
      name: application.name,
      temporary: application.temporary ?? true,
      stackable,
      maxStacks,
      stacks: Math.min(maxStacks, incomingStacks),
      value: application.value ?? 0,
      duration: Math.max(0, application.duration),
      skipCurrentOwnerActionEnd: application.appliedDuringOwnerAction ?? false,
      clearOnBench: application.clearOnBench ?? false,
      sourceId: application.sourceId,
      instanceId: application.instanceId,
      sourceUnitId: application.sourceUnitId,
      sourceSkillId: application.sourceSkillId
    };
  }
  return {
    ...current,
    temporary: current.temporary && (application.temporary ?? true),
    stackable,
    maxStacks,
    stacks: stackable ? Math.min(maxStacks, current.stacks + incomingStacks) : 1,
    value: Math.max(current.value, application.value ?? 0),
    duration: Math.max(current.duration, application.duration),
    skipCurrentOwnerActionEnd: current.skipCurrentOwnerActionEnd || (application.appliedDuringOwnerAction ?? false),
    clearOnBench: current.clearOnBench || (application.clearOnBench ?? false),
    sourceId: application.sourceId ?? current.sourceId,
    instanceId: application.instanceId ?? current.instanceId,
    sourceUnitId: application.sourceUnitId ?? current.sourceUnitId,
    sourceSkillId: application.sourceSkillId ?? current.sourceSkillId
  };
}

export function tickOwnerStatuses(statuses: Record<string, RuntimeStatus>) {
  Object.keys(statuses).forEach((id) => {
    const status = statuses[id];
    if (!status.temporary) return;
    if (status.skipCurrentOwnerActionEnd) {
      status.skipCurrentOwnerActionEnd = false;
      return;
    }
    status.duration = Math.max(0, status.duration - 1);
    if (status.duration === 0) delete statuses[id];
  });
}

export function clearTemporaryStatuses(statuses: Record<string, RuntimeStatus>) {
  Object.keys(statuses).forEach((id) => {
    if (statuses[id].temporary || statuses[id].clearOnBench) delete statuses[id];
  });
}

export function legalSingleTargetIds(slots: FieldSlot[], spirits: Record<string, RuntimeSpirit>) {
  const alive = (slot: FieldSlot) => Boolean(slot.spiritId && spirits[slot.spiritId]?.hp > 0);
  const fronts = slots.filter((slot) => slot.row === 'front' && alive(slot)).map((slot) => slot.spiritId as string);
  if (fronts.length > 0) return fronts;
  return slots.filter((slot) => slot.row === 'back' && alive(slot)).map((slot) => slot.spiritId as string);
}

export function orderedTriggerUnitIds(targetId: string, sourceId: string, slots: FieldSlot[]) {
  const others = slots
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((slot) => slot.spiritId)
    .filter((id): id is string => Boolean(id && id !== targetId && id !== sourceId));
  return [targetId, ...(sourceId !== targetId ? [sourceId] : []), ...others];
}
