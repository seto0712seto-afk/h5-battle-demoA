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
          damageDealt: 0,
          effectiveHealing: 0,
          overheal: 0,
          shieldGranted: 0,
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
            if (event.enhanced && metric.enhancedUseCount !== null) metric.enhancedUseCount += 1;
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
        onDamageResolved: safe((event) => {
          if (event.sourceSide === 'player') {
            if (this.spirits[event.sourceId]) this.spirits[event.sourceId].damageDealt += event.actual;
            if (this.skills[event.skillId]) this.skills[event.skillId].damageDealt += event.actual;
            battle.bossDamageTaken += event.actual;
            if (event.targetExposed) battle.exposedWindowDamageTotal += event.actual;
            return;
          }
          battle.totalPlayerDamageTaken += event.actual;
          if (event.targetRow === 'back') battle.backRowDamageTotal += event.actual;
          battle.bossSkillDamage[event.skillId] = (battle.bossSkillDamage[event.skillId] ?? 0) + event.actual;
          battle.bossSkillDamageByPower[event.skillId] ??= {};
          const powerKey = String(event.power ?? 0);
          battle.bossSkillDamageByPower[event.skillId][powerKey] = (battle.bossSkillDamageByPower[event.skillId][powerKey] ?? 0) + event.actual;
          battle.lastBossAttackPower = event.power ?? battle.lastBossAttackPower;
        }),
        onHealingResolved: safe((event) => {
          if (event.effective > 0 && battle.firstHealRound === null) battle.firstHealRound = event.round;
          if (this.spirits[event.actorId]) {
            this.spirits[event.actorId].effectiveHealing += event.effective;
            this.spirits[event.actorId].overheal += event.overheal;
          }
          if (event.skillId && this.skills[event.skillId]) {
            this.skills[event.skillId].effectiveHealing += event.effective;
            this.skills[event.skillId].overheal += event.overheal;
          }
        }),
        onShieldGranted: safe((event) => {
          if (this.spirits[event.actorId]) this.spirits[event.actorId].shieldGranted += event.granted;
          if (event.skillId && this.skills[event.skillId]) this.skills[event.skillId].shieldGranted += event.granted;
        }),
        onEnergyChanged: safe((event) => {
          this.energy.attemptedGain += event.attemptedGain;
          this.energy.gained += event.gained;
          this.energy.spent += event.spent;
          this.energy.overflow += Math.max(0, event.attemptedGain - event.gained);
          if (event.source === 'action_start') this.energy.actionStartGained += event.gained;
          else this.energy.skillGained += event.gained;
          if (event.skillId) {
            this.energy.energyGeneratedBySkill[event.skillId] = (this.energy.energyGeneratedBySkill[event.skillId] ?? 0) + event.gained;
            if (this.skills[event.skillId]) {
              this.skills[event.skillId].energyGenerated += event.gained;
              this.skills[event.skillId].energyOverflow += Math.max(0, event.attemptedGain - event.gained);
            }
            if (event.actorId && this.spirits[event.actorId]) this.spirits[event.actorId].energyGenerated += event.gained;
          }
        }),
        onSwitchResolved: safe((event) => {
          if (!event.forced && battle.firstSwitchRound === null) battle.firstSwitchRound = event.round;
          if (event.outgoingId && this.spirits[event.outgoingId]) this.spirits[event.outgoingId].switchedOut += 1;
          if (this.spirits[event.incomingId]) {
            this.spirits[event.incomingId].enteredBattleCount += 1;
            if (!event.forced) this.spirits[event.incomingId].switchedIn += 1;
          }
          if (event.forced) battle.forcedReplacements += 1;
          else battle.tacticalSwaps += 1;
          if (!event.forced && battle.pendingTelegraphs.some((pending) => telegraphMatchesSwitch(pending, event))) {
            battle.lockResponseSwapCount += 1;
          }
        }),
        onRowSwitchResolved: safe((event) => {
          battle.rowSwitches += 1;
          if (battle.pendingTelegraphs.some((pending) => telegraphMatchesRowSwitch(pending, event))) {
            battle.lockResponseRowSwitchCount += 1;
          }
        }),
        onUnitDefeated: safe((event) => {
          if (event.side !== 'player') return;
          if (battle.firstPlayerDeathRound === null) battle.firstPlayerDeathRound = event.round;
          if (battle.firstCasualtyPowerTier === null) battle.firstCasualtyPowerTier = battle.lastBossAttackPower;
          battle.bossSkillKills[event.skillId] = (battle.bossSkillKills[event.skillId] ?? 0) + 1;
          battle.bossSkillKillsByPower[event.skillId] ??= {};
          const powerKey = String(battle.lastBossAttackPower ?? 0);
          battle.bossSkillKillsByPower[event.skillId][powerKey] = (battle.bossSkillKillsByPower[event.skillId][powerKey] ?? 0) + 1;
          if (this.spirits[event.unitId]) this.spirits[event.unitId].deaths += 1;
        }),
        onBossSkillUsed: safe((event) => {
          battle.bossSkillIds.push(event.skillId);
          battle.bossSkillPowerUses[event.skillId] ??= {};
          battle.bossSkillPowerUses[event.skillId][event.power] = (battle.bossSkillPowerUses[event.skillId][event.power] ?? 0) + 1;
          if (event.telegraph) {
            battle.telegraphs += 1;
            battle.lockCreatedCount += 1;
            battle.pendingTelegraphs.push({
              skillId: event.skillId,
              targetIds: [...event.targetIds],
              lockedTargetId: event.lockedTargetId,
              lockedSlotIndex: event.lockedSlotIndex,
              lockedOriginSlotIndex: event.lockedOriginSlotIndex
            });
          }
          if (event.source === 'forced_followup') {
            battle.forcedFollowups += 1;
            const pending = battle.pendingTelegraphs.shift();
            battle.bossSkillHitCount[event.skillId] = (battle.bossSkillHitCount[event.skillId] ?? 0) + event.targetIds.length;
            if (pending?.targetIds?.[0] && event.targetIds[0] && pending.targetIds[0] !== event.targetIds[0]) {
              battle.bossSkillTransferredHitCount[event.skillId] = (battle.bossSkillTransferredHitCount[event.skillId] ?? 0) + 1;
            }
            if (event.unresolvedReason) increment(battle.unresolvedTelegraphReasons, event.unresolvedReason);
          }
          if (!event.telegraph) {
            if (event.source !== 'forced_followup') {
              battle.bossSkillHitCount[event.skillId] = (battle.bossSkillHitCount[event.skillId] ?? 0) + event.targetIds.length;
            }
            if (battle.lastBossSkillId === event.skillId) {
              battle.currentBossSkillRepeat += 1;
              battle.sameSkillRepeatActions += 1;
            } else {
              battle.lastBossSkillId = event.skillId;
              battle.currentBossSkillRepeat = 1;
            }
            battle.sameSkillRepeatMax = Math.max(battle.sameSkillRepeatMax, battle.currentBossSkillRepeat);
            battle.lastBossAttackPower = event.power;
          }
          if (event.skillId === 'MAGE_BOSS_MANA_EXPANSION') battle.amplificationCount += 1;
        })
      }
    };
  }

  recordEnhancedAvailability(game, actorId) {
    const actor = game.getSpirit(actorId);
    const owner = this.config.creatureConfig.find((spirit) => spirit.id === actorId);
    if (!actor || !owner) return;
    owner.skillIds.forEach((skillId) => {
      const metric = this.skills[skillId];
      const skill = this.config.skillConfig[skillId];
      if (!metric || !skill || metric.enhancedAvailableCount === null) return;
      const targets = skill.target === 'boss'
        ? game.getLegalEnemyTargetIds()
        : skill.target === 'ally-field'
          ? game.getHealTargets()
          : [undefined];
      const enhanced = targets.some((targetId) => game.getSkillButtonState(skill, actor, targetId).enhanced);
      if (enhanced) metric.enhancedAvailableCount += 1;
    });
  }

  finishBattle(handle, result, game) {
    const battle = handle.battle;
    battle.result = result.victory ? 'victory' : 'defeat';
    battle.rounds = result.rounds;
    battle.finalAliveCount = result.survivingSpirits;
    battle.finalTeamHpRatio = result.totalMaxHp > 0 ? result.totalRemainingHp / result.totalMaxHp : 0;
    battle.finalMana = result.finalMana;
    battle.bossRemainingHpRatio = result.bossRemainingHpRatio ?? 0;
    battle.playerActions = result.playerActions;
    battle.skillUses = { ...(result.skillUses ?? {}) };
    battle.over15Rounds = result.rounds > 15;
    battle.over20Rounds = result.rounds > 20;
    if (battle.pendingTelegraphs.length > 0) {
      const reason = result.victory ? 'boss-defeated-before-cast' : 'battle-ended';
      battle.pendingTelegraphs.forEach(() => increment(battle.unresolvedTelegraphReasons, reason));
      battle.pendingTelegraphs = [];
    }
    battle.errors = [...result.errors, ...handle.battle.collectorErrors.map((message) => ({ message }))];
    battle.enemyDefinitionIds = result.enemyIds;
    battle.telemetryErrors = game.getTelemetryErrors();
    this.battles.push(battle);
    battle.errors.forEach((error) => this.runtimeAnomalies.push({
      seed: battle.seed,
      stage: battle.stage,
      result: battle.result,
      rounds: battle.rounds,
      team: [...battle.team],
      reason: error.message ?? 'runtime_error'
    }));
    battle.telemetryErrors.forEach((message) => this.runtimeAnomalies.push({
      seed: battle.seed,
      stage: battle.stage,
      result: battle.result,
      rounds: battle.rounds,
      team: [...battle.team],
      reason: `telemetry_error: ${message}`
    }));
    this.validateBattleState(battle, game);
  }

  validateBattleState(battle, game) {
    const invalid = [];
    if (!Number.isFinite(game.state.mana.current) || game.state.mana.current < 0 || game.state.mana.current > game.state.mana.max) invalid.push('invalid_mana');
    Object.values(game.state.spirits).forEach((spirit) => {
      const maxHp = this.config.creatureConfig.find((item) => item.id === spirit.id)?.maxHp ?? 0;
      if (!Number.isFinite(spirit.hp) || spirit.hp < 0 || spirit.hp > maxHp) invalid.push(`invalid_hp:${spirit.id}`);
      Object.values(spirit.statuses).forEach((status) => {
        if (!Number.isFinite(status.duration) || status.duration < 0) invalid.push(`invalid_status_duration:${spirit.id}:${status.id}`);
      });
    });
    invalid.forEach((reason) => this.runtimeAnomalies.push({
      seed: battle.seed,
      stage: battle.stage,
      result: battle.result,
      rounds: battle.rounds,
      team: [...battle.team],
      reason
    }));
  }

  finalize(rawSummary, thresholds, baseline = null, metadata = {}) {
    Object.values(this.spirits).forEach((metric) => {
      metric.winRateWhenSelected = ratio(metric.winsWhenSelected, metric.selectedCount);
      metric.winRateWhenStarter = ratio(metric.winsWhenStarter, metric.starterCount);
      metric.winRateWhenBench = ratio(metric.winsWhenBench, metric.benchCount);
    });
    Object.values(this.skills).forEach((metric) => {
      metric.useShareOfOwnerSkillActions = ratio(metric.uses, metric.ownerSkillActions);
      if (metric.enhancedAvailableCount !== null) {
        metric.enhancedConversionRate = ratio(metric.enhancedUseCount, metric.enhancedAvailableCount);
      }
    });
    this.energy.overflowRate = ratio(this.energy.overflow, this.energy.attemptedGain);
    this.energy.averageEnergyAtPlayerActionStart = ratio(this.energy.energyAtPlayerActionStartTotal, this.energy.playerActionStarts);
    this.energy.zeroEnergyActionStartRate = ratio(this.energy.zeroEnergyActionStarts, this.energy.playerActionStarts);
    this.energy.fullEnergyActionStartRate = ratio(this.energy.fullEnergyActionStarts, this.energy.playerActionStarts);
    this.energy.averageEnergyAtSkillConfirm = ratio(this.energy.energyAtSkillConfirmTotal, this.energy.skillConfirms);

    const stages = Object.fromEntries([1, 2, 3, 4, 5].map((stage) => {
      const rows = this.battles.filter((battle) => battle.stage === stage);
      const rounds = rows.map((battle) => battle.rounds);
      return [stage, {
        reached: rows.length,
        clears: rows.filter((battle) => battle.result === 'victory').length,
        clearRateFromReached: ratio(rows.filter((battle) => battle.result === 'victory').length, rows.length),
        averageRounds: average(rounds),
        medianRounds: percentile(rounds, 0.5),
        p75Rounds: percentile(rounds, 0.75),
        p90Rounds: percentile(rounds, 0.9),
        p95Rounds: percentile(rounds, 0.95),
        over15RoundsRate: ratio(rows.filter((battle) => battle.over15Rounds).length, rows.length),
        over20RoundsRate: ratio(rows.filter((battle) => battle.over20Rounds).length, rows.length),
        firstHealRoundAverage: nullableAverage(rows.map((battle) => battle.firstHealRound)),
        firstSwitchRoundAverage: nullableAverage(rows.map((battle) => battle.firstSwitchRound)),
        firstPlayerDeathRoundAverage: nullableAverage(rows.map((battle) => battle.firstPlayerDeathRound)),
        finalAliveCountAverage: average(rows.map((battle) => battle.finalAliveCount)),
        finalTeamHpRatioAverage: average(rows.map((battle) => battle.finalTeamHpRatio)),
        victoryFinalHpRatioAverage: average(rows.filter((battle) => battle.result === 'victory').map((battle) => battle.finalTeamHpRatio)),
        defeatBossRemainingHpRatioAverage: average(rows.filter((battle) => battle.result === 'defeat').map((battle) => battle.bossRemainingHpRatio)),
        longestVictory: battleExtreme(rows.filter((battle) => battle.result === 'victory'), 'max'),
        longestDefeat: battleExtreme(rows.filter((battle) => battle.result === 'defeat'), 'max')
      }];
    }));

    const bossIds = [...new Set(this.battles
      .flatMap((battle) => battle.enemyDefinitionIds)
      .filter((enemyId) => this.options.monsters?.[enemyId]?.category === 'boss'))];
    bossIds.forEach((bossId) => {
      const rows = this.battles.filter((battle) => battle.enemyDefinitionIds.includes(bossId));
      const definition = this.options.monsters?.[bossId];
      const allSkillIds = [...new Set([
        ...(definition?.skills?.map((entry) => entry.skillId) ?? []),
        ...(definition?.actionCycle?.forcedSkillId ? [definition.actionCycle.forcedSkillId] : []),
        ...(CORE_MECHANICS[bossId] ?? []),
        ...rows.flatMap((battle) => battle.bossSkillIds)
      ])];
      const required = CORE_MECHANICS[bossId] ?? [];
      const skillUses = Object.fromEntries(allSkillIds.map((skillId) => [skillId, rows.reduce((sum, battle) => sum + battle.bossSkillIds.filter((id) => id === skillId).length, 0)]));
      const skillAppearanceRate = Object.fromEntries(allSkillIds.map((skillId) => [skillId, ratio(rows.filter((battle) => battle.bossSkillIds.includes(skillId)).length, rows.length)]));
      const telegraphCount = rows.reduce((sum, battle) => sum + battle.telegraphs, 0);
      this.bosses[bossId] = {
        battlesReached: rows.length,
        bossActionsAverage: average(rows.map((battle) => battle.bossActions)),
        skillUses,
        skillAppearanceRate,
        forcedFollowupResolvedRate: telegraphCount > 0 ? ratio(rows.reduce((sum, battle) => sum + battle.forcedFollowups, 0), telegraphCount) : null,
        coreMechanicSeenRate: required.length > 0 ? ratio(rows.filter((battle) => required.every((skillId) => battle.bossSkillIds.includes(skillId))).length, rows.length) : null,
        mechanics: buildBossMechanics(bossId, rows)
      };
      if (bossId === 'MAGE_BOSS') {
        const counts = rows.map((battle) => battle.bossSkillIds.filter((id) => id === 'MAGE_BOSS_MANA_EXPANSION').length);
        this.bosses[bossId].amplifyCountAverage = average(counts);
        this.bosses[bossId].firstAmplifySeenRate = ratio(counts.filter((count) => count >= 1).length, counts.length);
        this.bosses[bossId].secondAmplifySeenRate = ratio(counts.filter((count) => count >= 2).length, counts.length);
      }
    });

    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      commit: metadata.commit ?? 'local',
      branch: metadata.branch ?? 'project-main',
      seedMode: 'fixed',
      seedBase: this.options.seedBase,
      seedFormula: 'seedBase + (index + 1) * 7919 (uint32)',
      runs: this.options.runs,
      ruleset: null,
      summary: rawSummary.overview,
      stages,
      spirits: this.spirits,
      skills: this.skills,
      energy: this.energy,
      bosses: this.bosses,
      battleRecords: this.battles.map((battle) => battleRecord(battle)),
      warnings: [],
      baselineComparison: null,
      outliers: this.buildOutliers()
    };
    report.baselineComparison = compareBaseline(report, baseline, thresholds);
    report.warnings = buildWarnings(report, thresholds);
    return sanitizeJson(report);
  }

  buildOutliers() {
    const base = (battle, reason) => ({ seed: battle.seed, stage: battle.stage, result: battle.result, rounds: battle.rounds, team: [...battle.team], reason });
    const longestBattles = [...this.battles].sort((a, b) => b.rounds - a.rounds).slice(0, 20).map((battle) => base(battle, 'longest_battle'));
    const shortestClears = this.battles.filter((battle) => battle.result === 'victory').sort((a, b) => a.rounds - b.rounds).slice(0, 20).map((battle) => base(battle, 'shortest_clear'));
    const representativeDefeats = this.battles.filter((battle) => battle.result === 'defeat').sort((a, b) => b.stage - a.stage || b.rounds - a.rounds).slice(0, 20).map((battle) => base(battle, 'representative_defeat'));
    return { longestBattles, shortestClears, representativeDefeats, runtimeAnomalies: this.runtimeAnomalies.slice(0, 200) };
  }
}

function buildBossMechanics(bossId, rows) {
  const sum = (key) => rows.reduce((total, battle) => total + (battle[key] ?? 0), 0);
  const skillUses = (skillId) => rows.reduce((total, battle) => total + battle.bossSkillIds.filter((id) => id === skillId).length, 0);
  const skillMapTotal = (key, skillId) => rows.reduce((total, battle) => total + (battle[key]?.[skillId] ?? 0), 0);
  const common = {
    lockCreatedCount: sum('lockCreatedCount'),
    lockResponseSwapCount: sum('lockResponseSwapCount'),
    lockResponseRowSwitchCount: sum('lockResponseRowSwitchCount'),
    effectiveLockResponseRate: ratio(sum('lockResponseSwapCount'), sum('lockCreatedCount')),
    observedRowSwitchRate: ratio(sum('lockResponseRowSwitchCount'), sum('lockCreatedCount')),
    unresolvedTelegraphReasons: mergeCountMaps(rows.map((battle) => battle.unresolvedTelegraphReasons))
  };

  if (bossId === 'FORGE_BOSS_WARRIOR') {
    const heat = 'FORGE_BOSS_MOUNTAIN_CLEAVE';
    return {
      ...common,
      chargeCount: skillUses('FORGE_BOSS_MOUNTAIN_CHARGE'),
      exposedWindowCount: skillUses('FORGE_BOSS_MOUNTAIN_CHARGE'),
      exposedWindowDamageTotal: sum('exposedWindowDamageTotal'),
      exposedWindowDamageShare: ratio(sum('exposedWindowDamageTotal'), sum('bossDamageTaken')),
      exposedWindowHighCostSkillUses: sum('exposedWindowHighCostSkillUses'),
      exposedWindowBurstSkillUses: sum('exposedWindowBurstSkillUses'),
      highHeatCastCount: skillUses(heat),
      highHeatHitCount: skillMapTotal('bossSkillHitCount', heat),
      highHeatTransferredHitCount: skillMapTotal('bossSkillTransferredHitCount', heat),
      highHeatMissCount: Math.max(0, skillUses(heat) - skillMapTotal('bossSkillHitCount', heat)),
      highHeatKillCount: skillMapTotal('bossSkillKills', heat)
    };
  }

  if (bossId === 'RANGE_BOSS_SHOOTER') {
    const volley = 'RANGE_BOSS_VOLLEY';
    const snipe = 'RANGE_BOSS_PIERCING_RAIN';
    const piercing = 'RANGE_BOSS_SKYFALL';
    return {
      ...common,
      backRowDamageTotal: sum('backRowDamageTotal'),
      backRowDamageShare: ratio(sum('backRowDamageTotal'), sum('totalPlayerDamageTaken')),
      arrowRainCastCount: skillUses(volley),
      arrowRainDamageTotal: skillMapTotal('bossSkillDamage', volley),
      snipeCastCount: skillUses(snipe),
      snipeDamageTotal: skillMapTotal('bossSkillDamage', snipe),
      snipeKillCount: skillMapTotal('bossSkillKills', snipe),
      snipeKillRate: ratio(skillMapTotal('bossSkillKills', snipe), skillUses(snipe)),
      piercingShotCastCount: skillUses(piercing),
      piercingShotDamageTotal: skillMapTotal('bossSkillDamage', piercing),
      piercingShotHitCount: skillMapTotal('bossSkillHitCount', piercing),
      piercingShotTransferredHitCount: skillMapTotal('bossSkillTransferredHitCount', piercing),
      piercingShotMissCount: Math.max(0, skillUses(piercing) - skillMapTotal('bossSkillHitCount', piercing)),
      piercingShotKillCount: skillMapTotal('bossSkillKills', piercing),
      piercingShotKillRate: ratio(skillMapTotal('bossSkillKills', piercing), skillUses(piercing)),
      sameSkillRepeatMax: Math.max(0, ...rows.map((battle) => battle.sameSkillRepeatMax)),
      sameSkillRepeatActions: sum('sameSkillRepeatActions'),
      over20Rounds: rows.filter((battle) => battle.over20Rounds).length,
      over20RoundSamples: rows.filter((battle) => battle.over20Rounds).slice(0, 50).map((battle) => ({
        seed: battle.seed,
        rounds: battle.rounds,
        teamId: battle.teamId ?? null,
        team: [...battle.team],
        result: battle.result,
        primarySkillLoop: Object.entries(battle.skillUses ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([skillId, uses]) => ({ skillId, uses }))
      }))
    };
  }

  if (bossId === 'MAGE_BOSS') {
    const pulse = 'MAGE_BOSS_ARCANE_BOLT';
    const amplificationCount = sum('amplificationCount');
    const firstCasualtyPowerTierDistribution = {};
    rows.forEach((battle) => {
      if (battle.firstCasualtyPowerTier !== null) increment(firstCasualtyPowerTierDistribution, String(battle.firstCasualtyPowerTier));
    });
    return {
      ...common,
      amplificationCount,
      victoryAmplificationAverage: average(rows.filter((battle) => battle.result === 'victory').map((battle) => battle.amplificationCount)),
      defeatAmplificationAverage: average(rows.filter((battle) => battle.result === 'defeat').map((battle) => battle.amplificationCount)),
      pulsePowerUses: mergeNestedCountMaps(rows.map((battle) => battle.bossSkillPowerUses[pulse] ?? {})),
      pulseDamageByTier: mergeNestedCountMaps(rows.map((battle) => battle.bossSkillDamageByPower[pulse] ?? {})),
      pulseKillsByTier: mergeNestedCountMaps(rows.map((battle) => battle.bossSkillKillsByPower[pulse] ?? {})),
      firstCasualtyPowerTierDistribution,
      playerAttackShareBeforeSecondAmp: ratio(sum('playerAttackActionsBeforeSecondAmp'), sum('playerActionsBeforeSecondAmp')),
      playerAttackShareAfterSecondAmp: ratio(sum('playerAttackActionsAfterSecondAmp'), sum('playerActionsAfterSecondAmp'))
    };
  }
  return common;
}

function battleRecord(battle) {
  return {
    bossId: battle.enemyDefinitionIds?.[0] ?? '',
    policy: battle.policy ?? '',
    playerTendency: battle.playerTendency ?? 'balanced',
    teamId: battle.teamId ?? '',
    team: [...battle.team],
    seed: battle.seed,
    victory: battle.result === 'victory',
    rounds: battle.rounds,
    playerActions: battle.playerActions,
    bossActions: battle.bossActions,
    firstCasualtyRound: battle.firstPlayerDeathRound,
    survivingSpirits: battle.finalAliveCount,
    finalHpRatio: battle.finalTeamHpRatio,
    bossRemainingHpRatio: battle.bossRemainingHpRatio,
    finalMana: battle.finalMana,
    forcedReplacements: battle.forcedReplacements,
    tacticalSwaps: battle.tacticalSwaps,
    rowSwitches: battle.rowSwitches,
    over15Rounds: battle.over15Rounds,
    over20Rounds: battle.over20Rounds,
    errors: [...battle.errors],
    mechanics: {
      bossSkillDamage: { ...battle.bossSkillDamage },
      bossSkillKills: { ...battle.bossSkillKills },
      backRowDamageTotal: battle.backRowDamageTotal,
      exposedWindowDamageTotal: battle.exposedWindowDamageTotal,
      lockCreatedCount: battle.lockCreatedCount,
      lockResponseSwapCount: battle.lockResponseSwapCount,
      lockResponseRowSwitchCount: battle.lockResponseRowSwitchCount,
      unresolvedTelegraphReasons: { ...battle.unresolvedTelegraphReasons },
      amplificationCount: battle.amplificationCount,
      firstCasualtyPowerTier: battle.firstCasualtyPowerTier
    }
  };
}

function telegraphMatchesSwitch(pending, event) {
  return Boolean(
    (pending.lockedTargetId && pending.lockedTargetId === event.outgoingId) ||
    pending.lockedSlotIndex === event.slotIndex ||
    pending.lockedOriginSlotIndex === event.slotIndex
  );
}

function telegraphMatchesRowSwitch(pending, event) {
  return Boolean(
    (pending.lockedTargetId && pending.lockedTargetId === event.unitId) ||
    pending.lockedSlotIndex === event.slotIndex ||
    pending.lockedOriginSlotIndex === event.slotIndex
  );
}

function increment(target, key, amount = 1) {
  target[key] = (target[key] ?? 0) + amount;
}

function mergeCountMaps(maps) {
  const result = {};
  maps.forEach((map) => Object.entries(map ?? {}).forEach(([key, value]) => increment(result, key, value)));
  return result;
}

function mergeNestedCountMaps(maps) {
  return mergeCountMaps(maps);
}

function battleExtreme(rows, mode) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => mode === 'max' ? b.rounds - a.rounds : a.rounds - b.rounds);
  const battle = sorted[0];
  return { seed: battle.seed, rounds: battle.rounds, teamId: battle.teamId ?? null, team: [...battle.team] };
}

export function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (percentileValue === 0.5 && sorted.length % 2 === 0) {
    const upper = sorted.length / 2;
    return round((sorted[upper - 1] + sorted[upper]) / 2);
  }
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function hasEnhancementMechanic(skill) {
  return Boolean(
    skill.kind === 'attack' || skill.enhanceRules?.length || skill.fullManaCostReduction || skill.fullManaPowerBonusRatio ||
    skill.fullManaHealBonusPercent || skill.fullManaCrit || skill.highHpCritThreshold !== undefined ||
    skill.critIfDamageAmp || skill.shieldToFixedDamageRatio || skill.consecutiveUseCostReduction ||
    skill.consecutivePowerBonus || skill.firstUseInBattleCostReduction || skill.firstSkillAfterEntryCostReduction
  );
}

function buildWarnings(report, thresholds) {
  const warnings = [];
  Object.values(report.skills).forEach((skill) => {
    if (skill.ownerSkillActions >= thresholds.rareSkillMinOwnerActions && skill.useShareOfOwnerSkillActions > thresholds.dominantSkillShare) {
      warnings.push(warning('warning', 'DOMINANT_SKILL', skill.skillId, skill.useShareOfOwnerSkillActions, thresholds.dominantSkillShare));
    }
    if (skill.ownerSkillActions >= thresholds.rareSkillMinOwnerActions && skill.useShareOfOwnerSkillActions < thresholds.rareSkillShare) {
      warnings.push(warning('warning', 'RARELY_USED_SKILL', skill.skillId, skill.useShareOfOwnerSkillActions, thresholds.rareSkillShare));
    }
    if (skill.enhancedAvailableCount > 0 && skill.enhancedConversionRate < thresholds.rareSkillShare) {
      warnings.push(warning('info', 'ENHANCED_WINDOW_NOT_CONVERTED', skill.skillId, skill.enhancedConversionRate, thresholds.rareSkillShare));
    }
  });
  if (report.energy.overflowRate > thresholds.energyOverflowRate) {
    warnings.push(warning('warning', 'HIGH_ENERGY_OVERFLOW', 'team_energy', report.energy.overflowRate, thresholds.energyOverflowRate));
  }
  Object.entries(report.bosses).forEach(([bossId, boss]) => {
    if (boss.coreMechanicSeenRate !== null && boss.coreMechanicSeenRate < thresholds.bossCoreMechanicSeenRate) {
      warnings.push(warning('warning', 'BOSS_MECHANIC_NOT_SEEN', bossId, boss.coreMechanicSeenRate, thresholds.bossCoreMechanicSeenRate));
    }
  });
  Object.values(report.spirits).forEach((spirit) => {
    if (spirit.selectedCount > 0 && spirit.enteredBattleCount === 0) warnings.push(warning('info', 'SPIRIT_SELECTED_BUT_NOT_ENTERED', spirit.spiritId, 0, 1));
  });
  report.baselineComparison?.warnings?.forEach((item) => warnings.push(item));
  return warnings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.code.localeCompare(b.code));
}

function compareBaseline(report, baseline, thresholds) {
  if (!baseline) return null;
  if (baseline.schemaVersion !== report.schemaVersion) return { compatible: false, reason: 'schema_version_mismatch', warnings: [] };
  const warnings = [];
  Object.entries(report.stages).forEach(([stage, current]) => {
    const previous = baseline.stages?.[stage];
    if (!previous) return;
    const roundsDelta = current.averageRounds - previous.averageRounds;
    const clearDelta = current.clearRateFromReached - previous.clearRateFromReached;
    if (Math.abs(roundsDelta) > thresholds.averageRoundsDelta) warnings.push(warning('warning', 'ROUND_PACING_CHANGED', `stage_${stage}`, roundsDelta, thresholds.averageRoundsDelta));
    if (Math.abs(clearDelta) > thresholds.clearRateDelta) warnings.push(warning('warning', 'CLEAR_RATE_CHANGED', `stage_${stage}`, clearDelta, thresholds.clearRateDelta));
  });
  return { compatible: true, warnings };
}

function warning(severity, code, subject, value, threshold) {
  return { severity, code, subject, value: round(value), threshold };
}

function severityRank(value) { return value === 'error' ? 3 : value === 'warning' ? 2 : 1; }
function ratio(value, total) { return total > 0 ? round(value / total) : 0; }
function average(values) { return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null; }
function nullableAverage(values) { return average(values.filter((value) => value !== null && value !== undefined)); }
function round(value) { return Math.round(value * 10000) / 10000; }

export function sanitizeJson(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'number' && !Number.isFinite(item) ? null : item));
}
