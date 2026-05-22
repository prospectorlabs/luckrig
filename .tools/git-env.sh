# luckrig: sandbox-friendly git env
# .git/ is masked by a read-only tmpfs in Codex sandbox.
# Real gitdir lives under ~/.codex/memories/luckrig-git (writable ext4).
#
# Usage:
#   source .tools/git-env.sh
#   git status         # works normally
export GIT_DIR="$HOME/.codex/memories/luckrig-git"
export GIT_WORK_TREE="/home/gen/Documents/luckrig"
