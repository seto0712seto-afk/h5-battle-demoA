const CONDITIONAL_SKILLS = new Set([
  'M01-S2', 'M02-S3', 'M03-S3', 'M04-S2', 'M06-S2', 'M08-S3', 'M10-S3'
]);

export function createTenSpiritSpecialtyMetrics(config, metadata) {
  return new TenSpiritSpecialtyMetrics(config, metadata);
}

class TenSpiritSpecialtyMetrics {
  constructor(config, metadata) {
    this.config = config;
    this.metadata = metadata;
    this.battles = [];
    this.spirits = Object.fromEntries(config.creatureConfig.map((spirit) => [spirit.id, {
      spiritId: spirit.id,
      spiritName: spirit.name,
      battles: 0,
      selectedBattles: 0,
      wins: 0,
      deaths: 0,
      normalActions: 0,
      damageTotal: 0,
      effectiveHealing: 0,
      overhealing: 0,
      shieldGenerated: 0,
      shieldAbsorbed: 0,
      shieldRemainingAtBattleEnd: 0,
      manaGeneratedTotal: 0,
      manaGeneratedEffective: 0,
      manaOverflow: 0,
      manaSavedByCostReduction: 0,
      activeSwapsOut: 0,
      entries: 0,
      frontActionStarts: 0,
      attackedCount: 0,
      incomingDamage: 0
    }]));
    this.skills = Object.fromEntries(config.creatureConfig.flatMap((spirit) => spirit.skillIds.map((skillId) => {
      const skill = config.skillConfig[skillId];
      return [skillId, {
        boss: metadata.bossId,
        team: metadata.teamId,
        aiStrategy: metadata.aiStrategy,
        spiritId: spirit.id,
        skillId,
        skillName: skill.name,
        useCount: 0,
        ownerNormalActions: 0,
        firstUseOwnActionIndexCounts: {},
        actualCostTotal: 0,
        actualCostDistribution: {},
        manaAtUseTotal: 0,
        hpRatioAtUseTotal: 0,
        teamHpRatioAtUseTotal: 0,
        damageTotal: 0,
        effectiveHealing: 0,
        overhealing: 0,
        shieldGenerated: 0,
        shieldAbsorbed: 0,
        manaGeneratedTotal: 0,
        manaGeneratedEffective: 0,
        manaOverflow: 0,
        conditionMetCount: CONDITIONAL_SKILLS.has(skillId) ? 0 : null,
        conditionUnmetCount: CONDITIONAL_SKILLS.has(skillId) ? 0 : null
        ,enhancedUseCount: 0
      }];
    })));
    this.special = createSpecialMetrics();
  }

  createBattleCollector(context) {
    const battle = {
      ...context,
      normalActions: {},
      entries: {},
      swapsOut: {},
      deaths: {},
      alive: {},
      skillUses: {},
      skillFirstSeen: new Set(),
      skillMana: {},
      manaGeneratedTotal: 0,
      manaGeneratedEffective: 0,
      manaOverflow: 0,
      manaSpent: 0,
      manaEnd: 0,
      activeSwapCount: 0,
      deathReplacementCount: 0,
      p08RefreshSwaps: 0,
      result: 'unknown',
      rounds: 0,
      bossRemainingHp: 0,
      bossMaxHp: 0,
      castStates: new Map(),
      regenInstances: new Map()
      ,energySavingInstances: new Map()
      ,p08RefreshedCastIds: new Set()
      ,p08RefreshedShieldIds: new Set()
      ,special: {
        p07: { uses: 0, legalOpportunities: 0, legalButNotSelected: 0, effectiveHealing: 0, overhealing: 0 },
        p06: { transferUses: 0, discountedUses: 0, manaSaved: 0, unredeemed: 0, highCostOpportunities: 0, highCostOtherChosen: 0 },
        p08: { uses: 0, oneCostUses: 0, fourCostUses: 0, refreshSwaps: 0, refreshedOneCostUses: 0, manaSaved: 0, effectiveHealing: 0, shieldGenerated: 0, shieldAbsorbed: 0, refreshedEffectiveHealing: 0, refreshedShieldGenerated: 0, refreshedShieldAbsorbed: 0 }
      }
    };
    const safe = (fn) => (payload) => fn(payload);
    const observeDecision = (decision) => this.observeDecision(battle, decision);
    return {
      battle,
      observeDecision,
      collector: {
        onBattleStart: safe((event) => {
          event.activeSpiritIds.forEach((id) => increment(battle.entries, id));
        }),
        onActionStart: safe((event) => {
          if (event.side !== 'player' || event.actionContext !== 'normal') return;
          increment(battle.normalActions, event.unitId);
          const spirit = this.spirits[event.unitId];
          if (!spirit) return;
          spirit.normalActions += 1;
          const slot = event.playerSlots.find((item) => item.unitId === event.unitId);
          if (slot?.row === 'front') spirit.frontActionStarts += 1;
        }),
        onSkillConfirmed: safe((event) => this.onSkillConfirmed(battle, event)),
        onSkillResolved: safe((event) => this.onSkillResolved(battle, event)),
        onDamageResolved: safe((event) => this.onDamageResolved(battle, event)),
        onHealingResolved: safe((event) => this.onHealingResolved(battle, event)),
        onShieldGranted: safe((event) => this.onShieldGranted(battle, event)),
        onShieldAbsorbed: safe((event) => this.onShieldAbsorbed(battle, event)),
        onShieldConsumed: safe((event) => {
          if (event.consumedBySkillId !== 'M04-S2') return;
          this.special.p04.shieldConsumed += event.shieldConsumed;
          this.special.p04.fixedDamageGenerated += event.fixedDamageGenerated;
        }),
        onStatusChanged: safe((event) => this.onStatusChanged(battle, event)),
        onEnergyChanged: safe((event) => this.onEnergyChanged(battle, event)),
        onSwitchResolved: safe((event) => {
          increment(battle.entries, event.incomingId);
          if (event.outgoingId) increment(battle.swapsOut, event.outgoingId);
          if (event.forced) battle.deathReplacementCount += 1;
          else battle.activeSwapCount += 1;
          if (!event.forced && (event.outgoingId === 'P08' || event.incomingId === 'P08')) battle.p08RefreshSwaps += 1;
        }),
        onUnitDefeated: safe((event) => {
          if (event.side === 'player') increment(battle.deaths, event.unitId);
        })
      }
    };
  }

  onSkillConfirmed(battle, event) {
    const metric = this.skills[event.skillId];
    if (!metric) return;
    metric.useCount += 1;
    metric.actualCostTotal += event.actualCost;
    metric.manaAtUseTotal += event.manaBefore;
    metric.hpRatioAtUseTotal += event.actorHp / Math.max(1, event.actorMaxHp);
    metric.teamHpRatioAtUseTotal += event.teamHp / Math.max(1, event.teamMaxHp);
    if (event.enhanced) metric.enhancedUseCount += 1;
    increment(metric.actualCostDistribution, String(event.actualCost));
    increment(battle.skillUses, event.skillId);
    if (!battle.skillFirstSeen.has(event.skillId)) {
      battle.skillFirstSeen.add(event.skillId);
      increment(metric.firstUseOwnActionIndexCounts, String(battle.normalActions[event.actorId] ?? 0));
    }
    const conditionMet = conditionalSkillMet(event);
    if (conditionMet !== null) {
      if (conditionMet) metric.conditionMetCount += 1;
      else metric.conditionUnmetCount += 1;
    }
    battle.castStates.set(event.skillCastId, {
      skillId: event.skillId,
      actorId: event.actorId,
      damageAmpStacks: event.stateBeforeCast?.damageAmpStacks ?? 0,
      manaBefore: event.manaBefore,
      entrySequenceId: event.entrySequenceId
    });

    if (event.energySavingSourceSkillId === 'M06-S3') {
      const saved = Math.max(0, event.costBeforeEnergySaving - event.actualCost);
      this.special.p06.discountedSkillUses += 1;
      this.special.p06.manaSaved += saved;
      increment(this.special.p06.discountTargets, event.actorId);
      increment(this.special.p06.discountedSkills, event.skillId);
      increment(this.special.p06.costTransitions, `${event.costBeforeEnergySaving}->${event.actualCost}`);
      this.spirits.P06.manaSavedByCostReduction += saved;
      battle.special.p06.discountedUses += 1;
      battle.special.p06.manaSaved += saved;
    }
    if (event.skillId === 'M06-S3') {
      this.special.p06.energyTransferUses += 1;
      battle.special.p06.transferUses += 1;
      increment(this.special.p06.energyTransferTargets, event.targetId ?? 'none');
    }
    if (event.skillId === 'M07-S3') {
      this.special.p07.uses += 1;
      battle.special.p07.uses += 1;
      this.special.p07.manaAtUseTotal += event.manaBefore;
      this.special.p07.teamHpRatioAtUseTotal += event.teamHp / Math.max(1, event.teamMaxHp);
    }
    if (event.skillId === 'M06-S2') {
      this.special.p06.ironSupportUses += 1;
      if (event.manaBefore >= 5) this.special.p06.ironSupportEnhancedUses += 1;
    }
    if (event.skillId === 'M08-S3') {
      this.special.p08.uses += 1;
      battle.special.p08.uses += 1;
      if (event.stateBeforeCast?.entrySkillAvailable && event.actualCost === 1) {
        this.special.p08.oneCostUses += 1;
        this.special.p08.manaSaved += Math.max(0, event.configuredCost - event.actualCost);
        battle.special.p08.oneCostUses += 1;
        battle.special.p08.manaSaved += Math.max(0, event.configuredCost - event.actualCost);
        increment(this.special.p08.oneCostUsesByEntry, String(event.entrySequenceId));
        if (event.entrySequenceId > 1) {
          this.special.p08.refreshedOneCostUses += 1;
          this.special.p08.refreshedManaSaved += Math.max(0, event.configuredCost - event.actualCost);
          battle.special.p08.refreshedOneCostUses += 1;
          battle.p08RefreshedCastIds.add(event.skillCastId);
        }
      } else {
        this.special.p08.fourCostUses += 1;
        battle.special.p08.fourCostUses += 1;
      }
    }
    if (event.skillId === 'M10-S3') {
      this.special.p10.uses += 1;
      if (event.battleUseIndex === 1 && event.actualCost === 0) this.special.p10.firstZeroCostUses += 1;
      this.special.p10.manaBeforeTotal += event.manaBefore;
    }
    if (event.skillId === 'M01-S2') {
      increment(this.special.p01.chainCostUses, String(event.actualCost));
    }
    if (event.skillId === 'M01-S3') {
      increment(this.special.p01.burstFirstUseOwnActionIndex, String(battle.normalActions[event.actorId] ?? 0));
    }
    if (event.actorId === 'P02' && event.skillId === 'M02-S3') {
      increment(this.special.p02.stormUsesByStacks, String(event.stateBeforeCast?.damageAmpStacks ?? 0));
    }
  }

  onSkillResolved(battle, event) {
    if (event.skillId === 'M01-S2') {
      if (event.resetTrigger === 'zero_cost_cast') this.special.p01.chainResetAfterZero += 1;
    } else if (event.actorId === 'P01' && event.resetTrigger === 'other_skill_used') {
      this.special.p01.chainResetByOtherSkill += 1;
    }
    if (event.skillId === 'M10-S3') {
      this.special.p10.manaAfterTotal += event.energyAfterSkillResolution;
      this.special.p10.effectiveGain += event.energyGainActual;
      this.special.p10.overflow += event.energyOverflow;
    }
    battle.castStates.delete(event.skillCastId);
  }

  onDamageResolved(battle, event) {
    if (event.sourceSide === 'player') {
      if (this.spirits[event.sourceId]) this.spirits[event.sourceId].damageTotal += event.actual;
      if (this.skills[event.skillId]) this.skills[event.skillId].damageTotal += event.actual;
      const cast = event.skillCastId ? battle.castStates.get(event.skillCastId) : null;
      if (event.sourceId === 'P02' && cast?.skillId === 'M02-S3') {
        increment(this.special.p02.damageByStormStacks, String(cast.damageAmpStacks), event.actual);
        increment(this.special.p02.hitsByStormStacks, String(cast.damageAmpStacks));
      }
      return;
    }
    if (event.targetId === 'P04') {
      this.special.p04.attackedCount += 1;
      this.special.p04.incomingDamage += event.actual + event.absorbed;
      this.spirits.P04.attackedCount += 1;
      this.spirits.P04.incomingDamage += event.actual + event.absorbed;
    }
  }

  onHealingResolved(battle, event) {
    if (this.spirits[event.actorId]) {
      this.spirits[event.actorId].effectiveHealing += event.effective;
      this.spirits[event.actorId].overhealing += event.overheal;
    }
    if (event.skillId && this.skills[event.skillId]) {
      this.skills[event.skillId].effectiveHealing += event.effective;
      this.skills[event.skillId].overhealing += event.overheal;
    }
    if (event.skillId === 'M06-S2') this.special.p06.ironSupportEffectiveHealing += event.effective;
    if (event.skillId === 'M07-S3') {
      this.special.p07.effectiveHealing += event.effective;
      this.special.p07.overhealing += event.overheal;
      battle.special.p07.effectiveHealing += event.effective;
      battle.special.p07.overhealing += event.overheal;
    }
    if (event.skillId === 'M08-S3') {
      this.special.p08.effectiveHealing += event.effective;
      battle.special.p08.effectiveHealing += event.effective;
      if (event.skillCastId && battle.p08RefreshedCastIds.has(event.skillCastId)) {
        this.special.p08.refreshedEffectiveHealing += event.effective;
        battle.special.p08.refreshedEffectiveHealing += event.effective;
      }
    }
    if (event.skillId === 'M03-S2' && event.healingSourceType === 'status') this.special.p03.regenTriggers += 1;
  }

  onShieldGranted(battle, event) {
    if (this.spirits[event.actorId]) this.spirits[event.actorId].shieldGenerated += event.granted;
    if (event.skillId && this.skills[event.skillId]) this.skills[event.skillId].shieldGenerated += event.granted;
    if (event.skillId === 'M06-S2') this.special.p06.ironSupportShieldGenerated += event.granted;
    if (event.skillId === 'M08-S3') {
      this.special.p08.shieldGenerated += event.granted;
      battle.special.p08.shieldGenerated += event.granted;
      if (event.skillCastId && battle.p08RefreshedCastIds.has(event.skillCastId)) {
        this.special.p08.refreshedShieldGenerated += event.granted;
        battle.special.p08.refreshedShieldGenerated += event.granted;
        battle.p08RefreshedShieldIds.add(event.shieldInstanceId);
      }
    }
  }

  onShieldAbsorbed(battle, event) {
    if (this.spirits[event.sourceUnitId]) this.spirits[event.sourceUnitId].shieldAbsorbed += event.absorbedDamage;
    if (event.sourceSkillId && this.skills[event.sourceSkillId]) this.skills[event.sourceSkillId].shieldAbsorbed += event.absorbedDamage;
    if (event.sourceSkillId === 'M06-S2') this.special.p06.ironSupportShieldAbsorbed += event.absorbedDamage;
    if (event.sourceSkillId === 'M08-S3') {
      this.special.p08.shieldAbsorbed += event.absorbedDamage;
      battle.special.p08.shieldAbsorbed += event.absorbedDamage;
      if (battle.p08RefreshedShieldIds.has(event.shieldInstanceId)) {
        this.special.p08.refreshedShieldAbsorbed += event.absorbedDamage;
        battle.special.p08.refreshedShieldAbsorbed += event.absorbedDamage;
      }
    }
  }

  onStatusChanged(battle, event) {
    if (event.statusId === 'charge') {
      if (event.change === 'apply' || event.change === 'refresh') this.special.p02.chargeGained += 1;
      if (event.change === 'remove' && event.removeReason === 'triggered') this.special.p02.chargeTriggered += 1;
      if (event.change === 'remove' && event.removeReason === 'duration_expired') this.special.p02.chargeExpired += 1;
    }
    if (event.statusId === 'damage-amp' && event.stackDelta > 0) {
      const expected = event.applyReason === '蓄势' ? 3 : event.sourceSkillId === 'M02-S1' ? 1 : event.stackDelta;
      this.special.p02.burstGained += event.stackDelta;
      this.special.p02.burstOverflow += Math.max(0, expected - event.stackDelta);
    }
    if (event.statusId === 'regen' && event.sourceSkillId === 'M03-S2') {
      if (event.change === 'apply') {
        battle.regenInstances.set(event.statusInstanceId, { triggers: 0 });
        this.special.p03.regenUses += 1;
      }
      if (event.change === 'remove') {
        if (event.removeReason === 'duration_expired') this.special.p03.regenCompleted += 1;
        battle.regenInstances.delete(event.statusInstanceId);
      }
    }
    if (event.statusId === 'energy-saving' && event.sourceSkillId === 'M06-S3') {
      if (event.change === 'apply' || event.change === 'refresh') {
        battle.energySavingInstances.set(event.statusInstanceId, { targetId: event.targetUnitId, resolved: false });
        this.special.p06.energySavingGranted += 1;
      }
      if (event.change === 'remove') {
        const instance = battle.energySavingInstances.get(event.statusInstanceId);
        if (instance) instance.resolved = true;
        if (event.removeReason !== 'consumed_by_skill') {
          this.special.p06.energySavingUnredeemed += 1;
          battle.special.p06.unredeemed += 1;
        }
      }
    }
  }

  observeDecision(battle, decision) {
    if (decision.stage !== 'skill-only' || !decision.selected) return;
    const candidates = decision.candidates ?? [];
    const selectedSkillId = decision.selected.action === 'skill' ? decision.selected.skillId : null;
    if (decision.actorId === 'P07') {
      const legal = candidates.some((candidate) => candidate.action === 'skill' && candidate.skillId === 'M07-S3');
      if (legal) {
        this.special.p07.legalOpportunities += 1;
        battle.special.p07.legalOpportunities += 1;
        if (selectedSkillId !== 'M07-S3') {
          this.special.p07.legalButNotSelected += 1;
          battle.special.p07.legalButNotSelected += 1;
        }
      }
    }
    if (decision.actorId === 'P06') {
      const transfers = candidates.filter((candidate) => candidate.action === 'skill' && candidate.skillId === 'M06-S3');
      const highValue = transfers.filter((candidate) => (candidate.diagnostics?.energySavingOriginalCost ?? 0) >= 5);
      if (highValue.length > 0) {
        this.special.p06.legalHighCostTargetOpportunities += 1;
        battle.special.p06.highCostOpportunities += 1;
        if (selectedSkillId !== 'M06-S3') {
          this.special.p06.highCostTargetButOtherChosen += 1;
          battle.special.p06.highCostOtherChosen += 1;
        }
      }
    }
  }

  onEnergyChanged(battle, event) {
    battle.manaGeneratedTotal += event.attemptedGain;
    battle.manaGeneratedEffective += event.gained;
    battle.manaOverflow += Math.max(0, event.attemptedGain - event.gained);
    battle.manaSpent += event.spent;
    if (!event.skillId) return;
    const metric = this.skills[event.skillId];
    if (metric) {
      metric.manaGeneratedTotal += event.attemptedGain;
      metric.manaGeneratedEffective += event.gained;
      metric.manaOverflow += Math.max(0, event.attemptedGain - event.gained);
    }
    if (event.actorId && this.spirits[event.actorId]) {
      this.spirits[event.actorId].manaGeneratedTotal += event.attemptedGain;
      this.spirits[event.actorId].manaGeneratedEffective += event.gained;
      this.spirits[event.actorId].manaOverflow += Math.max(0, event.attemptedGain - event.gained);
    }
    battle.skillMana[event.skillId] ??= { total: 0, effective: 0, overflow: 0 };
    battle.skillMana[event.skillId].total += event.attemptedGain;
    battle.skillMana[event.skillId].effective += event.gained;
    battle.skillMana[event.skillId].overflow += Math.max(0, event.attemptedGain - event.gained);
  }

  finishBattle(handle, result, game) {
    const battle = handle.battle;
    battle.result = result.victory ? 'victory' : 'defeat';
    battle.rounds = result.rounds;
    battle.manaEnd = result.finalMana;
    const enemies = Object.values(game.state.enemies);
    battle.bossRemainingHp = enemies.reduce((sum, enemy) => sum + Math.max(0, enemy.hp), 0);
    battle.bossMaxHp = enemies.reduce((sum, enemy) => sum + enemy.maxHp, 0);
    game.state.selectedSpiritIds.forEach((id) => {
      const runtime = game.getSpirit(id);
      battle.alive[id] = runtime.hp > 0;
      const spirit = this.spirits[id];
      if (!spirit) return;
      spirit.selectedBattles += 1;
      spirit.battles += 1;
      if (result.victory) spirit.wins += 1;
      spirit.deaths += battle.deaths[id] ?? 0;
      spirit.activeSwapsOut += battle.swapsOut[id] ?? 0;
      spirit.entries += battle.entries[id] ?? 0;
      runtime.shieldInstances.forEach((instance) => {
        if (this.spirits[instance.sourceUnitId]) this.spirits[instance.sourceUnitId].shieldRemainingAtBattleEnd += instance.remaining;
      });
    });
    Object.values(this.skills).forEach((metric) => {
      const ownerActions = battle.normalActions[metric.spiritId] ?? 0;
      if (ownerActions > 0) metric.ownerNormalActions += ownerActions;
    });
    this.special.p08.refreshSwaps += battle.p08RefreshSwaps;
    battle.special.p08.refreshSwaps = battle.p08RefreshSwaps;
    for (const instance of battle.energySavingInstances.values()) {
      if (!instance.resolved) {
        this.special.p06.energySavingUnredeemed += 1;
        battle.special.p06.unredeemed += 1;
      }
    }
    this.special.p02.unspentStacksAtBattleEnd += game.state.spirits.P02?.damageAmpStacks ?? 0;
    this.battles.push(serializeBattle(battle));
  }

  finalize() {
    return {
      schemaVersion: 1,
      metadata: this.metadata,
      battles: this.battles,
      spirits: this.spirits,
      skills: this.skills,
      special: this.special
    };
  }
}

function conditionalSkillMet(event) {
  if (event.skillId === 'M01-S2') return event.actualCost < event.configuredCost;
  if (event.skillId === 'M02-S3') return (event.stateBeforeCast?.damageAmpStacks ?? 0) > 0;
  if (event.skillId === 'M03-S3') return event.actorHp / Math.max(1, event.actorMaxHp) > 0.5;
  if (event.skillId === 'M04-S2') return (event.stateBeforeCast?.shieldValue ?? 0) > 0;
  if (event.skillId === 'M06-S2') return event.manaBefore >= 5;
  if (event.skillId === 'M08-S3') return Boolean(event.stateBeforeCast?.entrySkillAvailable);
  if (event.skillId === 'M10-S3') return event.battleUseIndex === 1;
  return null;
}

function createSpecialMetrics() {
  return {
    p01: { chainCostUses: {}, chainResetByOtherSkill: 0, chainResetAfterZero: 0, burstFirstUseOwnActionIndex: {} },
    p02: {
      chargeGained: 0, chargeTriggered: 0, chargeExpired: 0,
      burstGained: 0, burstOverflow: 0, unspentStacksAtBattleEnd: 0,
      stormUsesByStacks: {}, damageByStormStacks: {}, hitsByStormStacks: {}
    },
    p03: { regenUses: 0, regenTriggers: 0, regenCompleted: 0 },
    p04: { attackedCount: 0, incomingDamage: 0, shieldConsumed: 0, fixedDamageGenerated: 0 },
    p07: { uses: 0, manaAtUseTotal: 0, teamHpRatioAtUseTotal: 0, effectiveHealing: 0, overhealing: 0, legalOpportunities: 0, legalButNotSelected: 0 },
    p06: {
      energyTransferUses: 0, energyTransferTargets: {}, discountedSkillUses: 0,
      discountTargets: {}, discountedSkills: {}, costTransitions: {}, manaSaved: 0,
      ironSupportUses: 0, ironSupportEnhancedUses: 0, ironSupportEffectiveHealing: 0,
      ironSupportShieldGenerated: 0, ironSupportShieldAbsorbed: 0,
      energySavingGranted: 0, energySavingUnredeemed: 0,
      legalHighCostTargetOpportunities: 0, highCostTargetButOtherChosen: 0
    },
    p08: {
      uses: 0, oneCostUses: 0, fourCostUses: 0, oneCostUsesByEntry: {}, refreshSwaps: 0,
      manaSaved: 0, effectiveHealing: 0, shieldGenerated: 0, shieldAbsorbed: 0,
      refreshedOneCostUses: 0, refreshedManaSaved: 0,
      refreshedEffectiveHealing: 0, refreshedShieldGenerated: 0, refreshedShieldAbsorbed: 0
    },
    p10: { uses: 0, firstZeroCostUses: 0, manaBeforeTotal: 0, manaAfterTotal: 0, effectiveGain: 0, overflow: 0 }
  };
}

function serializeBattle(battle) {
  return {
    seed: battle.seed,
    bossId: battle.bossId,
    bossName: battle.bossName,
    teamId: battle.teamId,
    aiStrategy: battle.aiStrategy,
    win: battle.result === 'victory',
    battleRounds: battle.rounds,
    bossRemainingHp: battle.bossRemainingHp,
    bossMaxHp: battle.bossMaxHp,
    spiritAlive: battle.alive,
    spiritNormalActionCount: battle.normalActions,
    activeSwapCount: battle.activeSwapCount,
    deathReplacementCount: battle.deathReplacementCount,
    teamManaGeneratedTotal: battle.manaGeneratedTotal,
    teamManaGeneratedEffective: battle.manaGeneratedEffective,
    teamManaOverflow: battle.manaOverflow,
    teamManaSpent: battle.manaSpent,
    teamManaEnd: battle.manaEnd,
    skillUses: battle.skillUses,
    skillMana: battle.skillMana,
    entries: battle.entries,
    swapsOut: battle.swapsOut,
    deaths: battle.deaths
    ,special: battle.special
  };
}

function increment(target, key, amount = 1) {
  target[key] = (target[key] ?? 0) + amount;
}
