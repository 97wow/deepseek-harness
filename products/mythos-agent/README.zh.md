# Mythos Agent

[English](README.md) | 中文

Mythos Agent 是基于 DeepSeek Harness 的专用 coding agent（编程智能体）产品。本目录拥有 Mythos 组合、评测套件、证据飞轮、发布流程和战略总控；可复用的 agent 运行时能力仍位于仓库 `packages/` 工作区。

## 产品状态

产品 manifest 版本为 `0.1.1`，固定 DeepSeek Harness `0.1.0-rc.8`。源码与自包含 Headless/Web 运行面、可恢复交互式 CLI、可重复评测基础设施、内容完整性验证发布包和总控决策内核已存在。MYTHOS Desktop 当前为 `0.2.0-beta.7`，已具备归档式自包含 Runtime、受控服务路由、签名热配置和经过真实验收的应用更新。当前工作是刷新付费评测证据、完善真实仓库与服务端数据发布门禁，以及将总控连接到真实项目状态与 Lead 端口。

可维护的项目计划和证据化进度见[项目文档](docs/项目文档索引.md)。该文档当前面向项目所有者使用简体中文维护。

## 前置条件

- Node.js `^22.19.0 || >=24.0.0`。
- 使用根目录固定的 pnpm 版本安装仓库依赖。
- 源码启动需要完成仓库根构建，因为源码启动器执行 `apps/cli/lib/bin.js`；解压的发布包自带运行闭包。
- 真实模型运行需要环境变量或被忽略的根 `.env` 文件中存在 `DEEPSEEK_API_KEY`。

## 运行产品

在仓库根目录运行 Headless 任务：

```sh
pnpm --dir products/mythos-agent agent -- "inspect this repository and report the relevant test commands"
```

运行 Web 界面：

```sh
pnpm --dir products/mythos-agent web
```

两个运行面都将 `DSH_HOME` 设为本产品的 `home/` 目录，并使用同一模型身份、persona 和 agent preset。Web 界面禁止用户 Preset 以及会改变产品的模型或插件控件。

## 开发命令

| 命令 | 用途 |
|---|---|
| `pnpm --dir products/mythos-agent test` | 运行产品单元与约定测试。 |
| `pnpm --dir products/mythos-agent typecheck` | 检查评测、飞轮、产品和发布代码的类型。 |
| `pnpm --dir products/mythos-agent typecheck:control` | 单独检查战略总控的类型。 |
| `pnpm --dir products/mythos-agent smoke:web` | 验证已构建的 Web 产品面。 |
| `pnpm --dir products/mythos-agent eval` | 使用真实产品运行 release 评测套件。 |
| `pnpm --dir products/mythos-agent eval:comprehensive` | 运行所有单轮评测用例。 |
| `pnpm --dir products/mythos-agent eval:journey` | 运行冷恢复多轮旅程。 |
| `pnpm --dir products/mythos-agent eval:advanced-journey` | 运行压缩和并行 subagent 旅程。 |
| `pnpm --dir products/mythos-agent eval:real-repo` | 运行固定的真实仓库用例。 |
| `pnpm --dir products/mythos-agent release:verify` | 运行产品发布检查与门禁聚合。 |
| `pnpm --dir products/mythos-agent release:pack` | 从 `HEAD` 生成确定性归档和 SHA-256 文件。 |
| `npm --prefix apps/desktop test` | 运行 MYTHOS Desktop 展示、路由和签名配置测试。 |
| `MYTHOS_RUNTIME_ARCHIVE=<release.tar.gz> npm --prefix apps/desktop run pack:mac` | 使用确定性 Mythos Runtime 归档及其同名 `.sha256` 打包 Desktop Beta。 |

真实评测会消耗模型额度并创建本地运行数据。选择覆盖变更的最小套件；不因纯文档或无关修改重跑付费评测。

## 目录职责

| 目录 | 责任 |
|---|---|
| `control/` | 战略项目模型、决策策略、持久总控记忆、复审与 watchdog。 |
| `docs/` | 产品愿景、架构、模块地图、路线图、进度、开发规则与质量门禁。 |
| `eval/` | 评测用例、不可变执行快照、启动器与外部 verifier。 |
| `flywheel/` | 原始证据归档、cohort 分析、筛选、服务端数据导入与发布门禁。 |
| `home/` | 可发布的 Headless/Web Profile 和 Mythos agent preset。 |
| `product/` | 产品启动与配置身份验证。 |
| `release/` | 密钥检查、发布验证、确定性打包与归档校验。 |
| `../../apps/desktop/` | Electron 桌面壳、受控路由、签名热配置、更新与 macOS 打包。 |

## 运行数据与凭据

产品从环境读取凭据。绝不要将真实密钥放入已跟踪 YAML、测试、日志、评测 fixture 或发布归档。产品 `.gitignore` 排除本地凭据与状态，包括 `home/sessions/`、`home/storages/`、`runs/`、`flywheel/data/` 和 `dist/`。

飞轮源数据可以为受控分析特意保留原始身份和内容，但它不是源码，必须保持在 Git 和发布产物之外。发布密钥扫描只报告策略名，绝不回显可疑凭据值。

## 文档

从 [Mythos Agent 项目文档](docs/项目文档索引.md)开始。仓库级架构、子系统约定和贡献者工作流仍分别属于根[架构文档](../../docs/architecture.md)、[子系统索引](../../docs/subsystems/README.md) 和[开发指南](../../docs/development.md)。
