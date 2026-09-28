#!/bin/sh
set -eu

if ! command -v hdiutil >/dev/null 2>&1; then
  echo 'UNAVAILABLE: hdiutil is required for the LocalMemoryKernel disk-full proof' >&2
  exit 2
fi

probe_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/xmemo-kernel-volume.XXXXXX")
image="$tmp_dir/kernel-probe.dmg"
mount="$tmp_dir/mount"
mkdir "$mount"
attached=0
cleanup() {
  if [ "$attached" -eq 1 ]; then hdiutil detach "$mount" -quiet || true; fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

hdiutil create -quiet -size 96m -fs HFS+ -volname XMemoKernelProbe "$image"
hdiutil attach -quiet -nobrowse -mountpoint "$mount" "$image"
attached=1

: > "$mount/.xmemo-disposable-volume"
node "$probe_dir/kernel-disk-full.mjs" "$mount"
