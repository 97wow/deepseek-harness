# Agent Note: 保持 Desktop Beta 更新通道可发现

Status: implemented

[English](2026-08-25-desktop-beta-update-channel.md) | 中文

## 问题

已打包 Beta 客户端会根据自身版本推断允许预发布版本，但没有设置更新通道。通用 Provider 因此请求 `latest-mac.yml`，而不是已经发布的 `beta-mac.yml`。GitHub 后备源还会忽略带产品前缀、但不符合 SemVer 的 Release 标签。

## 决策

每个 Desktop Beta 更新器都显式允许预发布版本，并在禁止降级之前选择 `beta` 通道。供 Electron Updater 消费的 Release 标签采用兼容 SemVer 的 `v<version>` 形式；面向人的产品命名继续保留在 Release 标题和产物文件名中。

赋值顺序是有意的：Electron Updater 的 channel setter 会同时启用降级，所以 `allowDowngrade = false` 必须位于 `channel = 'beta'` 之后。

## 考虑过的替代方案

**把 Beta 产物发布为 `latest-mac.yml`。** 这可以让现有通用 Provider 的请求成功，却会混淆稳定版与 Beta 的策略，使后续稳定通道迁移变得不安全。

**保留带产品前缀的 Release 标签并自定义 GitHub 发现。** 这需要围绕 Electron Updater 长期维护 Provider 行为，标准发布工具仍无法直接比较版本。兼容 SemVer 的标签更简单，也更具可移植性。

## 后果

受管通用源与 GitHub 后备源都会请求 `beta-mac.yml`。发布自动化必须保持标签兼容 SemVer，测试则固定预发布、通道和禁止降级设置。只有旧版签名构建实际发现、下载并安装新版后，已发布产物才算验收完成。
