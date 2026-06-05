# Design — Slack optionnel + confirmations au terminal

> Document de cadrage. Aucune ligne de code n'est écrite tant que ce design n'est pas validé.
> Statut : **brouillon à relire**.

## 1. Objectif

Rendre CollaborAI **facilement installable et auto-hébergeable par chaque organisation**, et
**rendre Slack optionnel** :

- Par défaut (sans Slack), un dev déclenche du travail sur la machine d'un autre via un **client CLI**,
  et la cible **confirme/répond dans le terminal de son daemon**.
- Avec `server --slack`, comportement Slack actuel conservé, plus un **wizard** qui demande et
  persiste les tokens au premier lancement.

Décisions déjà prises avec l'utilisateur :

- Délégation **multi-machines** conservée en mode sans Slack (donc un client CLI requêteur).
- Daemon en **foreground / TTY**, relancé à chaque reboot. **launchd abandonné et supprimé.**
- Tokens persistés dans un **fichier séparé sous `~/.collaborai/`**.

## 2. Mode de fonctionnement : un seul mode par serveur

Le Server tourne dans **un** mode, choisi au lancement :

| Lancement | Intake des requêtes | Confirmation | Sortie (stream) |
|---|---|---|---|
| `server` (défaut) | Client CLI (WebSocket) | **TTY du daemon** | Relayé au client CLI |
| `server --slack` | Événements Slack | Boutons Slack (côté Server) | Message Slack édité |

Justification : la confirmation a lieu *là où se trouve l'humain responsable de la machine cible*.
En Slack il est dans Slack ; sans Slack il est devant le terminal du daemon. Mélanger les deux modes
sur un même serveur ajouterait de la complexité sans bénéfice clair. **À valider** (cf. §8).

## 3. Identité & routage sans Slack

`slackUserId` est renommé en **`daemonId`** partout (protocole, registre, routage).

- **Mode Slack** : `daemonId` = identifiant utilisateur Slack (comportement inchangé, simple renommage).
- **Mode sans Slack** : `daemonId` = handle lisible choisi par le dev (ex. `alice`, `alice-macbook`),
  défini dans `daemon.config.json` ou via `--id`. À défaut, fallback sur le hostname.

Le client CLI adresse une cible par ce `daemonId` : `collaborai ask alice ...`.

## 4. Changements de protocole (`src/protocol.ts`)

### 4.1 Enregistrement (rôles)

```ts
// Daemon → Server
{ type: "register"; role: "daemon"; daemonId: string; token: string }
{ type: "register"; role: "client"; clientId: string; token: string }   // nouveau rôle
```

Le Server garde le **registre des daemons** (`Map<daemonId, …>`) et ajoute un suivi des **clients
connectés** (pour relayer le stream vers le bon socket).

### 4.2 Soumission d'une tâche par le client CLI

```ts
// Client → Server
{ type: "get_projects"; requestId: string; targetDaemonId: string }
{ type: "task_request"; requestId: string; targetDaemonId: string; projectName: string; workingDir: string; prompt: string }
{ type: "list_targets"; requestId: string }   // optionnel : `collaborai who`
```

Flux : le client demande `get_projects` → le Server fait le round-trip `list_projects` existant vers
le daemon → renvoie la liste au client → le client **choisit le projet** (flag `--project` ou prompt
local) → envoie `task_request` avec le `workingDir` issu de la liste reçue.

> La sélection de projet, aujourd'hui côté demandeur dans Slack (`static_select`), passe donc **côté
> client CLI** — cohérent : c'est le demandeur qui choisit.

### 4.3 Confirmation côté daemon (round-trip nouveau)

Aujourd'hui le daemon exécute la tâche dès le message `task`. On insère une confirmation :

```ts
// Server → Daemon
{ type: "confirm_request"; taskId: string; prompt: string; workingDir: string; requesterId: string }

// Daemon → Server
{ type: "confirm_response"; taskId: string; accepted: boolean }
```

Le daemon, à réception de `confirm_request` :

1. Évalue ses propres règles d'auto-accept (cf. §6). Si match → `accepted: true` sans prompt.
2. Sinon, **prompt `readline` dans le TTY** : affiche demandeur + projet + prompt, attend `o/n`.
3. Renvoie `confirm_response`. Si accepté, le Server envoie le `task` existant ; sinon il notifie le
   client que la tâche est refusée.

> En **mode Slack**, ce round-trip n'est pas utilisé : la confirmation reste les boutons Slack
> côté Server (comportement actuel). La décision d'auto-accept y reste côté Server.

### 4.4 Relais du stream vers le client

`stream` / `done` / `error` (Daemon → Server) existent déjà. Le Server, au lieu d'éditer un message
Slack, **relaie ces messages au socket du client** qui a émis la `task_request` (table
`taskId → clientWs`). En mode Slack, l'ancien chemin (édition de message) est conservé.

## 5. Abstraction front-end (côté Server)

Le cœur d'orchestration (registre, `requestProjects`, dispatch, relais) est **agnostique**. Ce qui
varie est encapsulé dans une interface :

```ts
interface StreamSink {
  append(chunk: string): Promise<void>
  finish(): Promise<void>
  error(message: string): Promise<void>
}

interface Frontend {
  start(): Promise<void>                          // Slack: Socket Mode ; CLI: rien de spécial
  createSink(ctx: TaskContext): Promise<StreamSink>
}
```

- **SlackFrontend** : `createSink` poste un placeholder puis édite le message (comportement actuel).
- **CliFrontend** : `createSink` relaie `stream`/`done`/`error` au socket client.

Le point d'intake converge sur un **`handleTaskRequest({ requesterId, targetDaemonId, projectName, workingDir, prompt })`** commun, appelé soit par le handler Slack `app_mention`, soit par le
handler WS `task_request`.

### Plan de refactor en 3 étapes vérifiables

1. **Extraire l'interface** `Frontend`/`StreamSink` avec **zéro changement de comportement** :
   Slack devient la seule implémentation, branchée comme aujourd'hui. (`npx tsc --noEmit` + test manuel Slack.)
2. **Ajouter `CliFrontend` + le client CLI** (`src/client/`) : intake `task_request`, sink de relais,
   commandes `who` / `ask`.
3. **Ajouter le round-trip `confirm_request`/`confirm_response`** + le prompt TTY côté daemon.

## 6. Permissions sans canaux Slack

`allowedSenders` (par canal) et `shouldAutoAccept` (par canal) reposent sur les **canaux Slack**, qui
n'existent pas en mode sans Slack. Proposition :

- **Connexion** : barrière unique = `WS_AUTH_TOKEN` (déjà là). Sans token valide, pas de socket.
- **Exécution** : gérée **côté daemon** :
  - Confirmation interactive TTY par défaut (le propriétaire de la machine voit chaque requête).
  - `autoAccept` **reframé par identité de demandeur** au lieu de par canal :
    `{ autoAccept: { requesters: string[] } }` où `"*"` = quiconque possède le token.

`AutoAcceptRules` (par canal) reste utilisé tel quel en **mode Slack**. En mode sans Slack on
utilise la nouvelle forme par demandeur. **À valider** (cf. §8).

## 7. Secrets & wizard (Lot 1, indépendant)

### Fichier `~/.collaborai/secrets.json` (par machine)

```json
{
  "wsAuthToken": "…",
  "slack": { "botToken": "xoxb-…", "appToken": "xapp-…" }
}
```

- **Précédence de chargement** : variable d'env → `secrets.json` → (avec `--slack`) **wizard** qui
  prompte les tokens manquants, les écrit dans `secrets.json`, puis continue. Lancements suivants :
  pas de re-prompt. Garde la compat `.env`.
- **Daemon / client** : ont besoin de `wsAuthToken` + URL du Server + leur `daemonId`/`clientId`.
  Le client a son propre `~/.collaborai/client.json` (URL, clientId) + lit `wsAuthToken` depuis
  `secrets.json`. Premier lancement du client → mini-wizard.

### Packaging Server (indépendant du mode)

- `Dockerfile` (build `tsc`, runtime Node sans `tsx`) + `docker-compose.yml`
  (volume sur `~/.collaborai`, expose `WS_PORT`, charge `.env`/secrets).
- `slack-app-manifest.yml` (scopes + Socket Mode prêts) pour que chaque org crée son app en 2 clics.
- Réseau laissé au choix de l'org (Tailscale / VPS+TLS / PaaS) — documenté, pas figé.

## 8. Décisions verrouillées

1. ✅ **Mode global par serveur** : `server --slack` **XOR** `server` (sans Slack). Pas de mode mixte.
   La confirmation TTY ne coexiste pas avec les boutons Slack sur un même serveur.
2. ✅ **Permissions sans Slack** : confirmation TTY côté daemon par défaut + `autoAccept` reframé
   **par identité de demandeur** (`{ requesters: string[] }`, `"*"` = quiconque a le token).
   `WS_AUTH_TOKEN` reste la barrière de connexion. Pas d'allowlist côté Server.
3. ✅ **`daemonId`** : handle choisi en `daemon.config.json` ou `--id`, fallback hostname.
4. ✅ **Format `secrets.json`** : `{ wsAuthToken, slack: { botToken, appToken } }` (cf. §7).

## 9. Suppression launchd (décidée)

À retirer : `src/daemon/install.ts`, `src/daemon/install.test.ts`, scripts npm
`daemon:install`/`daemon:uninstall`, et la section correspondante de `CLAUDE.md`.
