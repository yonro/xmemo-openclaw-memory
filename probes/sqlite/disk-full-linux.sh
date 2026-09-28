#!/bin/sh
set -eu

if [ "$(uname -s)" != Linux ]; then
  echo 'UNAVAILABLE: this disposable-volume probe is Linux-only' >&2
  exit 2
fi

probe_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mount_dir=$(mktemp -d "${TMPDIR:-/tmp}/xmemo-sqlite-tmpfs.XXXXXX")
mounted=0
cleanup() {
  if [ "$mounted" -eq 1 ]; then sudo umount "$mount_dir"; fi
  rmdir "$mount_dir"
}
trap cleanup EXIT HUP INT TERM

uid=$(id -u)
gid=$(id -g)
if ! sudo mount -t tmpfs -o "size=128m,uid=$uid,gid=$gid,mode=700,nosuid,nodev,noexec" tmpfs "$mount_dir"; then
  message='UNAVAILABLE: runner did not allow mounting a disposable tmpfs volume; Linux disk-full probe was not run'
  echo "$message" >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$message" >> "$GITHUB_STEP_SUMMARY"; fi
  exit 0
fi
mounted=1

node "$probe_dir/probe.mjs" disk-full-setup "$mount_dir/probe.db"
available_kib=$(df -kP "$mount_dir" | awk 'NR == 2 {print $4}')
case "$available_kib" in
  ''|*[!0-9]*)
    message='UNAVAILABLE: could not determine disposable tmpfs free space; Linux disk-full probe was not run'
    echo "$message" >&2
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$message" >> "$GITHUB_STEP_SUMMARY"; fi
    exit 0
    ;;
esac

fill_kib=$((available_kib - 2048))
if [ "$fill_kib" -le 0 ]; then
  message="UNAVAILABLE: disposable tmpfs had only ${available_kib} KiB free before fill; Linux disk-full probe was not run"
  echo "$message" >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$message" >> "$GITHUB_STEP_SUMMARY"; fi
  exit 0
fi

dd if=/dev/zero of="$mount_dir/filler.bin" bs=1024 count="$fill_kib" status=none
node "$probe_dir/probe.mjs" disk-full-write "$mount_dir/probe.db"
