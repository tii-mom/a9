# A9 测试网运维快捷命令（默认全部 dry-run / 只读）
# 用法：make selftest / make preflight / make dryrun / make monitor / make reconcile

NODE ?= node
OPS  ?= ops/scripts

.PHONY: help selftest preflight dryrun deploy verify reconcile monitor announce clean

help:
	@echo "A9 ops targets:"
	@echo "  make selftest    离线自测（不联网/不用私钥）"
	@echo "  make preflight   参数/工具链/钱包检查"
	@echo "  make dryrun      全流程 dry-run 演练"
	@echo "  make deploy      真实部署（需 OPS_EXECUTE=1 + 环境变量；先读 runbooks/01）"
	@echo "  make verify      部署验收（--online --save）"
	@echo "  make reconcile   对账（--chain，可加 SNAPSHOT=...）"
	@echo "  make monitor     监控检查（可加 NOTIFY=1）"
	@echo "  make announce    公告渲染（TYPE=open ROUND=1 LANG=both）"
	@echo "  make clean       清理生成的记录文件"

selftest:
	$(NODE) $(OPS)/selftest.mjs

preflight:
	$(NODE) $(OPS)/00_preflight.mjs

dryrun:
	$(NODE) $(OPS)/deploy_all.mjs

deploy:
	@echo "真实部署：请先阅读 ops/runbooks/01_deploy_testnet.md 并逐步执行；不要直接 make deploy。"
	@echo "示例：OPS_EXECUTE=1 node ops/scripts/10_deploy_jetton.mjs --execute"

verify:
	$(NODE) $(OPS)/verify_deployment.mjs --online --save

reconcile:
	$(NODE) $(OPS)/reconcile.mjs --chain $(if $(SNAPSHOT),--snapshot $(SNAPSHOT),)

monitor:
	$(NODE) $(OPS)/monitor_check.mjs $(if $(NOTIFY),--notify,)

announce:
	$(NODE) $(OPS)/announcement.mjs --type $(or $(TYPE),open) --round $(or $(ROUND),1) --lang $(or $(LANG),both) $(if $(OUT),--out $(OUT),)

clean:
	rm -f ops/records/*.csv ops/records/*.json ops/records/*.md
	@echo "records/ 已清理（保留 README.md 与 .gitkeep）"
