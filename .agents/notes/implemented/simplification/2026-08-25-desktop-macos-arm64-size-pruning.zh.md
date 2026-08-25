# Agent Note: 裁剪 macOS arm64 Desktop 中不可达的平台数据

Status: implemented

[English](2026-08-25-desktop-macos-arm64-size-pruning.md) | 中文

## 问题

Runtime 归档降低了 App Bundle 文件数量，但已公证 Beta 7 安装后仍约 326 MB，DMG 约 170.3 MB。即使产品只提供英文和中文，App 仍包含 Electron 的全部本地化目录；macOS arm64 Runtime 也携带了面向 macOS x64、Linux 和 Windows 的 `node-pty` 预构建文件。

## 决策

macOS arm64 构建通过 Electron Builder 正式支持的 `electronLanguages` 选项，只保留 Electron 的 `en`、`zh_CN` 和 `zh_TW` 本地化资源。产品文案仍由现有对称的中英文字典负责；这些 Electron 资源覆盖 Chromium 与原生框架字符串，不代表增加产品语言。

Desktop 专用 Runtime 归档在签名与重新封装前，定位包含 `darwin-arm64` 变体的实体 `node-pty/prebuilds` 树，并且只删除其中其他平台目录。它不会裁剪 JavaScript 包、模型提供方 SDK、动态插件或其他包的原生数据。保留的 arm64 二进制随后完成签名，发布完整性清单也会根据裁剪后的树重新生成。

## 考虑过的替代方案

**删除 Runtime 依赖闭包中的大型模型提供方 SDK。** Host 支持动态装配的提供方和插件，仅凭包体积无法证明依赖不可达。删除这些包需要单独证明产品 Profile 的可达性，并执行更广的行为测试。

**手动删除 Electron 框架中的 ICU、资源包或图形组件。** 这些文件是浏览器运行时的共享输入，不是按语言隔离的变体。Electron Builder 没有将它们声明为本产品可选内容，删除会形成不受支持的框架布局。

**用原生壳替换 Electron。** 这可能移除绝大部分 Electron 框架，但会改变渲染器、更新器、进程桥接、签名面和发布架构，属于产品重写，而不是分发裁剪。

## 后果

已公证 Beta 8 App 的 Electron 本地化目录从 220 个降至 3 个，Runtime Mach-O 签名对象从 9 个降至 7 个。全新解压的 Runtime 中，`node-pty` 只保留 `darwin-arm64` 预构建文件。

App 安装体积从约 326 MB 降至 276 MB。Runtime 归档从 51,284,783 字节降至 45,425,145 字节，DMG 从 170,257,780 字节降至 152,646,197 字节，ZIP 从 170,195,156 字节降至 152,379,719 字节。这是在低风险边界内减少约 50 MB 安装体积和 17.6 MB 下载体积；剩余 229 MB Frameworks 目录主要属于 Electron，若不进行更大规模的壳层改造就无法消除。

实际分发 ZIP 已通过严格代码签名校验、Stapler 验证、Notarized Developer ID Gatekeeper 验收、首次 Runtime 激活、Host 启动和 Web HTTP 200 检查。单元测试同时固定了不兼容预构建文件的删除行为，以及其他包的预构建树不得受影响的规则。
