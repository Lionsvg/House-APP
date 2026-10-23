---
name: houseapp-app
description: Créer, modifier ou empaqueter une application importable dans HouseApp (le serveur domestique type CasaOS). Structure obligatoire - un dossier avec import.json + un dossier Projet contenant un projet C# (.csproj) ou un Dockerfile. À utiliser dès que l'utilisateur veut "faire une app pour HouseApp", "importer dans HouseApp", préparer un import.json, ou packager un projet C# / ASP.NET pour son serveur maison.
---

# Créer une application importable dans HouseApp

HouseApp importe une application depuis le PC de l'utilisateur (bouton **App Store → Importer**, dossier ou `.zip`),
construit une image Docker puis lance le conteneur. Ton travail : produire un paquet qui respecte **exactement**
la structure ci-dessous et qui se construit du premier coup.

## Structure du paquet

```
MonApp/
├── import.json        ← obligatoire, à la racine
├── icon.png           ← optionnel (png, svg, jpg, webp), référencé dans import.json
└── Projet/            ← obligatoire : le code
    ├── MonApp.csproj
    ├── Program.cs
    └── Dockerfile     ← optionnel : s'il existe, HouseApp l'utilise tel quel
```

- Le zip peut contenir `MonApp/` à sa racine ou directement `import.json` : les deux marchent.
- `bin/`, `obj/`, `.vs/`, `.git/`, `node_modules/` sont ignorés à l'import : ne compte pas dessus.
- Pas de chemin absolu ni de `..` dans les chemins (refusés).

## import.json

```json
{
  "name": "Mon App",
  "description": "Ce que fait l'appli, en une phrase.",
  "version": "1.0.0",
  "icon": "icon.png",
  "port": 8080,
  "volumes": ["/app/data"],
  "env": { "CLE": "valeur" }
}
```

| Champ | Obligatoire | Rôle |
|---|---|---|
| `name` | oui | Nom affiché (40 caractères max). L'identifiant est déduit du nom, sauf si `id` est donné. |
| `id` | non | Identifiant (`a-z0-9-`). Réimporter le même `id` **met à jour** l'appli en gardant ses données. |
| `description`, `version` | non | Affichés dans HouseApp. |
| `icon` | non | Fichier du paquet (`icon.png`…), nom d'icône du catalogue dashboard-icons (`grafana`), ou URL. |
| `port` | oui si web | Port d'écoute **dans le conteneur** (défaut 8080). |
| `hostPort` | non | Port souhaité sur le serveur. S'il est pris, HouseApp prend le suivant libre. |
| `web` | non | `false` pour un service sans page web (bot, tâche de fond…). |
| `volumes` | non | Dossiers **du conteneur** à conserver entre mises à jour (ex : `/app/data`). |
| `env` | non | Variables d'environnement (clés `A-Z0-9_`). |
| `gpu` | non | `true` pour `--gpus all` si une carte NVIDIA est présente. |
| `project` | non | Dossier du code si ce n'est pas `Projet`. |
| `dotnet.project` | non | Chemin du `.csproj` (relatif à `Projet/`) s'il y en a plusieurs. |
| `dotnet.version` | non | Force la version .NET (`"10.0"`). Sinon déduite de `<TargetFramework>`. |

## Comment HouseApp construit un projet C#

Sans Dockerfile, HouseApp génère :

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:<version> AS build
WORKDIR /src
COPY . .
RUN dotnet publish "<csproj>" -c Release -o /app/publish
FROM mcr.microsoft.com/dotnet/aspnet:<version>
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:<port>
EXPOSE <port>
ENTRYPOINT ["dotnet", "<AssemblyName>.dll"]
```

Conséquences à respecter :
1. **Un seul `.csproj`** dans `Projet/`, ou un seul en `Sdk="Microsoft.NET.Sdk.Web"`, sinon renseigner `dotnet.project`.
   Pour une solution multi-projets (bibliothèques), mets le `.sln` et tous les projets sous `Projet/` et indique `dotnet.project`.
2. `<TargetFramework>net10.0</TargetFramework>` (ou `net8.0`, `net9.0`) — c'est lui qui choisit l'image.
3. L'appli doit écouter sur `ASPNETCORE_URLS` (comportement par défaut d'ASP.NET Core) : **ne code pas** `UseUrls("http://localhost:5000")`,
   `localhost` dans un conteneur la rend injoignable.
4. Le code tourne dans `/app` sous Linux : chemins avec `Path.Combine`, pas de `C:\`, sensible à la casse.
5. Données persistantes : écrire sous `Path.Combine(AppContext.BaseDirectory, "data")` (= `/app/data`) et déclarer `"volumes": ["/app/data"]`.
   Tout le reste est effacé à chaque mise à jour.
6. Pas de HTTPS dans l'appli (`app.UseHttpsRedirection()` à retirer) : HouseApp sert en HTTP, Tailscale chiffre déjà.
7. Paquets NuGet : autorisés (restaurés pendant le build). Pas de dépendance à Windows (WinForms, WPF, registre).
8. Appli console / worker sans page web : `"web": false`, `Sdk="Microsoft.NET.Sdk"` ou `Microsoft.NET.Sdk.Worker`.

## Autres langages

Mets un `Dockerfile` dans `Projet/` : HouseApp le construit tel quel (contexte = `Projet/`).
Le conteneur doit écouter sur `0.0.0.0:<port>` avec `port` identique à celui de `import.json`.

## Procédure pour Claude

1. Crée `MonApp/import.json` + `MonApp/Projet/…` (et l'icône si utile). Exemple complet de référence :
   `exemples/HelloHouse/` dans le dossier de HouseApp.
2. Vérifie la compilation si le SDK .NET est installé : `dotnet build MonApp/Projet`.
   Sinon, ou pour tester comme HouseApp : `docker build -t test-monapp MonApp/Projet` avec le Dockerfile ci-dessus.
3. Vérifie que `import.json` est un JSON valide et que `port` correspond au port d'écoute réel.
4. Pour livrer un zip : compresse le dossier `MonApp` (sans `bin/` ni `obj/`). Sous Windows :
   `Compress-Archive -Path MonApp -DestinationPath MonApp.zip -Force`.
5. Dis à l'utilisateur : *HouseApp → App Store → Importer → choisir le dossier ou le .zip*.
   Réimporter avec le même `id` met l'appli à jour sans perdre `volumes`.
