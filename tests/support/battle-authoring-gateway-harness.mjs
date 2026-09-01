export async function loadBattleAuthoringGatewayHarness(viteServer) {
  const [gatewayCore, adapterModule, playerCore, enemyCore] = await Promise.all([
    viteServer.ssrLoadModule('/src/battleAuthoringGatewayCore.ts'),
    viteServer.ssrLoadModule('/src/battleAuthoringGatewayAdapter.ts'),
    viteServer.ssrLoadModule('/src/playerSpiritAuthoringWriterCore.ts'),
    viteServer.ssrLoadModule('/src/enemyMonsterAuthoringWriterCore.ts')
  ]);

  return Object.freeze({
    createFixtureAdapter({ playerSourcePath, enemySourcePath }) {
      return adapterModule.createBattleAuthoringGatewayAdapter({
        readPlayerSpirits: () => playerCore.readPlayerSpiritAuthoringSourceAtPath(playerSourcePath),
        readEnemies: () => enemyCore.readEnemyMonsterAuthoringSourceAtPath(enemySourcePath),
        writePlayerSpirit: ({ expectedRevision, candidate }) => playerCore.writePlayerSpiritAuthoringUpdateAtPath({
          sourcePath: playerSourcePath,
          expectedRevision,
          candidate
        }),
        writeEnemy: ({ expectedRevision, candidate }) => enemyCore.writeEnemyMonsterAuthoringUpdateAtPath({
          sourcePath: enemySourcePath,
          expectedRevision,
          candidate
        })
      });
    },
    start(adapter, port = 0) {
      return gatewayCore.startBattleAuthoringGatewayServer(adapter, { port });
    },
    readPlayerSourceAtPath: playerCore.readPlayerSpiritAuthoringSourceAtPath,
    readEnemySourceAtPath: enemyCore.readEnemyMonsterAuthoringSourceAtPath,
    maxBodyBytes: gatewayCore.BATTLE_AUTHORING_GATEWAY_MAX_BODY_BYTES
  });
}
