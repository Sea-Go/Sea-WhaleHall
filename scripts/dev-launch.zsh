#!/bin/zsh
# WhaleHall dev 应用一键启动(根治"设备离线"复发:TLS 信任/实例清理/签名全部收口于此)。
# 用法: bun run scripts/dev-launch.zsh   (或 zsh scripts/dev-launch.zsh)
set -euo pipefail

REPO_ROOT="${0:A:h:h}"
APP="$REPO_ROOT/build/dev-macos-arm64/WhaleHall-dev.app"
SIGN_ID="44B4ADA995AAD20E8D095D25887B079A0343FAF8"

# 1. tlsfront CA 发现:按优先级探测(隧道由 connect-home-cloud / tlsfront.ts 拉起)。
CERT=""
for candidate in \
	/private/tmp/sea-dc-tunnel/data/server-cert.pem \
	/private/tmp/sea-dc-tunnel/server-cert.pem \
	"$HOME/Library/Application Support/com.seago.whalehall/dev/tlsfront-ca.pem"; do
	if [[ -f "$candidate" ]]; then CERT="$candidate"; break; fi
done
if [[ -z "$CERT" ]]; then
	echo "[dev-launch] 警告:未找到 tlsfront CA,应用将显示设备离线。" >&2
	echo "[dev-launch] 先启动隧道(见 ~/.codex/skills/connect-home-cloud 与 tlsfront.ts),再重跑本脚本。" >&2
	exit 1
fi
# 留一份持久副本:tmp 清理后隧道重建前,可用旧 CA 兜底探测。
PERSIST_DIR="$HOME/Library/Application Support/com.seago.whalehall/dev"
mkdir -p "$PERSIST_DIR"
cp -f "$CERT" "$PERSIST_DIR/tlsfront-ca.pem"

# 2. 清尽旧实例(双实例会互抢窗口/凭据)。
pkill -f "WhaleHall-dev" 2>/dev/null || true
pkill -f "whalehall-local" 2>/dev/null || true
sleep 1

# 3. 外层本地证书重签(Hutch 只做 ad-hoc 签名,vault 进程守卫要求开发者证书)。
codesign --force --sign "$SIGN_ID" --identifier com.seago.whalehall "$APP" >/dev/null

# 4. 直启(无 watch;代理变量剥除,避免本地回环被代理劫持)。
exec env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
	NODE_EXTRA_CA_CERTS="$CERT" \
	SEA_WHALEHALL_REPO_ROOT="$REPO_ROOT" \
	"$APP/Contents/MacOS/launcher"
