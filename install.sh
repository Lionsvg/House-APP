#!/usr/bin/env bash
set -euo pipefail

REPO="Lionsvg/House-APP"
PREFIX="/opt/houseapp"
DATA_DIR="/var/lib/houseapp"
ENV_FILE="/etc/houseapp.env"
UNIT="/etc/systemd/system/houseapp.service"
SVC_USER="houseapp"

MODE=""
PORT=""
ASSUME_YES=0
SKIP_DOCKER=0
NO_SERVICE=0
ACTION="install"
PURGE=0

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; C=""; N=""; fi
info() { echo "  $*"; }
ok() { echo "  ${G}[OK]${N} $*"; }
warn() { echo "  ${Y}[!]${N}  $*"; }
die() { echo "  ${R}[X]${N}  $*" >&2; exit 1; }
step() { echo; echo "${C}${B}$*${N}"; }

usage() {
  cat <<EOF
${B}HouseApp — installation sous Linux${N}

Utilisation :
  sudo bash install.sh [options]
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sudo bash

Options :
  --mode tailscale|lan|local   Qui peut ouvrir HouseApp (défaut : demandé, sinon tailscale)
                               tailscale = ce serveur + vos appareils Tailscale
                               lan       = tout le réseau local + Tailscale
                               local     = ce serveur uniquement
  --port N                     Port de l'interface (défaut 8800)
  --yes                        Répondre oui à tout (installation sans questions)
  --no-docker                  Ne pas installer Docker
  --no-service                 Ne pas créer de service systemd
  --uninstall                  Désinstaller HouseApp (garde les données)
  --purge                      Avec --uninstall : supprimer aussi ${DATA_DIR}
  -h, --help                   Afficher cette aide

Ce que fait le script :
  1. Vérifie le système (root, architecture, systemd)
  2. Installe Docker si absent (script officiel get.docker.com, après accord)
  3. Copie HouseApp dans ${PREFIX} (Node.js inclus, rien d'autre à installer)
  4. Crée l'utilisateur système "${SVC_USER}" (membre du groupe docker)
  5. Écrit la configuration dans ${ENV_FILE}
  6. Ouvre le port dans ufw s'il est actif
  7. Crée et démarre le service systemd "houseapp"
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --no-docker) SKIP_DOCKER=1; shift ;;
    --no-service) NO_SERVICE=1; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Option inconnue : $1 (voir --help)" ;;
  esac
done

TTY_IN=/dev/stdin
if [ ! -t 0 ] && [ -r /dev/tty ] && (exec </dev/tty) 2>/dev/null; then TTY_IN=/dev/tty; fi
can_ask() { [ "$ASSUME_YES" -eq 0 ] && { [ -t 0 ] || [ "$TTY_IN" = /dev/tty ]; }; }

ask() {
  local q="$1" def="${2:-o}" r
  if ! can_ask; then [ "$def" = "o" ]; return; fi
  local hint="[O/n]"; [ "$def" = "n" ] && hint="[o/N]"
  read -r -p "  $q $hint " r <"$TTY_IN" || r=""
  [ -z "$r" ] && r="$def"
  [[ "$r" =~ ^[oOyY] ]]
}

has_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }

[ "$(id -u)" -eq 0 ] || die "Lancez ce script avec sudo : sudo bash install.sh"

if [ "$ACTION" = "uninstall" ]; then
  step "Désinstallation de HouseApp"
  if has_systemd && [ -f "$UNIT" ]; then
    systemctl disable --now houseapp >/dev/null 2>&1 || true
    rm -f "$UNIT"
    systemctl daemon-reload
    ok "Service supprimé"
  fi
  rm -rf "$PREFIX" "$ENV_FILE"
  ok "Fichiers supprimés ($PREFIX)"
  if [ "$PURGE" -eq 1 ]; then rm -rf "$DATA_DIR"; ok "Données supprimées ($DATA_DIR)"; else info "Données conservées dans $DATA_DIR (--purge pour les supprimer)"; fi
  info "Les applications Docker installées par HouseApp ne sont pas supprimées : docker ps -a --filter label=houseapp=1"
  exit 0
fi

echo
echo "${B}  HouseApp — installation${N}"
echo "  Guide complet : bash install.sh --help"

step "1/7  Système"
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "Architecture non prise en charge : $(uname -m) (x86_64 ou arm64 requis)" ;;
esac
. /etc/os-release 2>/dev/null || true
ok "${PRETTY_NAME:-Linux} ($ARCH)"
has_systemd || { warn "systemd absent : HouseApp sera installé sans service"; NO_SERVICE=1; }

step "2/7  Docker"
if command -v docker >/dev/null 2>&1; then
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '(démon arrêté ?)')"
elif [ "$SKIP_DOCKER" -eq 1 ]; then
  warn "Docker absent (--no-docker) : HouseApp démarrera sans pouvoir installer d'applications"
elif ask "Docker n'est pas installé. L'installer avec le script officiel (https://get.docker.com) ?"; then
  command -v curl >/dev/null 2>&1 || die "curl est requis pour installer Docker"
  curl -fsSL https://get.docker.com | sh
  has_systemd && systemctl enable --now docker >/dev/null 2>&1 || true
  ok "Docker installé"
else
  warn "Docker non installé : HouseApp démarrera sans pouvoir installer d'applications"
fi
command -v nvidia-smi >/dev/null 2>&1 && ok "GPU NVIDIA détecté (pensez au NVIDIA Container Toolkit pour les applis GPU)" || info "Pas de GPU NVIDIA (optionnel)"
TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
[ -n "$TS_IP" ] && ok "Tailscale connecté ($TS_IP)" || warn "Tailscale non connecté (https://tailscale.com/download/linux)"

step "3/7  Fichiers"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
TMP=""
if [ -z "$SRC" ] || [ ! -f "$SRC/server.js" ] || [ ! -f "$SRC/node/bin/node" ]; then
  command -v curl >/dev/null 2>&1 || die "curl est requis pour télécharger HouseApp"
  TMP="$(mktemp -d)"
  URL="https://github.com/${REPO}/releases/latest/download/HouseApp-linux-${ARCH}.tar.gz"
  info "Téléchargement de $URL"
  curl -fL --progress-bar "$URL" -o "$TMP/houseapp.tar.gz" || die "Téléchargement impossible (le dépôt GitHub doit être public et avoir une release)"
  tar -xzf "$TMP/houseapp.tar.gz" -C "$TMP"
  SRC="$TMP/houseapp"
fi
[ -f "$SRC/server.js" ] || die "Paquet HouseApp introuvable dans $SRC"
if [ -f "$PREFIX/server.js" ]; then
  info "Mise à jour d'une installation existante (les données sont conservées)"
  has_systemd && systemctl stop houseapp >/dev/null 2>&1 || true
fi
rm -rf "$PREFIX.new"
mkdir -p "$PREFIX.new"
cp -a "$SRC/." "$PREFIX.new/"
rm -rf "$PREFIX.new/data"
chmod 755 "$PREFIX.new/node/bin/node" "$PREFIX.new/install.sh" 2>/dev/null || true
rm -rf "$PREFIX"
mv "$PREFIX.new" "$PREFIX"
[ -n "$TMP" ] && rm -rf "$TMP"
"$PREFIX/node/bin/node" -e "process.exit(0)" || die "Le Node.js intégré ne démarre pas sur cette machine"
ok "HouseApp installé dans $PREFIX (Node.js $("$PREFIX/node/bin/node" -v))"

step "4/7  Utilisateur système"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER" 2>/dev/null || useradd -r -d "$DATA_DIR" -s /sbin/nologin "$SVC_USER"
fi
DOCKER_GROUP=""
if getent group docker >/dev/null 2>&1; then usermod -aG docker "$SVC_USER"; DOCKER_GROUP=" (groupe docker)"; fi
mkdir -p "$DATA_DIR"
chown -R "$SVC_USER":"$SVC_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"
ok "Utilisateur $SVC_USER$DOCKER_GROUP, données dans $DATA_DIR"

step "5/7  Accès"
if [ -z "$MODE" ]; then
  MODE="tailscale"
  if can_ask; then
    info "Qui peut ouvrir HouseApp ?"
    info "  1. Ce serveur + vos appareils Tailscale   (recommandé)"
    info "  2. Tout le réseau local + Tailscale"
    info "  3. Ce serveur uniquement"
    read -r -p "  Votre choix [1] " r <"$TTY_IN" || r=""
    case "$r" in 2) MODE="lan" ;; 3) MODE="local" ;; esac
  fi
fi
case "$MODE" in
  tailscale) HOST="127.0.0.1,tailscale" ;;
  lan) HOST="0.0.0.0" ;;
  local) HOST="127.0.0.1" ;;
  *) die "Mode inconnu : $MODE (tailscale, lan ou local)" ;;
esac
if [ -z "$PORT" ]; then
  PORT=8800
  if can_ask; then read -r -p "  Port [8800] " r <"$TTY_IN" || r=""; [[ "$r" =~ ^[0-9]+$ ]] && PORT="$r"; fi
fi
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "Port invalide : $PORT"
cat >"$ENV_FILE" <<EOF
HOST=$HOST
PORT=$PORT
HOUSEAPP_DATA=$DATA_DIR
EOF
chmod 644 "$ENV_FILE"
ok "$ENV_FILE : HOST=$HOST PORT=$PORT"

step "6/7  Pare-feu"
if [ "$MODE" = "local" ]; then
  info "Accès local uniquement : rien à ouvrir"
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if [ "$MODE" = "tailscale" ]; then ufw allow from 100.64.0.0/10 to any port "$PORT" proto tcp comment HouseApp >/dev/null
  else ufw allow "$PORT"/tcp comment HouseApp >/dev/null; fi
  ok "ufw : port $PORT ouvert ($MODE)"
else
  info "ufw inactif : rien à faire"
fi

step "7/7  Service"
if [ "$NO_SERVICE" -eq 1 ]; then
  info "Sans service. Pour lancer HouseApp à la main :"
  info "  sudo -u $SVC_USER env \$(cat $ENV_FILE | xargs) $PREFIX/node/bin/node $PREFIX/server.js"
else
  cat >"$UNIT" <<EOF
[Unit]
Description=HouseApp
After=network-online.target docker.service tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
$( [ -n "$DOCKER_GROUP" ] && echo "SupplementaryGroups=docker" )
EnvironmentFile=$ENV_FILE
WorkingDirectory=$PREFIX
ExecStart=$PREFIX/node/bin/node $PREFIX/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now houseapp >/dev/null
  sleep 2
  systemctl is-active --quiet houseapp && ok "Service houseapp démarré" || warn "Le service ne démarre pas : journalctl -u houseapp -n 50"
fi

echo
echo "  ${G}${B}Installation terminée.${N}"
info "Sur ce serveur : http://localhost:$PORT"
[ "$MODE" != "local" ] && [ -n "$TS_IP" ] && info "Depuis Tailscale : http://$TS_IP:$PORT"
if [ "$MODE" = "lan" ]; then for ip in $(hostname -I 2>/dev/null); do [[ "$ip" == *.* ]] && info "Réseau local : http://$ip:$PORT"; done; fi
info "Au premier accès, choisissez le mot de passe administrateur."
info "Commandes utiles : systemctl status houseapp | journalctl -u houseapp -f | sudo bash $PREFIX/install.sh --uninstall"
