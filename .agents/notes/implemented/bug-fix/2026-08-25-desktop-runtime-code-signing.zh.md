# Agent Note: 为自包含 Desktop 运行时签名

Status: implemented

[English](2026-08-25-desktop-runtime-code-signing.md) | 中文

## 问题

MYTHOS Desktop 内嵌一份包含约 29,000 个文件和 pnpm 链接的 DSH 解压发布包。部分 Profile 链接仍指向解压目录的绝对路径。未签名 App 只有在该目录继续存在时才能工作，严格 Developer ID 校验则会因为这些链接越出 `MYTHOS.app` 而拒绝复制后的 Bundle。

Electron Builder 默认的 macOS 签名器还会通过无界递归 `Promise.all()` 遍历每个疑似二进制文件。内嵌运行时会让文件遍历以 `EBADF` 失败；即使排除运行时，签名器仍会跟随 Electron Framework 的别名，重复尝试签署本地化 `.pak` 文件。因此，即使已有有效 Developer ID 身份，默认路径也无法稳定地产生签名产物。

## 决策

`prepare-runtime.mjs` 将解压发布包定义为链接允许范围。Electron Builder 复制发布包之前，它会拒绝规范化目标越出该范围的所有链接，并把内部绝对链接改写为相对链接。安装后的 App 因此只在自身资源内解析依赖，不保留构建机路径。

签名构建使用 `sign-macos.mjs`。签名器跳过符号链接别名，只在可执行文件和原生库扩展名中识别 Mach-O magic，同时纳入嵌套的 `.app`、`.framework` 与 `.xpc` Bundle；它先签最深路径，最后封装顶层 App。所有签名都使用可信时间戳、Hardened Runtime 和 Electron Builder 的 entitlements。App 元数据中的 `ElectronTeamID` 固定为 Developer ID 所属团队。

Electron Builder 继续负责 App 装配、ZIP/DMG、更新元数据和 Notarization。凭据只通过它支持的 `APPLE_API_*` 环境变量进入，不写入仓库。

## 考虑过的替代方案

**保留默认 `@electron/osx-sign` 遍历。** 提高 shell 文件描述符上限无法修复无界文件打开或 Framework 别名重复遍历。忽略运行时的过滤发生在遍历之后，无法阻止失败。

**对完整 App 使用 `codesign --deep`。** 这会隐藏嵌套签名顺序，并把同一组选项施加给职责不同的代码 Bundle。显式的最深路径优先签名让签名对象和 entitlements 可以审查。

**把 DSH 运行时作为归档存入 App。** 首次启动时解压可以避开 Bundle 链接规则，却会增加可变安装状态、启动工作、清理和一次额外的完整性转换。Desktop 保持发布包可从 `Contents/Resources` 直接运行。

## 后果

Desktop 打包现在拥有一段小型 macOS 专用签名器；未来新增运行时二进制格式或嵌套 Bundle 类型时，必须同步其原生文件发现逻辑。依赖解压目录的链接会在准备阶段失败，不再生成只在本机可用、无法分发的 App。

单元测试固定链接规范化、越界拒绝和 Mach-O 发现。签名包还必须通过 `codesign --verify --deep --strict`、`stapler validate`、Gatekeeper、DMG/ZIP 完整性检查，以及从解压分发产物启动。远程渠道发布与升级验收仍是独立证据。
