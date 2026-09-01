import { createBattleAuthoringGatewayAdapter } from './battleAuthoringGatewayAdapter';
import {
  BATTLE_AUTHORING_GATEWAY_API_VERSION,
  BATTLE_AUTHORING_GATEWAY_LOOPBACK_HOST,
  startBattleAuthoringGatewayServer
} from './battleAuthoringGatewayCore';
import { readEnemyMonsterAuthoringSource, writeEnemyMonsterAuthoringUpdate } from './enemyMonsterAuthoringWriter';
import { readPlayerSpiritAuthoringSource, writePlayerSpiritAuthoringUpdate } from './playerSpiritAuthoringWriter';

export { BATTLE_AUTHORING_GATEWAY_API_VERSION } from './battleAuthoringGatewayCore';

export const BATTLE_AUTHORING_GATEWAY_HOST = BATTLE_AUTHORING_GATEWAY_LOOPBACK_HOST;
export const BATTLE_AUTHORING_GATEWAY_DEFAULT_PORT = 4176;

const productionAdapter = createBattleAuthoringGatewayAdapter({
  readPlayerSpirits: readPlayerSpiritAuthoringSource,
  readEnemies: readEnemyMonsterAuthoringSource,
  writePlayerSpirit: writePlayerSpiritAuthoringUpdate,
  writeEnemy: writeEnemyMonsterAuthoringUpdate
});

export function startBattleAuthoringGateway(options: { port?: number } = {}) {
  return startBattleAuthoringGatewayServer(productionAdapter, {
    port: options.port ?? BATTLE_AUTHORING_GATEWAY_DEFAULT_PORT
  });
}
