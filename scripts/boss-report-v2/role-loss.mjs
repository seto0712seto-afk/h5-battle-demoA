export function analyzeRoleLoss(battle, metadataRegistry, rules = []) {
  const initial = metadataRegistry.roleWeights(battle.team);
  const alive = new Set(battle.team);
  const deathsByRound = new Map();
  for (const event of battle.events.filter((event) => event.eventType === 'unit_death' && event.metadata?.targetSide === 'player')) {
    if (!deathsByRound.has(event.round)) deathsByRound.set(event.round, []);
    deathsByRound.get(event.round).push(event.targetId);
  }
  const rounds = [];
  const formalDeaths = [];
  for (let round = 1; round <= battle.rounds; round += 1) {
    for (const id of deathsByRound.get(round) ?? []) {
      alive.delete(id);
      const unit = metadataRegistry.unit(id);
      if (unit?.roleSource === 'registered') {
        formalDeaths.push({ round, unitId: id, displayName: unit.displayName, primaryRole: unit.primaryRole, roleWeights: unit.roleWeights });
      }
    }
    const current = metadataRegistry.roleWeights([...alive]);
    const drop = Object.fromEntries(['damage', 'healing', 'protection', 'resource'].map((role) => [role, initial[role] > 0 ? 1 - current[role] / initial[role] : 0]));
    rounds.push({ round, aliveIds: [...alive], weights: current, drop });
  }
  const losses = rules.flatMap((rule) => {
    const role = metricRole(rule.metric);
    const first = rounds.find((entry) => entry.drop[role] >= rule.dropFromStart);
    return first ? [{ ruleId: rule.id, displayName: rule.displayName ?? rule.id, role, firstRound: first.round, drop: first.drop[role], remainingWeight: first.weights[role] }] : [];
  });
  const majorDamageLoss = losses.find((loss) => loss.ruleId === 'major_damage_loss');
  const damageDeaths = formalDeaths.filter((death) => death.primaryRole === 'damage');
  const protectionStillAliveAtDamageLoss = majorDamageLoss
    ? rounds.find((entry) => entry.round === majorDamageLoss.firstRound)?.weights.protection > initial.protection * 0.5
    : false;
  return {
    initial,
    rounds,
    losses,
    formalPrimaryDamageDeaths: damageDeaths,
    highDamageUnitDeaths: formalDeaths.filter((death) => death.roleWeights.damage >= 0.8),
    protectionStillAliveAtDamageLoss,
    residualMaintenance: Boolean(majorDamageLoss && rounds.at(-1)?.aliveIds.length > 0),
    metadataComplete: battle.team.every((id) => metadataRegistry.unit(id)?.roleSource === 'registered')
  };
}

function metricRole(metric) {
  const normalized = metric.replace(/^alive/, '').replace(/Weight$/, '');
  return normalized.charAt(0).toLowerCase() + normalized.slice(1);
}
