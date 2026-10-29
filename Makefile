PYTHON ?= python3
PORT ?= 8765
HOST ?=
.PHONY: help check format preview package deploy install deps hardware-check
help:
	@printf '%s\n' 'make check                 本地检查与离线测试' 'make preview               本地网页预览（离线、无硬件）' 'make package               生成可部署源码包' 'make deploy HOST=pi@<ip>   SSH 部署应用' 'sudo make deps             树莓派安装应用依赖' 'sudo make install          树莓派本地安装应用' 'make hardware-check        在树莓派检查控制页（需现有 Chromium）'
check:
	@PYTHON='$(PYTHON)' bash ops/scripts/check.sh
preview:
	@mkdir -p var
	@test -f var/config.json || cp app/config/pidesk.example.json var/config.json
	PYTHONPATH=app/src $(PYTHON) -m pidesk --web-only --offline --host 127.0.0.1 --port $(PORT) --config var/config.json --cache var/weather.json
package:
	$(PYTHON) ops/scripts/package.py
deploy:
	@bash ops/scripts/deploy.sh '$(HOST)'
install:
	@bash ops/scripts/install.sh
deps:
	@bash ops/scripts/install-deps.sh
hardware-check:
	PYTHONPATH=app/src $(PYTHON) ops/tools/check_controls.py

format:
	$(PYTHON) -m ruff format app/src tests ops/tools ops/scripts/package.py
	npm run format
