<p align="center"><img src="assets/icon.png" width="128" alt="Chernolink"></p>

# Chernolink

Launcher Windows (Electron) pour DayZ : navigateur de serveurs officiels, communautaires et LAN, et gestion des mods Steam Workshop (installation et mises à jour automatiques).

## Démarrage

```bash
npm install
npm start
```

Prérequis : Windows x64, Node.js 20+, Steam lancé et connecté au compte qui possède DayZ.

## Créer l'exécutable

```bash
npm run dist
```

Produit dans `dist/` un installateur (`Chernolink-<version>-setup.exe`) et une version portable (`Chernolink-<version>-portable.exe`).

Si la compilation échoue avec « Cannot create symbolic link » (extraction de `winCodeSign`), activez le mode développeur de Windows ou lancez une fois la commande dans un terminal administrateur.

## Fonctionnalités

- **Serveurs officiels / communautaires** : liste maître (~11 000 serveurs) récupérée depuis l'API publique de DZSA Launcher. Filtres (carte, vides/pleins, mot de passe, 1PP/3PP, vanilla/moddé, version du jeu), recherche (nom, IP, nom de mod), tri, ping mesuré en direct (A2S) sur les lignes visibles.
- **LAN / Direct** : découverte des serveurs du réseau local par broadcast A2S (ports query 27016-27020, 2303/2305/2307), ajout manuel par `IP:port_query`. Les mods des serveurs sont lus directement via `A2S_RULES`.
- **Favoris et historique** des serveurs rejoints.
- **Rejoindre** : vérifie les mods requis par le serveur, télécharge les mods manquants ou périmés via votre client Steam (Steamworks), crée des jonctions courtes `DayZ\!dzl\@<id>` puis lance le jeu avec `-connect`, `-port`, `-mod`, `-password`, `-name`.
- **Mods** : liste des mods Workshop installés, détection des mises à jour (comparaison avec l'API Steam), mise à jour unitaire ou globale, installation par ID/lien, désinstallation (désabonnement), détection des dossiers orphelins laissés après un désabonnement.
- **Paramètres** : nom de profil, dossier de DayZ, paramètres de lancement supplémentaires, BattlEye on/off, mise à jour automatique des mods.

## Fonctionnement technique

| Module | Rôle |
| --- | --- |
| `src/core/steam.js` | Détecte Steam, les bibliothèques et l'installation de DayZ |
| `src/core/a2s.js` | Requêtes UDP A2S_INFO / A2S_RULES, décodage des mods DayZ, découverte LAN |
| `src/core/servers.js` | Liste maître, rafraîchissement et ping des serveurs |
| `src/core/mods.js` | Mods installés, API Workshop, jonctions et paramètre `-mod` |
| `src/core/workshop-worker.js` | Processus isolé qui pilote Steam (abonnement/téléchargement). Il se ferme après 30 s d'inactivité : pendant qu'il tourne, Steam vous affiche « en jeu sur DayZ ». |
| `src/core/launcher.js` | Lancement via `DayZ_BE.exe` (BattlEye) ou `DayZ_x64.exe` |

Les données (paramètres, favoris, historique) sont dans `%APPDATA%\dayz-launcher\launcher.json`.

## Tests

```bash
npm test
```

## Limites connues

- La liste des serveurs officiels dépend de ce que l'API DZSA référence (environ 280 au moment de l'écriture).
- Les serveurs LAN sans BattlEye nécessitent de décocher BattlEye dans les paramètres si le serveur n'est pas détecté comme tel.
