#!/bin/zsh
# WhaleHall dev 应用一键启动(根治"设备离线"复发:隧道探活/TLS 信任/实例清理/签名全部收口于此)。
# 用法: bun run scripts/dev-launch.zsh   (或 zsh scripts/dev-launch.zsh)
set -euo pipefail

REPO_ROOT="${0:A:h:h}"
APP="$REPO_ROOT/build/dev-macos-arm64/WhaleHall-dev.app"
SIGN_ID="44B4ADA995AAD20E8D095D25887B079A0343FAF8"
TUNNEL_DIR="$HOME/Library/Application Support/com.seago.whalehall/dev/tunnel"
DC_TUNNEL_LABEL="com.seago.whalehall.dc-tunnel"
DC_HEALTH_URL="https://127.0.0.1:18443/health"

# 1. tlsfront CA 发现:常驻隧道栈(LaunchAgent,scripts/install-dc-tunnel-agent.zsh 安装)优先,
#    兼容旧的 /private/tmp 手工栈。
CERT=""
for candidate in \
	"$TUNNEL_DIR/data/server-cert.pem" \
	/private/tmp/sea-dc-tunnel/data/server-cert.pem \
	/private/tmp/sea-dc-tunnel/server-cert.pem; do
	if [[ -f "$candidate" ]]; then CERT="$candidate"; break; fi
done
if [[ -z "$CERT" ]]; then
	echo "[dev-launch] 错误:未找到 tlsfront CA,拒绝启动(否则应用会显示设备离线)。" >&2
	echo "[dev-launch] 先安装 DC 隧道常驻服务:zsh scripts/install-dc-tunnel-agent.zsh" >&2
	exit 1
fi

# 2. DC 隧道探活:CA 校验通过且取回 DC 响应才算健康。不健康就重启常驻服务并等它就绪,
#    等不到就拒启——绝不静默启动一个"设备已离线"的客户端。
dc_healthy() {
	[[ "$(curl --noproxy '*' --cacert "$CERT" -s -o /dev/null -w '%{http_code}' \
		--max-time 5 "$DC_HEALTH_URL" 2>/dev/null)" == "200" ]]
}
if ! dc_healthy; then
	echo "[dev-launch] DC 隧道未就绪,重启 $DC_TUNNEL_LABEL 并等待就绪 ..." >&2
	if ! launchctl kickstart -k "gui/$(id -u)/$DC_TUNNEL_LABEL" 2>/dev/null; then
		echo "[dev-launch] 错误:隧道不健康,且常驻服务 $DC_TUNNEL_LABEL 未安装,拒绝启动。" >&2
		echo "[dev-launch] 先安装:zsh scripts/install-dc-tunnel-agent.zsh" >&2
		exit 1
	fi
	deadline=$(( SECONDS + 30 ))
	until dc_healthy || (( SECONDS >= deadline )); do sleep 1; done
	if ! dc_healthy; then
		echo "[dev-launch] 错误:DC 隧道 30s 内未就绪,拒绝启动(否则应用会显示设备离线)。" >&2
		echo "[dev-launch] 隧道日志尾($TUNNEL_DIR/log/dc-tunnel.log):" >&2
		tail -n 15 "$TUNNEL_DIR/log/dc-tunnel.log" >&2 2>/dev/null || true
		exit 1
	fi
	echo "[dev-launch] DC 隧道已就绪。" >&2
fi

# 3. 清尽旧实例(双实例会互抢窗口/凭据)。
pkill -f "WhaleHall-dev" 2>/dev/null || true
pkill -f "whalehall-local" 2>/dev/null || true
sleep 1

# 4. 外层本地证书重签(Hutch 只做 ad-hoc 签名,vault 进程守卫要求开发者证书)。
codesign --force --sign "$SIGN_ID" --identifier com.seago.whalehall "$APP" >/dev/null

# 5. 直启(无 watch;代理变量剥除,避免本地回环被代理劫持)。
exec env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
	NODE_EXTRA_CA_CERTS="$CERT" \
	SEA_WHALEHALL_REPO_ROOT="$REPO_ROOT" \
	"$APP/Contents/MacOS/launcher"
