# Prompt — HouseApp (OS domestique web inspiré de CasaOS)

Crée une application web auto-hébergée nommée **HouseApp**, inspirée de CasaOS, qui transforme un PC
(Windows / Linux avec Docker) en serveur domestique pilotable depuis un navigateur.

## Contraintes techniques
- Backend **Node.js 20+ / Express**, frontend **HTML/CSS/JS sans build** (servi en statique).
- Toutes les applications tournent dans **Docker**, pilotées via la CLI `docker` (`execFile`, jamais via un shell,
  pour éviter les injections).
- HouseApp ne gère **que ses propres conteneurs** (étiquette `houseapp=1`). Les autres conteneurs de la machine
  ne sont jamais listés, arrêtés ni supprimés.
- Les données persistantes vont dans `./data/` (config, volumes des applications, mondes Minecraft).
- Authentification par mot de passe (défini au premier lancement, haché avec scrypt, session en cookie HttpOnly).

## Fonctionnalités
1. **Tableau de bord** (style CasaOS) : fond dégradé, widgets en direct (rafraîchis toutes les 2 s)
   - CPU (charge globale + par cœur, modèle, température si disponible)
   - RAM (utilisée / totale)
   - **GPU** (NVIDIA via `nvidia-smi` : charge, VRAM, température, puissance ; repli sur `systeminformation`)
   - Disques (espace par volume), réseau (débit montant / descendant), uptime, OS
   - Grille d'icônes des applications installées : clic = ouverture de l'application, menu = démarrer / arrêter /
     redémarrer / journaux / désinstaller.
2. **App Store** avec **plus de 50 applications** classées par catégories (Domotique, Médias, Téléchargement,
   Cloud & fichiers, Réseau, Supervision, Développement, Bases de données, Productivité, IA, Jeux, Outils).
   - Recherche + filtre par catégorie.
   - Installation asynchrone avec suivi (pull de l'image puis création du conteneur) et journal en direct.
   - Ports modifiables avant installation ; si un port est occupé, le port libre suivant est choisi automatiquement.
   - Variables d'environnement modifiables (mots de passe, etc.).
   - Prise en charge du GPU (`--gpus all`) pour les applications qui en profitent (Ollama, Jellyfin…).
3. **Panel Minecraft** (image `itzg/minecraft-server`)
   - Créer plusieurs serveurs : nom, type (Vanilla, Paper, Fabric, Forge, Purpur), version, RAM, port,
     joueurs max, mode de jeu, difficulté, MOTD, mode en ligne, seed.
   - Démarrer / arrêter / redémarrer / supprimer (avec ou sans le monde).
   - **Console en direct** (flux des journaux) + envoi de commandes via RCON (`rcon-cli`).
   - Liste des joueurs connectés, consommation CPU / RAM du serveur.
   - Modification des réglages (recréation du conteneur, le monde est conservé).
4. **Home Assistant**
   - Installable en un clic depuis l'App Store.
   - Page « Maison » : connexion à Home Assistant (URL + jeton longue durée), affichage des entités
     (lumières, interrupteurs, capteurs, climat…) regroupées par domaine, bascule on/off des entités pilotables.
5. **Paramètres** : changement de mot de passe, configuration Home Assistant, informations système.

## Qualité attendue
- Interface responsive (mobile et bureau), thème sombre en verre dépoli comme CasaOS.
- Gestion d'erreurs claire (Docker absent, port occupé, image introuvable).
- Script de démarrage `start.bat` et README en français.
