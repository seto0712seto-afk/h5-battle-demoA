const CORE_MECHANICS = {
  FORGE_BOSS_WARRIOR: ['FORGE_BOSS_MOUNTAIN_CHARGE', 'FORGE_BOSS_MOUNTAIN_CLEAVE'],
  RANGE_BOSS_SHOOTER: ['RANGE_BOSS_ARROWSTORM_CHARGE', 'RANGE_BOSS_SKYFALL'],
  MAGE_BOSS: ['MAGE_BOSS_MANA_EXPANSION']
};

export function createExperienceRadar(config, options) {
  return new ExperienceRadar(config, options);
}

class ExperienceRadar {
  constructor(config, options) {
    this.config = config;
    this.options = options;
    this.currentRun = null;
    this.battles = [];
    this.runtimeAnomalies = [];
    this.spirits = Object.fromEntries(config.creatureConfig.map((spirit) => [spirit.id, {
      spiritId: spirit.id,
      spiritName: spirit.name,
      selectedCount: 0,
      starterCount: 0,
      benchCount: 0,
      enteredBattleCount: 0,
      normalActions: 0,
      extraActions: 0,
      winsWhenSelected: 0,
      winsWhenStarter: 0,
      winsWhenBench: 0,
      winRateWhenSelected: 0,
      winRateWhenStarter: 0,
      winRateWhenBench: 0,
      damageDealt: 0,
      effectiveHealing: 0,
      overheal: 0,
      shieldGranted: 0,
      energyGenerated: 0,
      switchedIn: 0,
      switchedOut: 0,
      deaths: 0
    }]));
    this.skills = {};
    config.creatureConfig.forEach((spirit) => {
      spirit.skillIds.forEach((skillId) => {
        const skill = config.skillConfig[skillId];
        if (!skill) return;
        this.skills[skillId] = {
          spiritId: spirit.id,
          spiritName: spirit.name,
          skillId,
          skillName: skill.name,
          uses: 0,
          ownerSkillActions: 0,
          useShareOfOwnerSkillActions: 0,
          repeatedUses: 0,
          consecutiveRepeatRate: 0,
          configuredCostTotal: 0,
          actualCostTotal: 0,
          averageConfiguredCost: 0,
          averageActualCost: 0,
          freeUses: 0,
          freeUseRate: 0,
          actualCostUseCounts: {},
          damageDealt: 0,
          averageDamage: 0,
          effectiveHealing: 0,
          averageEffectiveHealing: 0,
          overheal: 0,
          shieldGranted: 0,
          shieldAbsorbed: 0,
          shieldUtilizationRate: 0,
          energyRequested: 0,
          energyGenerated: 0,
          energyOverflow: 0,
          enhancedAvailableCount: hasEnhancementMechanic(skill) ? 0 : null,
          enhancedUseCount: hasEnhancementMechanic(skill) ? 0 : null,
          enhancedConversionRate: hasEnhancementMechanic(skill) ? 0 : null
        };
      });
    });
    this.energy = {
      gained: 0,
      attemptedGain: 0,
      overflow: 0,
      overflowRate: 0,
      spent: 0,
      playerActionStarts: 0,
      energyAtPlayerActionStartTotal: 0,
      averageEnergyAtPlayerActionStart: 0,
      zeroEnergyActionStarts: 0,
      zeroEnergyActionStartRate: 0,
      fullEnergyActionStarts: 0,
      fullEnergyActionStartRate: 0,
      skillConfirms: 0,
      energyAtSkillConfirmTotal: 0,
      averageEnergyAtSkillConfirm: 0,
      actionStartGained: 0,
      skillGained: 0,
      energyGeneratedBySkill: {}
    };
    this.skillValidation = {
      chainSlash: { completeCycles: 0, costUseCounts: {}, resetByOtherSkill: 0, resetByZeroCostCast: 0 },
      windBurst: { stacksGainedBySourceSkill: {}, payoffUsesByStackCount: {}, averagePayoffStacks: 0, stormGuaranteedCritUses: 0, unspentStacksAtBattleEnd: 0 },
      regeneration: { applications: 0, triggerCount: 0, completedInstances: 0, removedBeforeCompletion: 0, remainingTurnsLost: 0 },
      shieldPress: { uses: 0, shieldConsumed: 0, fixedDamageGenerated: 0, shieldSourceComposition: {}, afterRockGuardUses: 0 },
      ironSupport: { uses: 0, enhancedUses: 0, enhancedRate: 0, effectiveHealing: 0, shieldGenerated: 0, shieldAbsorbed: 0, shieldUtilizationRate: 0 },
      bellBlessing: {
        entryQualifications: 0, freeUses: 0, paidUses: 0, qualificationLostByOtherSkill: 0,
        freeEffectiveHealing: 0, paidEffectiveHealing: 0,
        freeShieldGenerated: 0, paidShieldGenerated: 0,
        freeShieldAbsorbed: 0, paidShieldAbsorbed: 0,
        freeShieldUtilizationRate: 0, paidShieldUtilizationRate: 0
      },
      vulnerability: {
        applications: 0, coveredRounds: 0, coveredHits: 0, baseDamage: 0, extraDamage: 0,
        averageExtraDamagePerApplication: 0, unusedWindowTurns: 0
      },
      exposure: { coveredHits: 0, baseDamage: 0, extraDamage: 0 },
      skillEnergy: {},
      starReturn: { uses: 0, firstFreeUses: 0, paidUses: 0, actualSpent: 0, actualGained: 0, netEnergy: 0, usesByRound: {} },
      starArmor: { uses: 0, fixedDamage: 0, shieldGenerated: 0, shieldAbsorbed: 0, ownerSkillShare: 0 }
    };
    this.regenInstances = new Map();
    this.vulnerabilityInstances = new Map();
    this.bellCastModes = new Map();
    this.bellShieldModes = new Map();
    this.shieldPressRockGuardCasts = new Set();
    this.bosses = {};
  }

  startRun(run) {
    this.currentRun = { ...run };
    run.team.forEach((id, index) => {
      if (!this.spirits[id]) return;
      this.spirits[id].selectedCount += 1;
      if (index < 3) this.spirits[id].starterCount += 1;
      else this.spirits[id].benchCount += 1;
    });
  }

  finishRun(cleared) {
    if (cleared && this.currentRun) {
      this.currentRun.team.forEach((id, index) => {
        if (!this.spirits[id]) return;
        this.spirits[id].winsWhenSelected += 1;
        if (index < 3) this.spirits[id].winsWhenStarter += 1;
        else this.spirits[id].winsWhenBench += 1;
      });
    }
    this.currentRun = null;
  }

  createBattleCollector(context) {
    const battle = {
      ...context,
      result: null,
      firstHealRound: null,
      firstSwitchRound: null,
      firstPlayerDeathRound: null,
      bossActions: 0,
      bossSkillIds: [],
      bossSkillDamage: {},
      bossSkillKills: {},
      bossSkillPowerUses: {},
      bossSkillHitCount: {},
      bossSkillTransferredHitCount: {},
      bossSkillDamageByPower: {},
      bossSkillKillsByPower: {},
      totalPlayerDamageTaken: 0,
      backRowDamageTotal: 0,
      bossDamageTaken: 0,
      exposedWindowDamageTotal: 0,
      exposedWindowHighCostSkillUses: 0,
      exposedWindowBurstSkillUses: 0,
      lockCreatedCount: 0,
      lockResponseSwapCount: 0,
      lockResponseRowSwitchCount: 0,
      pendingTelegraphs: [],
      unresolvedTelegraphReasons: {},
      forcedReplacements: 0,
      tacticalSwaps: 0,
      rowSwitches: 0,
      sameSkillRepeatMax: 0,
      sameSkillRepeatActions: 0,
      lastBossSkillId: null,
      currentBossSkillRepeat: 0,
      amplificationCount: 0,
      playerAttackActionsBeforeSecondAmp: 0,
      playerActionsBeforeSecondAmp: 0,
      playerAttackActionsAfterSecondAmp: 0,
      playerActionsAfterSecondAmp: 0,
      firstCasualtyPowerTier: null,
      lastBossAttackPower: null,
      forcedFollowups: 0,
      telegraphs: 0,
      collectorErrors: []
    };
    const safe = (fn) => (payload) => {
      try { fn(payload); } catch (error) { battle.collectorErrors.push(error instanceof Error ? error.message : String(error)); }
    };
    return {
      battle,
      collector: {
        onBattleStart: safe((event) => {
          event.activeSpiritIds.forEach((id) => {
            if (this.spirits[id]) this.spirits[id].enteredBattleCount += 1;
          });
          if (event.activeSpiritIds.includes('P08')) this.skillValidation.bellBlessing.entryQualifications += 1;
        }),
        onActionStart: safe((event) => {
          if (event.side === 'enemy') {
            battle.bossActions += 1;
            return;
          }
          const spirit = this.spirits[event.unitId];
          if (spirit) {
            if (event.actionContext === 'extra') spirit.extraActions += 1;
            else spirit.normalActions += 1;
          }
          if (event.actionContext === 'normal') {
            this.energy.playerActionStarts += 1;
            this.energy.energyAtPlayerActionStartTotal += event.mana;
            if (event.mana === 0) this.energy.zeroEnergyActionStarts += 1;
            if (event.mana === this.config.teamMana.max) this.energy.fullEnergyActionStarts += 1;
          }
        }),
        onSkillConfirmed: safe((event) => {
          const metric = this.skills[event.skillId];
          if (metric) {
            metric.uses += 1;
            metric.ownerSkillActions += 1;
            metric.configuredCostTotal += event.configuredCost ?? this.config.skillConfig[event.skillId]?.cost ?? 0;
            metric.actualCostTotal += event.actualCost;
            metric.energyRequested += event.energyGainRequested ?? 0;
            if (event.isFreeCast) metric.freeUses += 1;
            if (event.stateBeforeCast?.lastSkillId === event.skillId) metric.repeatedUses += 1;
            increment(metric.actualCostUseCounts, String(event.actualCost));
            if (event.enhanced && metric.enhancedUseCount !== null) metric.enhancedUseCount += 1;
          }
          if (event.skillId === 'M01-S2') {
            increment(this.skillValidation.chainSlash.costUseCounts, String(event.actualCost));
            if (event.actualCost === 0 && event.stateBeforeCast?.consecutiveUseCount === 2) this.skillValidation.chainSlash.completeCycles += 1;
          }
          if (event.actorId === 'P02' && event.stateBeforeCast?.damageAmpStacks > 0) {
            increment(this.skillValidation.windBurst.payoffUsesByStackCount, String(event.stateBeforeCast.damageAmpStacks));
          }
          if (event.skillId === 'M02-S3' && event.guaranteedCrit && event.stateBeforeCast?.damageAmpStacks > 0) {
            this.skillValidation.windBurst.stormGuaranteedCritUses += 1;
          }
          if (event.skillId === 'M06-S2') {
            this.skillValidation.ironSupport.uses += 1;
            if (event.enhanced) this.skillValidation.ironSupport.enhancedUses += 1;
          }
          if (event.skillId === 'M08-S3') {
            const mode = ['first_skill_after_entry', 'first_use_after_entry'].includes(event.freeCastReason) ? 'free' : 'paid';
            this.bellCastModes.set(event.skillCastId, mode);
            if (mode === 'free') this.skillValidation.bellBlessing.freeUses += 1;
            else this.skillValidation.bellBlessing.paidUses += 1;
          }
          if (event.skillId === 'M10-S3') {
            this.skillValidation.starReturn.uses += 1;
            if (event.freeCastReason === 'first_use_in_battle') this.skillValidation.starReturn.firstFreeUses += 1;
            else this.skillValidation.starReturn.paidUses += 1;
            this.skillValidation.starReturn.actualSpent += event.actualCost;
            increment(this.skillValidation.starReturn.usesByRound, String(event.round));
          }
          if (event.skillId === 'M10-S2') this.skillValidation.starArmor.uses += 1;
          if (event.skillId === 'M04-S2') this.skillValidation.shieldPress.uses += 1;
          if (event.skillId === 'M09-S3') this.skillValidation.vulnerability.applications += 1;
          if (['M06-S1', 'M09-S1', 'M10-S1'].includes(event.skillId)) {
            this.skillValidation.skillEnergy[event.skillId] ??= { uses: 0, requested: 0, actual: 0, overflow: 0, contributionRate: 0 };
            this.skillValidation.skillEnergy[event.skillId].uses += 1;
            this.skillValidation.skillEnergy[event.skillId].requested += event.energyGainRequested ?? 0;
          }
          const owner = this.config.creatureConfig.find((spirit) => spirit.id === event.actorId);
          owner?.skillIds.forEach((skillId) => {
            if (skillId !== event.skillId && this.skills[skillId]) this.skills[skillId].ownerSkillActions += 1;
          });
          this.energy.skillConfirms += 1;
          this.energy.energyAtSkillConfirmTotal += event.manaBefore;
          const attack = this.config.skillConfig[event.skillId]?.kind === 'attack';
          if (battle.amplificationCount < 2) {
            battle.playerActionsBeforeSecondAmp += 1;
            if (attack) battle.playerAttackActionsBeforeSecondAmp += 1;
          } else {
            battle.playerActionsAfterSecondAmp += 1;
            if (attack) battle.playerAttackActionsAfterSecondAmp += 1;
          }
          if (event.bossExposed) {
            if (event.actualCost >= 3) battle.exposedWindowHighCostSkillUses += 1;
            const skill = this.config.skillConfig[event.skillId];
            if (skill?.alwaysCrit || skill?.critIfDamageAmp || skill?.highHpCritThreshold !== undefined || event.enhanced) {
              battle.exposedWindowBurstSkillUses += 1;
            }
          }
        }),
        onSkillResolved: safe((event) => {
          if (event.skillId === 'M01-S2') {
            if (event.resetTrigger === 'zero_cost_cast') this.skillValidation.chainSlash.resetByZeroCostCast += 1;
          } else if (event.resetTrigger === 'other_skill_used' && event.actorId === 'P01') {
            this.skillValidation.chainSlash.resetByOtherSkill += 1;
          }
          if (event.skillId === 'M10-S3') {
            this.skillValidation.starReturn.actualGained += event.energyGainActual;
            this.skillValidation.starReturn.netEnergy += event.energyGainActual - event.actualCost;
          }
        }),
        onDamageResolved: safe((event) => {
          if (event.sourceSide === 'player') {
            if (this.spirits[event.sourceId]) this.spirits[event.sourceId].damageDealt += event.actual;
            if (this.skills[event.skillId]) this.skills[event.skillId].damageDealt += event.actual;
            battle.bossDamageTaken += event.actual;
            if (event.targetExposed) battle.exposedWindowDamageTotal += event.actual;
            if ((event.exposedMultiplier ?? 1) > 1) {
              this.skillValidation.exposure.coveredHits += 1;
              this.skillValidation.exposure.baseDamage += event.finalDamageWithoutTakenModifiers ?? event.actual;
              this.skillValidation.exposure.extraDamage += event.extraDamageFromExposed ?? 0;
            }
            if ((event.vulnerabilityMultiplier ?? 1) > 1) {
              this.skillValidation.vulnerability.coveredHits += 1;
              this.skillValidation.vulnerability.baseDamage += event.finalDamageWithoutVulnerability ?? event.actual;
              this.skillValidation.vulnerability.extraDamage += event.extraDamageFromVulnerability ?? 0;
              const instance = this.vulnerabilityInstances.get(event.activeVulnerabilityStatusInstanceId);
              if (instance) {
                instance.hits += 1;
                instance.rounds.add(event.round);
              }
            }
            if (event.skillId === 'M10-S2' && event.damageType === 'fixed') this.skillValidation.starArmor.fixedDamage += event.actual;
            return;
          }
          battle.totalPlayerDamageTaken += event.actual;
          if (event.targetRow === 'back') battle.backRowDamageTotal += event.actual;
          battle.bossSkillDamage[event.skillId] = (battle.bossSkillDamage[event.skillId] ?? 0) + event.actual;
          battle.bossSkillDamageByPower[event.skillId] ??= {};
          