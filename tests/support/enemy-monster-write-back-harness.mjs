export async function loadEnemyMonsterWriteBackHarness(viteServer) {
  const core = await viteServer.ssrLoadModule('/src/enemyMonsterAuthoringWriterCore.ts');
  return Object.freeze({
    readSourceAtPath: core.readEnemyMonsterAuthoringSourceAtPath,
    writeUpdateAtPath: core.writeEnemyMonsterAuthoringUpdateAtPath
  });
}
