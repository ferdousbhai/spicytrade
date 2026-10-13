#!/usr/bin/env bash
# Installs the spicytrade command, then runs `spicytrade setup`:
#
#   curl -fsSL https://spicy.trade/install.sh | bash
#
# It downloads one file, https://spicy.trade/spicytrade.mjs, into ~/.local/share/spicytrade and
# links it as ~/.local/bin/spicytrade. Nothing runs as root and nothing outside those two paths
# is touched; setup then asks before it connects your brokerage. Run it again to update.
set -euo pipefail

origin=${SPICYTRADE_ORIGIN:-https://spicy.trade}
share=${XDG_DATA_HOME:-$HOME/.local/share}/spicytrade
bin=$HOME/.local/bin

fail() {
  printf 'spicytrade: %s\n' "$1" >&2
  exit 1
}

# Every check runs before anything is written, so a machine that cannot run spicytrade is left as
# it was -- and every missing piece is named at once, so one round of installing covers them all.
[[ $(uname -s) == Linux ]] || fail 'spicytrade'\''s install runs on Linux for now. Your agent can still use market data and research without installing: see "Without installing" at '"$origin"'/connect'
missing=()
if ! command -v node >/dev/null; then
  missing+=('Node.js 22 or newer (https://nodejs.org)')
elif (($(node -p 'process.versions.node.split(".")[0]') < 22)); then
  missing+=("Node.js 22 or newer (https://nodejs.org); this is $(node --version)")
fi
command -v secret-tool >/dev/null \
  || missing+=('secret-tool, which keeps your credentials in the system keyring (Debian/Ubuntu: sudo apt install libsecret-tools; Arch: sudo pacman -S libsecret; Fedora: sudo dnf install libsecret)')
if ((${#missing[@]})); then
  {
    echo 'spicytrade needs:'
    printf '  - %s\n' "${missing[@]}"
    echo 'Install them, then run the install command again.'
  } >&2
  exit 1
fi

mkdir -p "$share" "$bin"
# Downloaded beside its final name and moved into place, so a failed download never replaces a
# working install with half a file.
download=$(mktemp "$share/.spicytrade.XXXXXX")
trap 'rm -f "$download"' EXIT
curl -fsSL "$origin/spicytrade.mjs" -o "$download"
chmod 755 "$download"
mv -f "$download" "$share/spicytrade.mjs"
ln -sfn "$share/spicytrade.mjs" "$bin/spicytrade"
echo "Installed spicytrade at $bin/spicytrade"

# Said after setup, as the last thing on screen: setup's own output would otherwise push it away,
# and every later hint names plain `spicytrade`.
path_hint() {
  case ":$PATH:" in
    *":$bin:"*) ;;
    *)
      echo
      echo "To run 'spicytrade' by name, add it to your PATH:"
      case ${SHELL##*/} in
        zsh) echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
        fish) echo '  fish_add_path ~/.local/bin' ;;
        *) echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;;
      esac
      echo "Until then, use $bin/spicytrade."
      ;;
  esac
}

# Piped into bash, this script's stdin is the download, so setup's question is asked on the
# terminal instead. Without one -- an unattended run -- setup is left for the member.
if (: </dev/tty) 2>/dev/null; then
  status=0
  node "$share/spicytrade.mjs" setup </dev/tty || status=$?
  path_hint
  exit "$status"
fi
echo "Finish with: $bin/spicytrade setup"
path_hint
