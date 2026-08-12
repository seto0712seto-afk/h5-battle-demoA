# H5 Demo 核心战斗验证版

当前项目只维护一套正式战斗主线：回合行动位、团队妖力、十只候选精灵、三主题副本与随机副本怪物系统。旧异步系统、系统2、四拍验证与 R0 实验不再进入运行代码。

## 当前流程

```text
战前准备 → 副本选择 → 五场连续战斗 → 副本结算
```

- 玩家从 10 只候选精灵中选择 1 至 6 只，前 3 只首发，其余进入后备。
- 回合开始时按速度锁定场上玩家与每只敌人的行动顺序。
- 团队妖力初始 0、上限 10；单位正常行动开始获得 1 妖力，达到 5 时进入充盈。
- 玩家可以使用技能、换宠和切换前后排。
- 三套固定主题副本分别为熔核工坊、雷鸣矿区、苔生遗迹；万象裂隙按 Seed 生成阵容。
- 怪物按权重选择普通行为；预告技能会在下一次行动强制兑现，法师成长直接修改运行时技能威力。
- 死亡单位立即离场，空位在回合结束时统一补位。

当前唯一规则基线见 [docs/当前规则基线_同步GPT_v1.0_20260723.md](docs/当前规则基线_同步GPT_v1.0_20260723.md)。配置入口见 [docs/数据与技能修改指南.md](docs/数据与技能修改指南.md)。

## 本地启动

首次运行：

```powershell
npm.cmd install
npm.cmd run dev
```

浏览器打开 `http://127.0.0.1:5173/`。

PowerShell 如果阻止 `npm.ps1`，继续使用上述 `npm.cmd` 命令即可。

## 局域网测试

运行：

```powershell
npm.cmd run lan:sync
npm.cmd run lan:serve
```

将运行电脑的 IPv4 地址和端口 `5174` 发给同一网络下的测试者，例如 `http://192.168.x.x:5174/`。Windows 防火墙询问时需要允许 Node.js 访问专用网络。

## 验证与网页打包

```powershell
npm.cmd test
npm.cmd run build
```

生产文件生成在 `dist/`。项目是纯前端静态页面，可部署到 Vercel 或 Netlify。

## Windows 桌面版

生成无需安装 Node.js 的便携式 EXE：

```powershell
npm.cmd run desktop:build
```

输出文件：

```text
desktop-release/Liuli-Battle-Demo-1.0.0-win-x64.exe
```

当前测试版尚未购买代码签名证书，从网络下载后 Windows 可能显示“未知发布者”提示。

## 配置来源

- 玩家精灵和玩家技能：`src/data.ts`
- 正式怪物、技能与随机池：`src/monsterData.ts`
- 怪物运行时与 Seed：`src/monsterSystem.ts`
- 关卡：`src/stages.ts`
- 核心战斗：`src/battle.ts`、`src/coreBattleRules.ts`

修改配置后执行 `npm.cmd test` 与 `npm.cmd run build`。

## 当前边界

本版不包含系统2、四拍/R0实验、灵玉、装备、养成、道具效果、自动战斗或后端服务。
