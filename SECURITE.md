# Sécurité : comment HouseApp installe les applications

Ce document explique exactement ce que fait HouseApp sur votre machine, pour que vous puissiez vérifier
qu'il ne s'agit pas d'un logiciel malveillant. Tout le code est lisible dans ce dépôt : pas de code obfusqué,
pas de binaire caché.

## Ce qu'il y a dans les paquets

| Paquet | Contenu |
|---|---|
| `HouseApp-windows-x64.zip` | Le code de HouseApp (JavaScript lisible), ses dépendances npm (`express`, `systeminformation`, `adm-zip`, et `@xterm/xterm` + `@xterm/addon-fit` pour l'affichage du terminal) et `node.exe` |
| `HouseApp-linux-*.tar.gz` | Pareil, avec le binaire `node` pour Linux |
| `HouseApp-source.zip` | Uniquement le code source |

Le seul exécutable inclus est **Node.js**, téléchargé depuis `https://nodejs.org/dist/` par `scripts/build.js`,
qui vérifie son empreinte SHA-256 avec le fichier `SHASUMS256.txt` officiel avant de l'intégrer. Les empreintes
des paquets eux-mêmes sont dans `SHA256SUMS.txt` (vérification : `certutil -hashfile fichier SHA256` sous Windows,
`sha256sum fichier` sous Linux).

## Comment une application du catalogue s'installe

Le catalogue est un simple fichier : [`lib/catalog.js`](lib/catalog.js). Chaque application y est décrite par le
**nom d'une image Docker publique** (ex : `jellyfin/jellyfin:latest`), ses ports et ses dossiers de données.
Aucune application n'est un `.exe` téléchargé et exécuté sur votre système.

Quand vous cliquez sur « Installer » ([`lib/apps.js`](lib/apps.js)) :

1. HouseApp choisit un port libre (il teste si le port est déjà utilisé).
2. Il lance `docker pull <image>` : Docker télécharge l'image depuis son registre officiel
   (Docker Hub, `ghcr.io`, `lscr.io`, `mcr.microsoft.com`, `registry.gitlab.com`).
3. Il lance `docker run -d --name houseapp-<id> --restart unless-stopped --label houseapp=1 -p <ports> -v <volumes> -e <variables> <image>`.

L'application tourne **dans un conteneur**, isolée du système : elle ne voit que les dossiers et ports que
vous lui donnez. Les commandes Docker sont lancées avec `execFile`, **sans passer par un shell**, donc un nom ou
une valeur ne peut pas injecter de commande. HouseApp ne liste, n'arrête et ne supprime **que** les conteneurs
portant l'étiquette `houseapp=1` : vos autres conteneurs ne sont jamais touchés.

Vérifier ce qui a été installé :

```bash
docker ps -a --filter label=houseapp=1
```

### Applications avec des droits étendus

Certaines applications du catalogue reçoivent plus d'accès, parce que c'est leur fonction. Installez-les
seulement si vous en avez besoin :

| Accès | Applications | Pourquoi |
|---|---|---|
| Socket Docker (`/var/run/docker.sock`) | Portainer, Dozzle, Watchtower, Glances | Elles gèrent ou surveillent Docker. Accès au socket Docker = contrôle total de Docker. |
| GPU (`--gpus all`) | Jellyfin, Plex, Ollama, ComfyUI | Accélération matérielle, seulement si une carte NVIDIA est détectée. |

## Applications importées depuis votre PC

Le dossier ou le `.zip` envoyé est vérifié ([`lib/localapps.js`](lib/localapps.js)) : les chemins contenant `..`
ou absolus sont refusés. Les fichiers sont rangés dans `data/local-apps/<id>`. Le projet est ensuite **compilé dans
un conteneur** (`docker build`, images officielles Microsoft `mcr.microsoft.com/dotnet/sdk` et `aspnet`) puis lancé
dans un conteneur. Votre code n'est jamais exécuté directement sur le système hôte.

## Panel Minecraft

- Le panel est un module **non installé par défaut** : il s'ajoute depuis Applications → Panel Minecraft.
- Les serveurs utilisent l'image open source [`itzg/minecraft-server`](https://github.com/itzg/docker-minecraft-server).
- **Le CLUF (EULA) de Minecraft n'est jamais accepté à votre place** : le serveur n'est créé qu'après votre clic
  sur « J'accepte ».
- Les plugins et mods « Modrinth » sont téléchargés **dans le conteneur** par l'outil de l'image itzg depuis
  `api.modrinth.com`. Les `.jar` que vous envoyez vont dans le volume du serveur, jamais sur le système.
- L'éditeur de fichiers n'accède qu'au dossier `/data` du serveur (les chemins qui en sortent sont refusés), en
  tant qu'utilisateur non-root (uid 1000).
- **Accès Internet** : rien n'est ouvert sans votre clic.
  - *UPnP* : HouseApp demande à votre routeur d'ouvrir le port du serveur Minecraft, et seulement celui-là.
    « Fermer le port » le referme.
  - *playit.gg* : l'agent officiel `ghcr.io/playit-cloud/playit-agent` tourne dans un conteneur qui ne voit que le
    réseau du serveur Minecraft. Votre clé secrète reste sur votre serveur (`data/minecraft.json`).

## Connexions réseau effectuées

HouseApp n'envoie **aucune télémétrie**. Voici toutes les connexions sortantes possibles :

| Destination | Quand |
|---|---|
| Registres Docker | Installation d'une application (via Docker) |
| `cdn.jsdelivr.net` | Affichage des icônes du catalogue (par votre navigateur) |
| `api.modrinth.com` | Recherche de plugins/mods (quand vous cherchez) |
| `api.mcsrvstat.us` | Bouton « Tester depuis Internet » |
| `mc-heads.net` | Avatars des joueurs (par votre navigateur) |
| Votre routeur (UPnP, réseau local) | Onglet « Accès Internet » |
| `playit.gg` | Seulement si vous configurez le tunnel |
| Votre Home Assistant | Seulement si vous le connectez |
| `api.github.com`, `github.com` | Paramètres → Mise à jour (vérifier / télécharger la nouvelle version) |
| `api.ipify.org` | Paramètres → Accès, mode Internet (affiche votre adresse publique) |
| `nodejs.org` | Seulement pendant la fabrication des paquets (`scripts/build.js`) |

## Droits demandés à l'installation

- **Windows** : `Setup.bat` n'a pas besoin des droits administrateur. Il les demande (fenêtre UAC) uniquement pour
  créer la règle de pare-feu « HouseApp », si vous acceptez. Le démarrage automatique est un simple raccourci
  dans votre dossier Démarrage.
- **Linux** : `install.sh` s'exécute avec `sudo` pour copier HouseApp dans `/opt/houseapp`, créer l'utilisateur
  système `houseapp` (sans shell) et le service systemd. HouseApp tourne ensuite **sans root**, sous cet
  utilisateur, avec les protections systemd `NoNewPrivileges`, `ProtectSystem` et `ProtectHome`. Si Docker est
  absent, le script propose le script d'installation officiel `https://get.docker.com`, seulement si vous acceptez.

Point important : l'accès à Docker équivaut à un accès administrateur à la machine. Protégez votre mot de passe
HouseApp, et gardez le mode d'accès « ce PC + Tailscale » (par défaut) plutôt que d'exposer l'interface sur Internet.

## Mise à jour

La mise à jour (bouton **Paramètres → Mise à jour**, `update.sh`, `Update.bat`) télécharge le paquet de la release
GitHub et **vérifie son empreinte SHA-256** avec `SHA256SUMS.txt` avant de toucher à quoi que ce soit ; un paquet
corrompu est refusé sans rien modifier. Seuls les fichiers du programme changent : données et réglages restent.

- **Windows** : HouseApp lance `scripts\update.ps1` avec vos droits habituels (pas d'administrateur).
- **Linux** : HouseApp tourne sans root et ne peut pas se mettre à jour lui-même. Le bouton dépose un fichier
  `update.request` dans ses données ; l'unité systemd `houseapp-update.path` le voit et lance
  `/opt/houseapp/update.sh` **en root**. Le contenu de ce fichier est ignoré : HouseApp peut seulement *demander*
  la mise à jour officielle, pas choisir ce qui est exécuté (le script et `/opt/houseapp` appartiennent à root).
  Pour retirer ce bouton : `sudo systemctl disable --now houseapp-update.path`.

## Protection de l'interface

- Mot de passe haché avec **scrypt** (sel aléatoire), jamais stocké en clair.
- Session dans un cookie `HttpOnly`, `SameSite=Strict`, signé HMAC-SHA256 ; changer le mot de passe déconnecte
  toutes les autres sessions.
- Par défaut, l'interface n'écoute que sur `127.0.0.1` et l'adresse Tailscale : elle est invisible sur le Wi-Fi
  et sur Internet.
- **Paramètres → Accès** permet d'élargir (réseau local, Internet). Le mode Internet ouvre le port sur la box
  (UPnP) : HouseApp parle en HTTP, le mot de passe circulerait donc en clair. Pour un accès depuis Internet,
  préférez Tailscale ou un nom de domaine derrière un proxy HTTPS. Un changement qui couperait l'adresse que vous
  utilisez demande une confirmation.

## Terminal des applications

Le bouton **Terminal** donne une ligne de commande **dans le conteneur** de l'application, avec les droits de ce
conteneur (souvent root *dans le conteneur*, pas sur la machine). Pour une application à qui HouseApp donne
la socket Docker (voir « Applications avec des droits étendus »), cela revient à contrôler la machine : c'est le
même niveau d'accès que l'installation d'applications, réservé à la personne qui a le mot de passe.

- HouseApp parle à la socket Docker (celle qu'utilise déjà la commande `docker`) pour créer un vrai terminal.
- La connexion (WebSocket) exige une session valide **et** doit venir de la page HouseApp elle-même (en-tête
  `Origin`) : une autre page web ouverte dans votre navigateur ne peut pas ouvrir de terminal.
- Seuls les conteneurs installés par HouseApp sont accessibles (étiquette `houseapp=1`), 8 terminaux au plus.
- À la fermeture de la fenêtre, tous les processus lancés depuis ce terminal sont arrêtés.

## Signaler un problème

Ouvrez une *issue* sur le dépôt GitHub.
