# ops/records — 运行产物（git 忽略）

本目录存放脚本生成物，**不应提交到仓库**（见 ops/.gitignore）：

- reconciliation-<timestamp>.csv：对账表（每轮/每日）
- address-book.testnet.md / .json：地址登记簿（由 60 脚本生成；真实部署后归档）
- announcement-<type>-r<N>.md：公告渲染稿
- verify-deployment-YYYY-MM-DD.json：验收报告
- params-snapshot.json / round-controller.init.json：部署输入快照
- monitor.log / reconcile.log / daily-YYYY-MM-DD.json：监控与日报输出

保留策略：至少到主网后 90 天；P0/P1 事故证据永久归档（另存加密备份）。
