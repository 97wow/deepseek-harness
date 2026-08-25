# Agent Note: 在 App Bundle 外激活 Desktop Runtime

Status: implemented

[English](2026-08-25-desktop-runtime-archive-activation.md) | 中文

## 问题

已签名 Desktop Beta 会把完整 Mythos 发布树复制进 `MYTHOS.app`。28,823 个普通发布文件中有 28,808 个属于 Runtime，另有 3,292 个链接，安装数据约 297 MB。即使确定性产品归档只有约 49 MB，macOS 签名仍需遍历数千个对象，App 安装也要复制一棵大型小文件树。

## 决策

Desktop 把现有确定性 Mythos `.tar.gz` 发布包及其 SHA-256 文件作为已签名 App 资源内嵌。已打包 App 首次启动时先检查归档路径清单，以流式方式计算并比对归档摘要，再解压到 Application Support 下的唯一 staging 目录，并依据 `release-integrity.json` 校验解压树。只有全部通过后，才写入 `.ready` 标记，并以目录重命名原子切换到按摘要寻址的 Runtime 目录。

激活期间 BrowserWindow 加载界面保持可见。并发激活调用共享同一任务。后续启动不仅要求 `.ready` 与已签名归档摘要一致，还会重新校验可变的解压树；校验失败时删除并重建该摘要目录。应用版本通过内容摘要选择 Runtime，因此不需要可变的全局当前版本指针。

## 考虑过的替代方案

**继续把展开后的 Runtime 放在 `MYTHOS.app` 内。** 这种启动路径最简单，却会保留促成本次改动的签名、复制和 Bundle 链接成本。

**把 DSH 打成单一可执行文件。** DSH 会加载较大的生产依赖闭包、原生模块、Profile 和 Web 静态资源。把这些动态边界冻结进单一可执行文件会成为更大的兼容性工程，也无法直接复用已有的已验证发布格式。

**解压后不做完整发布校验。** App 签名和归档 SHA-256 已保护资源，但在激活前验证 `release-integrity.json`，可以让安装后的可变副本独立审计，并拒绝链接或解压异常。

## 后果

首次启动会执行一次解压和约 31,000 条完整性检查；当前开发机实测约 10.7 秒，重复启动的全量复验约 5.3 秒。Runtime 数据会在 App 内压缩归档之外占用 Application Support 空间；后续清理策略必须保留任一已安装版本仍在使用的 Runtime。

发布打包现在要求 `MYTHOS_RUNTIME_ARCHIVE` 及同名 `.sha256`，不再要求解压后的 `MYTHOS_RUNTIME_ROOT`。签名 Release 验收仍必须覆盖分发产物的首次启动、重复启动、损坏归档和应用升级。
