#!/usr/bin/env bash
set -euo pipefail

family="${1:?usage: install-linux-dependencies.sh <debian|fedora|rhel|arch|suse> [sensor|desktop|x11]}"
profile="${2:-sensor}"

as_root() {
  if [[ "$(id -u)" == "0" ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

case "$family" in
  debian)
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential ca-certificates cmake curl git libdbus-1-dev libxcb-ewmh-dev \
      libxcb-randr0-dev pkg-config unzip
    if [[ "$profile" == "desktop" ]]; then
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        libayatana-appindicator3-dev libgtk-3-dev librsvg2-dev libwebkit2gtk-4.1-dev
    fi
    if [[ "$profile" == "x11" ]]; then
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        openbox wmctrl x11-utils xdotool xfonts-base xterm xvfb
    fi
    ;;
  fedora)
    as_root dnf install -y \
      ca-certificates cmake curl dbus-devel gcc gcc-c++ git libxcb-devel make \
      pkgconf-pkg-config unzip xcb-util-wm-devel
    ;;
  rhel)
    as_root dnf install -y dnf-plugins-core
    as_root dnf config-manager --set-enabled crb || true
    as_root dnf install -y \
      ca-certificates cmake dbus-devel gcc gcc-c++ git libxcb-devel make \
      pkgconf-pkg-config unzip xcb-util-wm-devel
    ;;
  arch)
    as_root pacman -Syu --noconfirm --needed \
      base-devel ca-certificates cmake curl dbus git libxcb pkgconf unzip xcb-util-wm
    ;;
  suse)
    as_root zypper --non-interactive refresh
    as_root zypper --non-interactive install --no-recommends \
      binutils ca-certificates cmake curl dbus-1-devel gcc gcc-c++ git libxcb-devel make \
      pkg-config unzip wget xcb-util-wm-devel
    /usr/bin/pkg-config --exists dbus-1 xcb
    ;;
  *)
    echo "unsupported Linux package family: $family" >&2
    exit 2
    ;;
esac
