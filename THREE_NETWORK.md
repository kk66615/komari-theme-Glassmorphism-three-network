# 三网延迟版说明

本仓库 = 上游 [sanrokamlan-prog/komari-theme-Glassmorphism](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism) + 中国联通 / 电信 / 移动三网延迟丢包面板，思路来自 [vlongx/komari-theme-Glassmorphism-three-network](https://github.com/vlongx/komari-theme-Glassmorphism-three-network)（基于上游 v2.3.1 的快照），本仓库将该功能重新移植到上游 v3 架构上并持续跟进上游更新。

## 功能

首页节点卡的「延迟 / 丢包」面板按运营商分三行显示，每行包含运营商名、平均值和分时柱状图。数据复用上游 `useNodePingStats` 的共享请求缓存（Metric Store 优先、旧接口 fallback），不产生额外请求。

## 运营商识别规则

按 **Ping 任务名称**正则匹配（在 Komari 后台创建 Ping 任务时命名需含关键词）：

| 运营商 | 匹配关键词                                                              |
| ------ | ----------------------------------------------------------------------- |
| 联通   | `联通`、`China Unicom`、`Unicom`、`CUCC`、`CUVIP`、`9929`、`10099`      |
| 电信   | `电信`、`China Telecom`、`Telecom`、`CTCC`、`Chinanet`、`CN2`、`CTGNet` |
| 移动   | `移动`、`China Mobile`、`Mobile`、`CMCC`、`CMI`、`CMIN2`                |

## 主题设置

后台「主题设置」新增开关 **节点卡三网延迟面板**（`carrierPingPanelsEnabled`，**默认关闭**，装好主题后在后台打开一次即可，设置持久化）。默认关闭是刻意的：上游的 Playwright 视觉回归基线按原版单行面板截图，默认不改变外观可让整个上游测试套件与基线在本仓库原样通过，upstream 同步永不因截图冲突。若某次同步后三网面板异常，关掉开关即回到原版面板。

## 改动面（相对上游）

| 文件                                           | 改动                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/composables/useNodeCarrierPingStats.ts`   | 新增：按运营商归类任务并计算延迟/丢包/波动                                     |
| `src/composables/useNodeCarrierPingDisplay.ts` | 新增：三网面板展示层（复用上游 signal 色阶与色觉辅助纹理）                     |
| `src/composables/useNodePingStats.ts`          | 最小改动：为若干内部函数/类型加 `export`；`MetricLossPoint` 增加可选 `task_id` |
| `src/components/NodeCard.vue`                  | 延迟/丢包面板按开关二选一渲染                                                  |
| `src/stores/app.ts`                            | 新增 `carrierPingPanelsEnabled` 设置                                           |
| `komari-theme.json`                            | 新增开关条目                                                                   |

## 与上游同步

`.github/workflows/sync-upstream.yml` 每日自动运行（也可在 Actions 页手动触发）：

1. 拉取并合并上游 `main`；
2. `bun install && bun run build` 验证；
3. 通过则推送；上游版本号变化时自动打 tag 并发布带构建产物的 Release；
4. **合并冲突或构建失败时自动开带 `sync-conflict` 标签的 issue**，需人工处理（通常是上游重构了三网面板 import 的接口，按 issue 里的步骤本地解决后推送即可）。
