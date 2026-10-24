#!/usr/bin/env bash
# HouseApp — mise a jour sous Linux.
# Telecharge le paquet de la nouvelle version, verifie son empreinte SHA-256, puis ne remplace
# QUE les fichiers qui ont change. Les donnees (/var/lib/houseapp) et la config (/etc/houseapp.env)
# ne sont jamais touchees.
set -euo pipefail

REPO="Lionsvg/House-APP"
PREFIX="/opt/houseapp"
MANIFEST=".houseapp-files"
VERSION=""
FORCE=0
FROM=""   # tests : dossier/URL local contenant les paquets, a la place de GitHub
CHECK=0

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; C=""; N=""; fi
info() { echo "  $*"; }
ok() { echo "  ${G}[OK]${N} $*"; }
warn() { echo "  ${Y}[!]${N}  $*"; }
die() { echo "  ${R}[X]${N}  $*" >&2; exit 1; }

usage() {
  cat <<EOF
${B}HouseApp — mise a jour${N}

  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/update.sh | sudo bash
  sudo bash ${PREFIX}/update.sh [options]

Options :
  --version X.Y.Z   Installer cette version (defaut : la derniere release)
  --check           Dire seulement si une mise a jour existe
  --force           Reinstaller meme si la version est deja la bonne
  --dir DOSSIER     Dossier d'installation (defaut : ${PREFIX})
EOF
}

# Tout le travail est dans main() : bash la lit en entier AVANT de l'executer, donc remplacer
# ce fichier pendant la mise a jour (update.sh fait partie du paquet) ne pose pas de probleme.
main() {
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2#v}"; shift 2 ;;
    --check) CHECK=1; shift ;;
    --force) FORCE=1; shift ;;
    --dir) PREFIX="$2"; shift 2 ;;
    --from) FROM="${2%/}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Option inconnue : $1 (--help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Lancez avec sudo : curl -fsSL https://raw.githubusercontent.com/${REPO}/main/update.sh | sudo bash"
[ -f "$PREFIX/server.js" ] || die "HouseApp n'est pas installe dans $PREFIX (installation : install.sh)"
command -v curl >/dev/null 2>&1 || die "curl est requis"
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "Architecture non prise en charge : $(uname -m)" ;;
esac
has_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }

CURRENT="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$PREFIX/package.json" | head -n1)"
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name":[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)"
  [ -n "$VERSION" ] || die "Impossible de lire la derniere version sur GitHub"
fi
echo
echo "${C}${B}HouseApp : version installee ${CURRENT:-?}, version disponible ${VERSION}${N}"
if [ "$CURRENT" = "$VERSION" ] && [ "$FORCE" -eq 0 ]; then ok "Deja a jour"; exit 0; fi
[ "$CHECK" -eq 1 ] && { info "Une mise a jour est disponible : sudo bash $PREFIX/update.sh"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BASE="${FROM:-https://github.com/${REPO}/releases/download/v${VERSION}}"
ASSET="HouseApp-linux-${ARCH}.tar.gz"
info "Telechargement de $ASSET"
curl -fL --progress-bar "$BASE/$ASSET" -o "$TMP/$ASSET" || die "Telechargement impossible : $BASE/$ASSET"
curl -fsSL "$BASE/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt" || die "Empreintes introuvables : $BASE/SHA256SUMS.txt"
EXPECTED="$(grep " $ASSET\$" "$TMP/SHA256SUMS.txt" | cut -d' ' -f1)"
GOT="$(sha256sum "$TMP/$ASSET" | cut -d' ' -f1)"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$GOT" ] || die "Empreinte SHA-256 incorrecte : fichier corrompu ou modifie, rien n'a ete change"
ok "Empreinte SHA-256 verifiee"
tar -xzf "$TMP/$ASSET" -C "$TMP"
NEW="$TMP/houseapp"
[ -f "$NEW/server.js" ] || die "Paquet invalide"

# Liste des fichiers du nouveau paquet (jamais data/)
(cd "$NEW" && find . -type f ! -path './data/*' | sed 's#^\./##' | sort) > "$TMP/new.list"

CHANGED=(); ADDED=(); REMOVED=()
while IFS= read -r f; do
  if [ ! -f "$PREFIX/$f" ]; then ADDED+=("$f")
  elif ! cmp -s "$NEW/$f" "$PREFIX/$f"; then CHANGED+=("$f"); fi
done < "$TMP/new.list"
# Fichiers de l'ancienne version qui n'existent plus (seulement si on connait la liste precedente)
if [ -f "$PREFIX/$MANIFEST" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && [ -f "$PREFIX/$f" ] && ! grep -qxF "$f" "$TMP/new.list" && REMOVED+=("$f")
  done < <(grep -v '^#' "$PREFIX/$MANIFEST")
fi

TOTAL=$(( ${#CHANGED[@]} + ${#ADDED[@]} + ${#REMOVED[@]} ))
info "$(wc -l < "$TMP/new.list") fichiers dans la version $VERSION : ${#CHANGED[@]} modifies, ${#ADDED[@]} nouveaux, ${#REMOVED[@]} supprimes"

WAS_ACTIVE=0
if [ "$TOTAL" -gt 0 ]; then
  if has_systemd && systemctl is-active --quiet houseapp; then WAS_ACTIVE=1; systemctl stop houseapp; info "Service houseapp arrete"; fi
  for f in ${CHANGED[@]+"${CHANGED[@]}"} ${ADDED[@]+"${ADDED[@]}"}; do
    install -D -m "$(stat -c %a "$NEW/$f")" "$NEW/$f" "$PREFIX/$f"
  done
  for f in ${REMOVED[@]+"${REMOVED[@]}"}; do rm -f "$PREFIX/$f"; done
  chmod 755 "$PREFIX/node/bin/node" "$PREFIX/install.sh" "$PREFIX/update.sh" 2>/dev/null || true
fi
{ echo "# HouseApp $VERSION : fichiers installes (utilise par update.sh)"; cat "$TMP/new.list"; } > "$PREFIX/$MANIFEST"

show() { local label="$1"; shift; local n=0; for f in "$@"; do n=$((n + 1)); [ "$n" -le 15 ] && info "  $label $f"; done; [ "$n" -gt 15 ] && info "  ... et $((n - 15)) autres"; return 0; }
show "~" ${CHANGED[@]+"${CHANGED[@]}"}; show "+" ${ADDED[@]+"${ADDED[@]}"}; show "-" ${REMOVED[@]+"${REMOVED[@]}"}

if has_systemd && { [ "$WAS_ACTIVE" -eq 1 ] || systemctl is-enabled --quiet houseapp 2>/dev/null; }; then
  systemctl start houseapp
  sleep 2
  systemctl is-active --quiet houseapp && ok "Service houseapp redemarre" || warn "Le service ne redemarre pas : journalctl -u houseapp -n 50"
fi
echo
ok "${B}HouseApp ${CURRENT:-?} -> ${VERSION}${N} (donnees et configuration conservees)"
}

main "$@"
