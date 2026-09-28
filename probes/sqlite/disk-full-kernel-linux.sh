#!/bin/sh
set -eu

if [ "$(uname -s)" != Linux ]; then
  echo 'UNAVAILABLE: this disposable-volume probe is Linux-only' >&2
  exit 2
fi

probe_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mount_dir=$(mktemp -d "${TMPDIR:-/tmp}/xmemo-kernel-tmpfs.XXXXXX")
mounted=0
cleanup() {
  if [ "$mounted" -eq 1 ]; then sudo umount "$mount_dir"; fi
  rmdir "$mount_dir"
}
trap cleanup EXIT HUP INT TERM

uid=$(id -u)
gid=$(id -g)
if ! sudo mount -t tmpfs -o "size=128m,uid=$uid,gid=$gid,mode=700,nosuid,nodev,noexec" tmpfs "$mount_dir"; then
  message='UNAVAILABLE: runner did not allow mounting a disposable tmpfs volume; LocalMemoryKernel disk-full proof was not run'
  echo "$message" >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$message" >> "$GITHUB_STEP_SUMMARY"; fi
  exit 0
fi
mounted=1

: > "$mount_dir/.xmemo-disposable-volume"
node "$probe_dir/kernel-disk-full.mjs" "$mount_dir"
