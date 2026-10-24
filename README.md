# HouseApp

Serveur domestique pilotable depuis un navigateur, inspiré de CasaOS : vue d'ensemble CPU / RAM / GPU / disques /
réseau, catalogue de **107 applications** Docker, onglet **Téléchargements** (suivi et journaux des installations), **import de vos propres applications** (C# ou Dockerfile),
**panel Minecraft** complet et page **Maison** reliée à Home Assistant.

Fonctionne sous **Windows 10/11** et **Linux** (x64 et arm64, ex : Raspberry Pi 4/5). Seul **Docker** est requis :
Node.js est inclus dans les paquets.

> Vous vous demandez ce que HouseApp fait exactement sur votre machine ? Lisez **[SECURITE.md](SECURITE.md)**.

## Téléchargements

Dans l'onglet **Releases** du dépôt :

| Fichier | Pour |
|---|---|
| `HouseApp-windows-x64.zip` | Windows 10/11 |
| `HouseApp-linux-x64.tar.gz` | Linux PC / serveur (Debian, Ubuntu, Fedora…) |
| `HouseApp-linux-arm64.tar.gz` | Linux ARM 64 bits (Raspberry Pi 4/5…) |
| `HouseApp-source.zip` | Code source |
| `SHA256SUMS.txt` | Empreintes pour vérifier les fichiers |

## Installation sous Windows

1. Installez [Docker Desktop](https://www.docker.com/products/docker-desktop/) et lancez-le.
2. Extrayez `HouseApp-windows-x64.zip`, puis double-cliquez sur **`HouseApp\Setup.bat`**. Le guide :
   - vérifie Docker, le GPU NVIDIA et Tailscale ;
   - demande qui peut accéder à HouseApp et sur quel port ;
   - crée la règle de pare-feu (demande les droits administrateur) ;
   - propose le démarrage automatique avec Windows.
3. Ouvrez `http://localhost:8800` et choisissez le mot de passe administrateur.

Sans questions : `Setup.bat -Mode 1 -Port 8800 -Yes`. Lancement manuel : `start.bat` (`start.bat /silent` sans navigateur).

## Installation sous Linux

En une commande (le dépôt doit être public, avec une release) :

```bash
curl -fsSL https://raw.githubusercontent.com/Lionsvg/House-APP/main/install.sh | sudo bash
```

Ou depuis le paquet téléchargé :

```bash
tar -xzf HouseApp-linux-x64.tar.gz
sudo bash houseapp/install.sh
```

Le script est guidé (`bash install.sh --help` affiche le guide complet). Il :

1. vérifie le système (architecture, systemd) ;
2. propose d'installer Docker avec le script officiel `get.docker.com` ;
3. copie HouseApp dans `/opt/houseapp` (Node.js inclus) ;
4. crée l'utilisateur système `houseapp` (sans shell, membre du groupe `docker`) ;
5. écrit la configuration dans `/etc/houseapp.env` ;
6. ouvre le port dans `ufw` s'il est actif ;
7. crée et démarre le service systemd `houseapp`.

Options : `--mode tailscale|lan|local`, `--port 8800`, `--yes`, `--no-docker`, `--no-service`, `--uninstall`, `--purge`.

```bash
systemctl status houseapp          # état
journalctl -u houseapp -f          # journaux en direct
sudo bash /opt/houseapp/install.sh --uninstall
```

Les données sont dans `/var/lib/houseapp` ; relancer `install.sh` met HouseApp à jour sans les toucher.

## Mettre à jour

Le plus simple : **Paramètres → Mise à jour → Mettre à jour**. HouseApp redémarre tout seul (environ une minute).
Sous Linux, ce bouton est activé par `install.sh` ou par la première mise à jour en ligne de commande ci-dessous.

La commande de mise à jour télécharge le paquet de la dernière version, vérifie son empreinte SHA-256, puis
**ne remplace que les fichiers qui ont changé** (et supprime ceux qui n'existent plus). Vos données, votre
configuration et vos applications ne sont jamais touchées. HouseApp est arrêté le temps de la copie puis redémarré.

**Linux** (installation dans `/opt/houseapp`) :

```bash
curl -fsSL https://raw.githubusercontent.com/Lionsvg/House-APP/main/update.sh | sudo bash
```

Ou, à partir de la 1.0.1 : `sudo bash /opt/houseapp/update.sh` (`--check` pour seulement vérifier,
`--version 1.0.1` pour une version précise, `--force` pour tout revérifier).

**Windows** : double-cliquez sur **`Update.bat`** dans le dossier HouseApp (à partir de la 1.0.1).
Depuis une 1.0.0, ou en ligne de commande, ouvrez PowerShell **dans le dossier HouseApp** :

```powershell
irm https://raw.githubusercontent.com/Lionsvg/House-APP/main/scripts/update.ps1 | iex
```

Le dossier `data\` et `config.bat` sont conservés.

## Modes d'accès

Le mode, le port et un **nom de domaine** optionnel se règlent dans **Paramètres → Accès et exposition**, sans
redémarrer. Le mode **Internet** ouvre aussi le port sur la box (UPnP) : HouseApp parle en HTTP, donc pour un accès
depuis Internet préférez Tailscale, ou un nom de domaine derrière Nginx Proxy Manager (catalogue) avec HTTPS.
Le pare-feu n'est pas modifié par l'interface : sous Linux `sudo ufw allow <port>/tcp`, sous Windows relancez `Setup.bat`.

| Mode | Écoute sur | Usage |
|---|---|---|
| `tailscale` (défaut) | ce serveur + l'IP Tailscale | Accès depuis vos appareils Tailscale, invisible sur le Wi-Fi et Internet |
| `lan` | toutes les interfaces | Accès depuis tout le réseau local |
| `local` | `127.0.0.1` | Ce serveur uniquement |

Si Tailscale se connecte après HouseApp au démarrage, son adresse est ajoutée automatiquement.
Les adresses s'affichent dans **Paramètres → Accès à distance**.

## Panel Minecraft

Le panel est une application à installer : **Applications → Panel Minecraft**. Un onglet « Minecraft » apparaît alors.

- **Création** : Paper, Purpur, Spigot, Vanilla, Fabric, Forge, NeoForge ; version, RAM, port, mode de jeu, difficulté,
  hardcore, PvP, type de monde, seed, distance de vue, whitelist, opérateurs, plugins et mods Modrinth.
- **CLUF (EULA)** : jamais accepté d'office. Le serveur démarre seulement après votre clic sur « J'accepte ».
- **Console** en direct et commandes (RCON).
- **Joueurs** : en ligne, whitelist (activer, ajouter, retirer), opérateurs, expulser, bannir, débannir.
- **Plugins / Mods** : recherche Modrinth (installation automatique avec les dépendances), envoi de vos `.jar`.
- **Fichiers** : explorateur du dossier du serveur, éditeur de texte (server.properties, configs…), envoi,
  téléchargement, renommage, suppression.
- **Sauvegarde** du monde en `.tar.gz`.
- **Accès Internet** :
  - **playit.gg** (recommandé) : adresse publique gratuite qui marche derrière n'importe quelle box, double NAT ou CGNAT ;
  - **UPnP** : ouverture du port sur la box en un clic, avec détection du double NAT et du CGNAT ;
  - **test** depuis Internet.

## Importer vos propres applications

**Applications → Importer** : un dossier ou un `.zip` (ou glissez-le sur le cadre).

```
MonApp/
├── import.json      nom, port, icône, volumes, variables…
├── icon.png         optionnel
└── Projet/          projet C# (.csproj) — ou un Dockerfile pour un autre langage
```

```json
{ "name": "Mon App", "port": 8080, "icon": "icon.png", "volumes": ["/app/data"] }
```

HouseApp compile le projet C# dans Docker (le SDK .NET est choisi d'après `<TargetFramework>`), puis lance l'appli.
Réimporter la même appli la met à jour en gardant ses données. Exemple : [exemples/HelloHouse](exemples/HelloHouse).

**Skill Claude Code** : copiez [skills/houseapp-app](skills/houseapp-app) dans `~/.claude/skills/` puis demandez
à Claude Code « fais-moi une app HouseApp qui… ».

## Fabriquer les paquets

```bash
npm install
node scripts/build.js            # tout
node scripts/build.js windows    # ou : linux, source
```

Sous Windows : `Package.bat`. Les fichiers arrivent dans `dist/` avec `SHA256SUMS.txt`. Node.js est téléchargé
depuis nodejs.org et son empreinte SHA-256 est vérifiée avant d'être intégré.

## Fonctionnement

| Élément | Détail |
|---|---|
| Applications du catalogue | Conteneurs `houseapp-<id>`, redémarrage automatique |
| Applications importées | Image `houseapp-local/<id>`, conteneur `houseapp-local-<id>` |
| Minecraft | Image `itzg/minecraft-server`, conteneur `houseapp-mc-<nom>`, monde dans un volume Docker |
| Ports | Si le port voulu est pris, le suivant libre est choisi |
| Sécurité | HouseApp ne gère **que** ses conteneurs (étiquette `houseapp=1`) |
| Données | `data/` (Windows) ou `/var/lib/houseapp` (Linux) : `config.json`, `minecraft.json`, `local-apps/` |

Mot de passe oublié : arrêtez HouseApp, supprimez `config.json` dans le dossier de données, relancez.

## Licence

[MIT](LICENSE) : libre d'utiliser, modifier et redistribuer HouseApp, même commercialement, en conservant la
mention de copyright. Le logiciel est fourni « tel quel », sans garantie.

## Structure du code

```
server.js              API Express, authentification, démarrage
lib/docker.js          appels à la CLI docker (execFile, sans shell)
lib/catalog.js         catalogue
lib/localapps.js       import et compilation des applications perso
lib/minecraft.js       panel Minecraft
lib/upnp.js            ouverture de ports sur le routeur (UPnP IGD)
lib/system.js          statistiques système
lib/network.js         adresses locales et Tailscale
lib/homeassistant.js   pont vers Home Assistant
lib/config.js          configuration
public/                interface (HTML/CSS/JS sans build)
scripts/build.js       fabrication des paquets Windows / Linux / source
scripts/setup.ps1      installation Windows (lancée par Setup.bat)
scripts/update.ps1     mise à jour Windows (lancée par Update.bat ou par l'interface)
lib/updater.js         bouton « Mettre à jour » de l'interface
lib/apps.js            installation des applications, historique des tâches (Téléchargements)
install.sh             installation Linux
update.sh              mise à jour Linux (seuls les fichiers modifiés sont remplacés)
```
