# ops/tests — 离线测试夹具

| 文件 | 用途 | 预期 |
| --- | --- | --- |
| fixtures/worker-snapshot.json | 健康数据（R1 成功、R2 失败、R3 观察中） | reconcile 通过；monitor 全绿（exit 0） |
| fixtures/worker-snapshot-bad.json | 故障数据（API 不可用、K 线缺失、结算退回、不明退回、RC 钱包漂移、供应量漂移、keeper TON 不足） | monitor 退出码 2，含 P0 与 P1 告警 |

使用：

~~~bash
node ops/scripts/reconcile.mjs --snapshot ops/tests/fixtures/worker-snapshot.json
node ops/scripts/monitor_check.mjs --snapshot ops/tests/fixtures/worker-snapshot.json
node ops/scripts/monitor_check.mjs --snapshot ops/tests/fixtures/worker-snapshot-bad.json   # 期望 exit 2
~~~

- 夹具与 worker、shared 的 API 契约同构（ApiResponse 解包后的 data）；字段改动需同步更新夹具与 selftest。
- 夹具不含真实地址与私钥；用于验证对账公式、监控阈值与告警分级。
- **待办**：夹具文件（tests/fixtures/*.json）尚未按 v10 字段改写。在改写前，`worker-snapshot-bad.json` 中的 v8.9 字段不再对应告警，不能作为 v10 的验收依据。
