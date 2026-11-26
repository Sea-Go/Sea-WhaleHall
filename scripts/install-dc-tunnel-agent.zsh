#!/bin/zsh
# 安装 WhaleHall dev 的 DC 隧道常驻服务:用户级 LaunchAgent com.seago.whalehall.dc-tunnel。
# 登录即启动,任一进程退出即拉起,客户端不再因隧道消失而显示"设备已离线"。
#
#   tlsfront  bun + 自签证书:https://127.0.0.1:18443 → http://127.0.0.1:18080
#   ssh       -N -L 18080:127.0.0.1:18081,经 FRP 网关 8.141.91.86:22022 → 家里云 DC
#
# 落盘位置(全部在本机,不进仓库):
#   ~/Library/Application Support/com.seago.whalehall/dev/tunnel/{bin,data,log}
#   ~/Library/LaunchAgents/com.seago.whalehall.dc-tunnel.plist
# scripts/dev-launch.zsh 启动前探测 https://127.0.0.1:18443/health,不健康时 kickstart 本服务。
#
# 用法:
#   zsh scripts/install-dc-tunnel-agent.zsh           完整打印将落盘的内容,确认后安装;可重复执行
#   zsh scripts/install-dc-tunnel-agent.zsh --yes     免确认(内容照样先打印)
#   zsh scripts/install-dc-tunnel-agent.zsh --print   只打印,不落盘
# 卸载:
#   launchctl bootout gui/$(id -u)/com.seago.whalehall.dc-tunnel
#   rm ~/Library/LaunchAgents/com.seago.whalehall.dc-tunnel.plist
#   rm -rf "$HOME/Library/Application Support/com.seago.whalehall/dev/tunnel"
set -euo pipefail

LABEL="com.seago.whalehall.dc-tunnel"
TUNNEL_DIR="$HOME/Library/Application Support/com.seago.whalehall/dev/tunnel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_FILE="$TUNNEL_DIR/log/dc-tunnel.log"
LEGACY_DIR="/private/tmp/sea-dc-tunnel"
CERT="$TUNNEL_DIR/data/server-cert.pem"
KEY="$TUNNEL_DIR/data/server-key.pem"
SSH_KEY="$HOME/.ssh/id_ed25519_home_cloud"
HEALTH_URL="https://127.0.0.1:18443/health"

MODE="install"
ASSUME_YES=0
case "${1:-}" in
	"") ;;
	--yes) ASSUME_YES=1 ;;
	--print) MODE="print" ;;
	*)
		print -u2 -r -- "[install-dc-tunnel] 未知参数 '$1'(可用:--yes 免确认 / --print 只展示不落盘)"
		exit 2
		;;
esac

die() { print -u2 -r -- "[install-dc-tunnel] 错误:$*"; exit 1; }

[[ "$(uname -s)" == Darwin ]] || die "只支持 macOS(LaunchAgent)"
(( EUID != 0 )) || die "请以普通用户执行(用户级 LaunchAgent),不要加 sudo"
BUN="$(command -v bun)" || die "找不到 bun"
SSH="$(command -v ssh)" || die "找不到 ssh"
for tool in lsof openssl curl launchctl; do
	command -v "$tool" >/dev/null 2>&1 || die "缺少 $tool"
done
[[ -f "$SSH_KEY" ]] || die "缺少 SSH 私钥 $SSH_KEY"

healthy() {
	[[ "$(curl --noproxy '*' --cacert "$CERT" -s -o /dev/null -w '%{http_code}' \
		--max-time 3 "$HEALTH_URL" 2>/dev/null)" == "200" ]]
}

# 占着 18443/18080 的现有隧道进程:不先停掉,新服务会因端口冲突反复重启。
# 只认手工栈(/private/tmp)和本服务的旧实例;别的进程占着端口就报错退出,不替用户杀。
list_tunnel_pids() {
	local pid ppid cmd
	for pid in $(lsof -nP -iTCP:18443 -iTCP:18080 -sTCP:LISTEN -t 2>/dev/null | sort -un); do
		cmd="$(ps -o command= -p "$pid")"
		[[ -n "$cmd" ]] || continue
		case "$cmd" in
			*tlsfront.ts*) ;;
			*"ssh "*"18080:127.0.0.1:18081"*)
				# 手工栈的 ssh 外面套着 `while true; do ssh …; sleep 5; done` 重连循环,循环不先停会把 ssh 抢回来
				ppid="$(ps -o ppid= -p "$pid" | tr -d ' ')"
				if ps -o command= -p "$ppid" 2>/dev/null | grep -q "while true; do ssh"; then
					print -r -- "$ppid	重连循环(zsh)"
				fi
				;;
			*) die "端口 18443/18080 被非隧道进程占用(pid $pid:$cmd),先处理后再安装" ;;
		esac
		print -r -- "$pid	${cmd[1,90]}"
	done
}

if [[ -s "$CERT" && -s "$KEY" ]]; then
	CERT_PLAN="沿用已落盘的证书"
elif [[ -s "$LEGACY_DIR/data/server-cert.pem" && -s "$LEGACY_DIR/data/server-key.pem" ]]; then
	CERT_SRC="$LEGACY_DIR/data"
	CERT_PLAN="从 $LEGACY_DIR/data 迁移现有证书(同一张,客户端信任不变)"
else
	CERT_PLAN="新生成自签证书(CN=127.0.0.1,SAN=IP:127.0.0.1,DNS:localhost,10 年)"
fi

TLSFRONT=$(cat <<'EOF'
// WhaleHall dev 的 DC 隧道前置:自签 TLS 终结 + 原样转发到 SSH 隧道本地口。
// 证书在同级 ../data/;本文件由 scripts/install-dc-tunnel-agent.zsh 生成。
const dataDir = `${import.meta.dir}/../data`;
const cert = await Bun.file(`${dataDir}/server-cert.pem`).text();
const key = await Bun.file(`${dataDir}/server-key.pem`).text();

Bun.serve({
	port: 18443,
	tls: { cert, key },
	idleTimeout: 0,
	fetch(req) {
		const url = new URL(req.url);
		const upstream = `http://127.0.0.1:18080${url.pathname}${url.search}`;
		const hasBody = !["GET", "HEAD"].includes(req.method);
		return fetch(upstream, {
			method: req.method,
			headers: req.headers,
			body: hasBody ? req.body : undefined,
			// @ts-expect-error bun-specific duplex flag
			duplex: hasBody ? "half" : undefined,
		});
	},
});

console.log("tlsfront listening on https://127.0.0.1:18443 -> http://127.0.0.1:18080");
EOF
)

SUPERVISE=$(cat <<'EOF'
#!/bin/zsh
# com.seago.whalehall.dc-tunnel 的主进程:launchd 保活本进程,本进程保活下面两条子进程,任一退出即拉起。
#   tlsfront  https://127.0.0.1:18443 → http://127.0.0.1:18080
#   ssh       本地 18080 → 家里云 DC 127.0.0.1:18081(经 FRP 网关 8.141.91.86:22022)
# 由 scripts/install-dc-tunnel-agent.zsh 生成,要改参数请改安装脚本后重装。
# 标准输出/错误都进 <tunnel>/log/dc-tunnel.log。
set -u
# zsh 默认给后台作业降 CPU 优先级(BG_NICE),两层后台会叠到 nice 10;隧道在客户端响应链路上,不能降。
setopt no_bg_nice

TUNNEL_DIR="${0:A:h:h}"
BACKOFF=5

note() { print -r -- "$(date '+%Y-%m-%dT%H:%M:%S%z') supervise: $*"; }

# 前台运行一条命令,退出即重启。正常退出或被 kill 都在 1s 内拉回;
# 连续起不来(断网、网关或 DC 不通、端口被占)时退避 BACKOFF 秒再试。
keepalive() {
	local name=$1; shift
	local child="" started rc delay quick=0
	trap '[[ -n "$child" ]] && kill "$child" 2>/dev/null; exit 0' TERM INT HUP
	while true; do
		started=$SECONDS
		"$@" &
		child=$!
		wait "$child"
		rc=$?
		child=""
		# 连续两次存活不足 30s 才退避:被 kill 或瞬断后 1s 拉回;真起不来(断网、端口被占)时降频,免得刷屏式重连
		if (( SECONDS - started < 30 )); then (( ++quick )); else quick=0; fi
		delay=1
		(( quick >= 2 )) && delay=$BACKOFF
		note "$name 退出(exit $rc),${delay}s 后重启"
		sleep "$delay"
	done
}

note "启动(pid $$)"
keepalive ssh "__SSH__" -i "__SSH_KEY__" \
	-o IdentitiesOnly=yes -o BatchMode=yes \
	-o ServerAliveInterval=30 -o ServerAliveCountMax=4 \
	-o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new \
	-N -L 18080:127.0.0.1:18081 -p 22022 root@8.141.91.86 &
SSH_WATCHER=$!
keepalive tlsfront "__BUN__" run "$TUNNEL_DIR/bin/tlsfront.ts" &
FRONT_WATCHER=$!
trap 'kill "$SSH_WATCHER" "$FRONT_WATCHER" 2>/dev/null; exit 0' TERM INT HUP
wait
note "保活子壳意外退出,整体退出交给 launchd 重拉"
exit 1
EOF
)
SUPERVISE=${SUPERVISE//__SSH__/$SSH}
SUPERVISE=${SUPERVISE//__SSH_KEY__/$SSH_KEY}
SUPERVISE=${SUPERVISE//__BUN__/$BUN}

PLIST_BODY=$(cat <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>__LABEL__</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/zsh</string>
		<string>__TUNNEL_DIR__/bin/supervise.zsh</string>
	</array>
	<key>WorkingDirectory</key>
	<string>__TUNNEL_DIR__</string>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>2</integer>
	<key>ExitTimeOut</key>
	<integer>5</integer>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>__TUNNEL_DIR__/log/dc-tunnel.log</string>
	<key>StandardErrorPath</key>
	<string>__TUNNEL_DIR__/log/dc-tunnel.log</string>
</dict>
</plist>
EOF
)
PLIST_BODY=${PLIST_BODY//__LABEL__/$LABEL}
PLIST_BODY=${PLIST_BODY//__TUNNEL_DIR__/$TUNNEL_DIR}

plutil -lint - <<< "$PLIST_BODY" >/dev/null || die "plist 模板不合法"
zsh -n <(print -r -- "$SUPERVISE") || die "supervise.zsh 模板有语法错误"

stop_list="$(list_tunnel_pids)"
typeset -a STOP_PIDS
STOP_PIDS=()
STOP_DESC=""
while IFS=$'\t' read -r pid desc; do
	[[ -n "$pid" ]] || continue
	STOP_PIDS+=("$pid")
	STOP_DESC+="  pid $pid  $desc"$'\n'
done <<< "$stop_list"

heading() { print; print -r -- "===== $1 ====="; }
heading "[1/3] LaunchAgent → $PLIST(权限 644)"
print -r -- "$PLIST_BODY"
heading "[2/3] 保活主进程 → $TUNNEL_DIR/bin/supervise.zsh(权限 700)"
print -r -- "$SUPERVISE"
heading "[3/3] TLS 前置 → $TUNNEL_DIR/bin/tlsfront.ts(权限 644)"
print -r -- "$TLSFRONT"
heading "证书 → $CERT(644) 与 $KEY(私钥 600)"
print -r -- "$CERT_PLAN"
heading "安装会先停掉的现有隧道进程(随后由本服务接管端口)"
if (( ${#STOP_PIDS} )); then print -rn -- "$STOP_DESC"; else print -r -- "(无)"; fi
heading "执行"
print -r -- "launchctl bootstrap gui/$UID $PLIST"
print -r -- "日志:$LOG_FILE"

if [[ "$MODE" == "print" ]]; then exit 0; fi
if (( ! ASSUME_YES )); then
	[[ -t 0 ]] || die "当前不是交互终端;确认过上面的内容后,加 --yes 重跑"
	read -r "reply?确认按以上内容安装常驻服务并开启登录自启? [y/N] "
	[[ "$reply" == [yY] ]] || { print -r -- "已取消,未落盘任何文件。"; exit 0; }
fi

umask 077
mkdir -p "$TUNNEL_DIR/bin" "$TUNNEL_DIR/data" "$TUNNEL_DIR/log"

case "$CERT_PLAN" in
	沿用*) ;;
	从*)
		cp -p "$CERT_SRC/server-cert.pem" "$CERT"
		cp -p "$CERT_SRC/server-key.pem" "$KEY"
		;;
	*)
		openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
			-subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
			-keyout "$KEY" -out "$CERT" 2>/dev/null
		;;
esac
chmod 644 "$CERT"
chmod 600 "$KEY"
print -r -- "$SUPERVISE" > "$TUNNEL_DIR/bin/supervise.zsh"
chmod 700 "$TUNNEL_DIR/bin/supervise.zsh"
print -r -- "$TLSFRONT" > "$TUNNEL_DIR/bin/tlsfront.ts"
chmod 644 "$TUNNEL_DIR/bin/tlsfront.ts"
print -r -- "[install-dc-tunnel] 已落盘:$CERT_PLAN;$TUNNEL_DIR/bin/{supervise.zsh,tlsfront.ts}"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
if (( ${#STOP_PIDS} )); then
	print -r -- "[install-dc-tunnel] 停止现有隧道进程:${STOP_PIDS[*]}"
	kill "${STOP_PIDS[@]}" 2>/dev/null || true
	for _ in {1..50}; do
		if ! lsof -nP -iTCP:18443 -iTCP:18080 -sTCP:LISTEN -t >/dev/null 2>&1; then break; fi
		sleep 0.1
	done
	if lsof -nP -iTCP:18443 -iTCP:18080 -sTCP:LISTEN -t >/dev/null 2>&1; then
		die "端口 18443/18080 5s 后仍被占用,未装载服务"
	fi
fi

print -r -- "$PLIST_BODY" > "$PLIST"
chmod 644 "$PLIST"
launchctl bootstrap "gui/$UID" "$PLIST" || die "launchctl bootstrap 失败(见上一行 launchctl 的报错)"
print -r -- "[install-dc-tunnel] 已装载 $LABEL,等待隧道就绪 ..."

deadline=$(( SECONDS + 30 ))
while (( SECONDS < deadline )); do
	if healthy; then
		print -r -- "[install-dc-tunnel] 就绪:$HEALTH_URL → 200"
		launchctl print "gui/$UID/$LABEL" | grep -E "^[[:space:]]*(state|pid) = " || true
		print -r -- "[install-dc-tunnel] 日志:$LOG_FILE"
		exit 0
	fi
	sleep 1
done

print -u2 -r -- "[install-dc-tunnel] 错误:30s 内 $HEALTH_URL 未返回 200。服务已装载并会继续重连,最近日志:"
tail -n 20 "$LOG_FILE" >&2 2>/dev/null || true
exit 1
