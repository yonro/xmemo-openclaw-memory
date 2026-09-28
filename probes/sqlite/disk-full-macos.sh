#!/bin/sh
set -eu

if ! command -v hdiutil >/dev/null 2>&1; then
  echo 'UNAVAILABLE: hdiutil is required for the macOS disk-full probe' >&2
  exit 2
fi

probe_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/xmemo-sqlite-volume.XXXXXX")
image="$tmp_dir/probe.dmg"
mount="$tmp_dir/mount"
mkdir "$mount"
attached=0
cleanup() {
  if [ "$attached" -eq 1 ]; then hdiutil detach "$mount" -quiet || true; fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

hdiutil create -quiet -size 96m -fs HFS+ -volname XMemoSQLiteProbe "$image"
hdiutil attach -quiet -nobrowse -mountpoint "$mount" "$image"
attached=1
node "$probe_dir/probe.mjs" disk-full-setup "$mount/probe.db"

# Leave only 2 MiB free so SQLite's next WAL growth reaches the filesystem limit.
available_kib=$(df -k "$mount" | awk 'NR == 2 {print $4}')
fill_kib=$((available_kib - 2048))
if [ "$fill_kib" -le 0 ]; then
  echo "UNAVAILABLE: mounted probe volume has only ${available_kib} KiB free before fill" >&2
  exit 2
fi
dd if=/dev/zero of="$mount/filler.bin" bs=1024 count="$fill_kib" 2>/dev/null
node "$probe_dir/probe.mjs" disk-full-write "$mount/probe.db"
