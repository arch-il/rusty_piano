.PHONY: help install engine demo setup api web dev dev-here test
.DEFAULT_GOAL := help

help: ## show this list
	@echo "Targets:"
	@echo "  install   install coach (uv) and web (npm) dependencies"
	@echo "  engine    run the engine live on ws port 8790"
	@echo "  demo      run the engine in demo mode"
	@echo "  setup     open the engine setup window (MIDI, audio, profile, recording, WebSocket), then play"
	@echo "  api       run the coach API (port 8765)"
	@echo "  web       run the web page (Vite, port 5173)"
	@echo "  dev       engine in this terminal, api and web in the background (logs in .dev-logs/); Ctrl+C stops all"
	@echo "  dev-here  engine, api and web in this terminal, output mixed; Ctrl+C stops all"
	@echo "  test      run engine, coach and web tests"

install:
	uv sync --project coach
	npm --prefix coach/web install

engine:
	cd engine && cargo run --release -- --ws-port 8790

demo:
	cd engine && cargo run --release -- --ws-port 8790 --demo

setup:
	cd engine && cargo run --release -- --setup

api:
	uv run --project coach coach serve

web:
	npm --prefix coach/web run dev

dev:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1

dev-here:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 -Mixed

test:
	cargo test --manifest-path engine/Cargo.toml
	uv run --project coach pytest
	cd coach/web && node --test tests/*.test.ts
