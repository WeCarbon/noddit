[English](README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · **Français** · [العربية](README.ar.md)

# Noddit

Vous confiez à un agent une tâche de deux heures — ou à cinq agents, chacun
la sienne — puis vous passez à autre chose. Une heure plus tard, trois
d’entre eux attendent une réponse dans des conversations que vous ne
surveilliez pas, et vous ne savez plus lequel travaille encore.

**Noddit donne à vos agents un seul endroit où déposer leur travail et leurs
questions, et vous donne un seul écran pour tout surveiller. Les agents
demandent ; vous répondez d’une touche ; l’agent en est informé et
reprend — pendant qu’il tourne encore.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/WeCarbon/noddit/main/docs/app.fr.dark.png">
  <img alt="L’application de bureau Noddit : la vue Disponible avec une décision en attente ouverte, ses deux options en cartes, des barres d’avancement et une nouvelle demande en attente d’une IA" src="https://raw.githubusercontent.com/WeCarbon/noddit/main/docs/app.fr.png">
</picture>

<sub>Application de bureau — à construire depuis <code>app/</code> pour l’instant, pas encore de version publiée</sub>

![Démo : le tableau nod s’ouvre sur l’arbre du travail en cours ; on lit une décision en attente, on y répond d’une touche, puis un agent récupère la réponse avec nod read](https://raw.githubusercontent.com/WeCarbon/noddit/main/docs/demo.gif)

<sub>Dans le terminal</sub>

## Pourquoi

| Sans Noddit | Avec Noddit |
|---|---|
| Un agent demande « A ou B ? » dans le chat. Vous ne le voyez pas ; il attend une heure. | Chaque question ouverte est sur un seul écran, celles qui bloquent un agent en premier. |
| Vous répondez, la réponse disparaît dans le défilement, la session suivante ne la voit jamais. | La question et votre réponse sont un fichier markdown dans git, pour de bon. |
| « Qu’est-ce que tu fais ? Où en es-tu ? » — vous devez demander, donc l’interrompre. | Chaque tâche affiche sa barre de progression ; une qui se tait devient grise, puis rouge. |
| Cinq agents partagent un seul `TODO.md`, choisissent le même numéro, s’écrasent l’un l’autre. | Chaque tâche est son propre fichier avec son propre identifiant ; n’importe quel nombre d’agents peut écrire à la fois. |
| Vous partez, et tout s’arrête. | Chaque question porte une valeur par défaut et dit ce qui se passe si vous ne répondez pas ; les agents continuent sur le reste. |

Ce n’est pas un tableau de planification. C’est le lien entre un agent en
cours d’exécution et vous : sa question vous arrive, votre réponse lui
arrive, et les deux sont conservées.

## À quoi ça ressemble

1. Votre agent rencontre un choix. Plutôt que de le demander dans le chat,
   il exécute :

   ```sh
   nod ask W4 -o 1="Keep current CDN" 2="Switch to Fastly" --default 1
   ```

2. Vous exécutez `nod` dans n’importe quel terminal. W4 est en haut, marqué
   ◆ À décider, avec les deux options et ce que coûte chacune.

3. Vous appuyez sur `2`.

4. L’agent en est informé tout de suite, lit « Switch to Fastly » et
   continue. La question et votre réponse restent dans
   `decisions/active/4-pick-cdn.md`, dans git.

## Démarrage rapide (Claude Code)

```sh
npm i -g @wecarbon/noddit
cd your-project && nod init
```

Ensuite, dans Claude Code :

```
/plugin marketplace add wecarbon/noddit
/plugin install decs@decisions-md
```

C’est tout. Donnez une tâche à votre agent comme d’habitude. Il consigne
son travail et pose ses questions via nod de lui-même. Exécutez `nod`
dans un autre terminal pour observer.

Vous utilisez un autre agent ? Collez [`AGENTS.md`](AGENTS.md) dans ses
instructions — les règles ne sont que des appels CLI, n’importe quel agent
avec un terminal peut les suivre.

## Trois mots

- **Nœud** — une chose que fait un agent. Un fichier markdown.
- **À décider** — un nœud qui attend votre réponse. Il arrive avec des
  options ; appuyez sur un chiffre.
- **Tableau** — l’écran que vous obtenez en exécutant `nod`. Tout, en
  direct.

C’est tout ce qu’il faut pour commencer. Le reste de cette page explique
comment ça marche en dessous.

---

## L’idée

Une seule sorte de chose — un **nœud** — et un seul espace d’identifiants.

Un nœud est quelque chose que l’IA fait. Quand l’agent sait comment faire,
il le fait, tout simplement. Quand il a d’abord besoin du responsable, le
nœud devient **à décider**, avec des options, une valeur par défaut, et ce
qui se passe si personne ne répond. Un nœud en cours qui tombe sur une
question ne crée pas une deuxième entrée ; il se transforme lui-même en
question, et redevient actif dès que vous répondez.

```
decisions/
  decs.json                                  # {"letter": "W"} → refs read W12
  active/12-ship-v2-4.md                     # a root node still in play
  active/12-ship-v2-4/13-run-test-suite.md   # its children live in its folder
  archived/9-rotate-api-keys.md              # done or closed, kept forever
  attachments/12/after.png
  .ids/12                                    # zero-byte reservation (O_EXCL)
```

Parce que chaque nœud est son propre fichier et que les identifiants sont
réservés avec `O_EXCL`, n’importe quel nombre d’agents peut écrire en même
temps sans collision. Parce que c’est du markdown dans git, vous avez
l’historique, les diffs, la revue et `grep` gratuitement.

## Ce que vous obtenez

**Pour l’humain — le tableau.** `nod bench` est une interface terminal en
direct sur tous les projets que vous avez enregistrés. Cinq onglets :

| onglet | affiche |
|---|---|
| **Disponible** | ce qui peut avancer maintenant : en cours, en attente de quelqu’un, prêt à démarrer, qui vous attend, répondu |
| **Actif** | ce qui se passe : seulement en cours et à décider |
| **À décider** | uniquement les questions pour vous, par projet, celles qui bloquent un agent en premier |
| **Tout** | tout, les nœuds terminés repliés dans une ligne `✓ Terminé N` |
| **En attente** | bloqué à l’extérieur — un·e collègue, un·e client·e, un service — l’attente la plus longue en premier |

Le panneau de gauche est l’arbre des nœuds avec barres de progression et
péremption (gris passé 30 minutes sans mise à jour, rouge passé une heure).
Le panneau de droite montre le nœud sélectionné : statut, urgence,
*« si vous ne répondez pas »*, parent, dépendances, corps, pièces jointes.
Appuyez sur `1`–`9` pour répondre, `Enter` pour la valeur par défaut. Les
captures d’écran s’affichent directement dans le terminal (iTerm2, kitty,
Ghostty, WezTerm).

**Pour l’agent — une CLI et un contrat.** Les agents créent des nœuds, les
découpent en nœuds enfants, rapportent leur progression, posent des
questions, et sont notifiés de vos réponses :

```sh
nod add "Ship v2.4" --task --author "lead · release"          # → W12
nod add "Run full test suite" --task --parent W12 --after W14
nod start W13
pytest | nod progress --parse pytest                           # bar moves by itself

nod ask W15 -o 1="Short & playful" 2="Plain & direct" --default 2 <<'EOF'
**What.** The first screen new users see after sign-up …
EOF
```

**Des notifications sans interrogation.** `nod monitor` affiche une ligne
pour chaque chose qu’un agent doit traiter — une réponse du responsable,
une relance, un nouvel élément d’une source externe, une réponse que
personne n’a récupérée depuis cinq minutes — et se souvient d’où chaque
session s’est arrêtée. Le plugin Claude Code le démarre pour toute la
session (`nod monitor --here`, qui surveille le projet courant) ; il se
déconnecte de lui-même après deux heures de calme avec une ligne
`DECS-IDLE`. Les sous-agents, ou une session après `DECS-IDLE`, l’arment
avec l’outil Monitor de Claude Code :

```
Monitor({ command: "nod monitor --mine", description: "nod", timeout_ms: 1800000 })
```

**Dépendances et ordre.** `--after W13` retient un nœud jusqu’à ce que W13
soit terminé. Vous pouvez tout de même répondre à une question en avance ;
le nœud attend alors **à faire** et démarre quand son tour vient.

**Sources externes.** Pointez un petit adaptateur vers des issues GitHub,
une boîte de support ou un formulaire de retour. Il synchronise
*uniquement des références* (identifiant + titre, url/état/origine en
option), jamais le corps, jamais les identifiants de connexion. L’en-tête
du tableau vous dit, par source, si elle est à jour et qui détient quoi :

```
Sources github-issues ✗ non traité 2 W7 1   support-inbox ✓ à jour
```

**Des portes d’approbation pour tout ce qui sort.** Attachez un brouillon
avec `--approval-content` ; nod enregistre son sha256. Avant d’envoyer,
l’agent lance `nod approved W20 --check draft.html` — ça échoue sauf si
*vous* avez choisi l’option d’approbation *pour exactement ce contenu*. Un
agent qui relaie un « envoyez-le » depuis le chat ne peut pas approuver en
votre nom.

**Reporter.** Appuyez sur `d` sur tout ce que vous voulez mettre de côté.
Cela retire l’élément des vues de travail sans changer son état, et
l’agent qui le traite apprend que le responsable l’a reporté et s’arrête jusqu’à ce que vous
le leviez.

## Installation

Nécessite Node 22.18+ (TypeScript s’exécute directement ; pas d’étape de
build).

```sh
git clone https://github.com/wecarbon/noddit.git
cd noddit && npm install
export PATH="$PWD/bin:$PATH"          # add to your shell profile

cd ~/code/your-project
nod init --letter W                  # creates decisions/, registers the project
nod add "Try nod" --task --author "me · kicking the tyres"
nod                                  # the bench (same as nod bench); q to quit
```

### Avec Claude Code

Le dépôt est aussi une marketplace de plugin Claude Code. Le plugin injecte
les règles d’usage au début de chaque session (plus les nœuds ouverts du
projet, pour qu’une session reprise retrouve son propre travail), démarre
`nod monitor` pour la session afin que vos réponses atteignent l’agent
sans qu’il ait à interroger, et rappelle à l’agent d’enregistrer ce que
vous dites d’un nœud dans le chat avant de répondre.

```
/plugin marketplace add wecarbon/noddit
/plugin install decs@decisions-md
```

(`/plugin marketplace add /path/to/noddit` fonctionne aussi pour un
clone local.)

Le guide complet pour les agents est [`AGENTS.md`](AGENTS.md) — copiez-le
dans votre propre `AGENTS.md` / `CLAUDE.md` si vous utilisez un autre
harnais d’agent. Les règles sont des appels CLI, donc n’importe quel agent
avec un terminal peut les suivre.

## Langue

`nod` choisit la langue de l’interface dans cet ordre :

1. `--lang <code>` sur n’importe quelle commande, par ex. `nod bench --lang fr`
2. la variable d’environnement `NODDIT_LANG` (l’ancien nom `DECS_LANG`
   marche toujours)
3. `nod config lang <code>` — stockée par utilisateur dans
   `~/.decs/config.json` (`$NODDIT_HOME/config.json`). `nod config lang`
   seule affiche la langue actuelle et son origine ; `nod config lang --off`
   la retire.
4. la locale système (`LC_ALL` / `LC_MESSAGES` / `LANG`, `C` / `POSIX`
   ignorés) : `zh_CN` → `zh-Hans`, `zh_TW` / `zh_HK` → `zh-Hant`, `fr_*` →
   `fr`, `ar_*` → `ar`
5. la langue d’affichage du système, quand aucune de ces variables n’est
   définie — les terminaux Windows standards (cmd, PowerShell) n’en ont
   aucune, donc nod la lit comme `Intl` de Node la rapporte
6. sinon, l’anglais — c’est aussi là qu’aboutit une locale que nod ne
   traduit pas

Codes : `en`, `zh-Hans`, `zh-Hant`, `fr`, `ar`. Les règles de début de
session et le rappel d’invite du plugin suivent la même
résolution (`plugin/rules.<code>.md`).

L’arabe s’écrit de droite à gauche. `NODDIT_BIDI=visual|terminal`
(l’ancien nom `DECS_BIDI` marche toujours, ou
`nod config bidi visual|terminal`, `--off` pour retirer) choisit
comment : `visual` (par défaut) fait réordonner chaque ligne par nod
lui-même avec l’algorithme bidirectionnel Unicode, pour les terminaux qui
dessinent strictement de gauche à droite (par ex. le Terminal de macOS) ;
`terminal` fait écrire nod dans l’ordre logique et enveloppe les segments
de gauche à droite intégrés (références comme W12, nombres, commandes,
titres en anglais) dans des isolats Unicode, pour les terminaux qui
appliquent eux-mêmes le bidi (iTerm2 avec bidi activé, kitty, les
terminaux basés sur VTE). En arabe, le tableau se met aussi en miroir : la
liste à droite, les détails à gauche. La sortie vers un tube et `--json`
reste toujours dans l’ordre logique, donc les scripts et les agents la
lisent sans changement. Les heures relatives (« il y a 3 jours ») suivent
aussi la langue.

Le format de fichier sur disque ne change jamais avec la langue : nod
écrit toujours les mêmes titres et jetons (`## 选项`, `### 1 · …`,
`## 已答（…）`, `## 回复（…）`, `## 补充（…）`, `## 附件`, `## 子问题`,
`验收通过`, …), si bien qu’un dépôt reste lisible par chaque coéquipier·ère
quelle que soit la langue de sa CLI. L’analyseur accepte aussi
`## Options`, `## Attachments`, `## Questions` quand vous écrivez un
fichier à la main. Voir [Le format de fichier](#le-format-de-fichier)
ci-dessous.

## Le déroulement d’une session

1. Vous donnez un objectif à l’agent principal. Il lance
   `nod add "Ship v2.4" --task`, le démarre, et le découpe en nœuds
   enfants avec des dépendances `--after`.
2. Il distribue des voies (sous-agents) avec leurs propres nœuds. Chaque
   voie connecte ses longues commandes à `nod progress` ; les barres du
   tableau avancent seules.
3. Une voie tombe sur une fourche. Elle lance `nod ask <id> -o …` avec des
   options, des coûts et une valeur par défaut. Le nœud devient un `◆`
   jaune sur votre tableau.
4. Vous appuyez sur `2`. `nod monitor` réveille la voie ; elle lance
   `nod read`, continue, et termine par
   `nod done <id> --note "412/412 passing"`.
5. Vous n’avez jamais eu à demander « où en sommes-nous ? » — et la semaine
   suivante, toute l’histoire est encore dans `decisions/archived/`.

## Aide-mémoire CLI

| | |
|---|---|
| `nod init [--letter W]` | crée `decisions/` ici et enregistre le projet |
| `nod add <title> [--task] [-o 1=… 2=…]` | nouveau nœud ; avec des options, il devient à décider. Le corps vient de stdin |
| `nod add <title> --parent W12 --after W13` | nœud enfant, ordonné après un autre |
| `nod start / done / close <id>` | À faire → En cours → Terminé / Fermé (`--reason obsolete\|superseded\|merged-into:W15`) |
| `nod ask <id> -o 1=… 2=…` | un nœud en cours a besoin du responsable |
| `nod hold <id> --on "Carol: icon set"` | en attente de quelqu’un à l’extérieur ; ne compte pas comme bloqué |
| `nod progress <pct> "msg"` · `… \| nod progress --parse pytest` | rapporter la progression (ou laisser un tube le faire) |
| `nod steps <id> "a" "b" "c"` · `nod step <id> 2` | travail en plusieurs étapes, le pourcentage est calculé pour vous |
| `nod note <id> "…"` | ajoute une note (agent par défaut ; `--human` pour le responsable) |
| `nod push <id> 2 [--note …]` | enregistre une réponse |
| `nod monitor [--mine] [--here] [--idle-exit 2h]` | le flux de notifications de l’agent |
| `nod read <id>` · `nod queue` | récupère les réponses / voir ce qui n’est pas encore récupéré |
| `nod attach <id> file [--approval-content --approve-on 1]` | attache un fichier ; verrouille-le sur une approbation |
| `nod approved <id> --check <file>` | ne sort en 0 que si exactement ce contenu a été approuvé |
| `nod defer <id>` · `nod undefer <id>` | reporter / reprendre |
| `nod show [open\|active\|deferred\|…] [--stale]` · `nod tree` · `nod get <id>` | lire le dépôt de données |
| `nod search <words> [--all]` | titres, corps, notes, noms de pièces jointes |
| `nod source register/sync/push/list/items/ack` | sources externes |
| `nod changes --since <t>` | tout ce qui suit un curseur, pour se remettre à niveau |
| `nod bench [.\|<dir>…] [--view decide]` | l’écran en direct |
| `nod` | dans un terminal, comme `nod bench` ; en tube ou dans un script, affiche l’aide |
| `nod config [<réglage> [<valeur>\|--off]]` | vos réglages : lang, bidi, view, images, mouse, idle-exit, unclaimed-after (aussi dans le tableau : `,`) |

Les identifiants s’écrivent `305`, `W305` (lettre du projet), `web:305`
(nom du projet), ou l’ancien `D305`. `nod <command> --help` a le reste.

## Raccourcis du tableau

| touche | |
|---|---|
| `↑` `↓` | déplacer |
| `←` `→` · `-` `+` | replier / déplier (mémorisé entre les sessions) |
| `Tab` `Shift-Tab` | changer de vue |
| `1`–`9` · `Enter` | répondre · prendre la valeur par défaut |
| `w` | aller au prochain nœud sur lequel un agent est bloqué |
| `g` ou `:` | aller à un identifiant |
| `N` | répondre sans décider (le nœud retourne à l’agent) |
| `d` | reporter / reprendre |
| `X` · `A` | fermer avec un motif · marquer comme vu et archiver |
| `M` | mode déplacement : ↑/↓ déplace le nœud parmi ses frères (ou son groupe dans une liste), ⏎ pour finir ; dans l’app, on glisse |
| `i` · `o` | choisir et voir des images · ouvrir une pièce jointe |
| `j` `k` `Ctrl-F` `Ctrl-B` | faire défiler le panneau de détail |
| `Z` · `?` · `q` | corps condensé · toutes les touches · quitter |
| `,` | réglages (langue, texte de droite à gauche, souris, …) |

La souris marche aussi : cliquez un onglet, un nœud, une option ou une
pièce jointe ; la molette fait défiler le panneau sous le curseur.

## Le format de fichier

Un nœud est du markdown avec un en-tête YAML. Les humains peuvent le lire
dans n’importe quel éditeur ; les agents et le tableau passent par la CLI,
qui gère le verrouillage et l’historique.

```markdown
---
id: 1
title: Choose a CDN
author: lane-perf · static assets
status: needs_decision
created: 2026-03-14T10:12:03+00:00
urgency: high
default: "1"
if_no_answer: stay; re-measure Friday
reversible: true
---

**What.** Static assets are served from one region.

**Why now.** APAC p95 doubled last week.

## 选项

### 1 · Stay on current CDN

### 2 · Move to edge provider

## 补充（agent · lane-perf · static assets · 2026-03-14 10:20:41）

Measured again: 1.9 s p95 from Singapore.
```

Ces titres — `## 选项`, `## 补充（…）`, et les autres — sont des jetons
fixes, non traduits : voir [Langue](#langue) ci-dessus pour pourquoi, et
comment chaque personne choisit la sienne.

Statuts : `not_started` À faire · `in_progress` En cours · `waiting` En
attente · `needs_decision` À décider · `decided` Décidé, pour l’IA ·
`completed` Terminé · `closed` Fermé. Les nœuds enfants vivent dans un
dossier nommé comme le fichier de leur parent ; les identifiants restent
plats, donc déplacer un nœud n’est qu’un renommage et chaque référence
tient toujours.

## Principes de conception

- **Des fichiers, pas un service.** Tout est dans `decisions/`, versionné
  avec votre code, lisible sans nod installé.
- **Le système de fichiers est le verrou.** Les identifiants viennent de
  fichiers `O_EXCL` ; chaque écriture relit le nœud sous son propre verrou
  et se pose par écriture-puis-renommage. Deux douzaines d’écrivains
  concurrents obtiennent des identifiants consécutifs et ne perdent rien —
  il y a un test pour ça.
- **Une seule sorte de chose.** Tâches et décisions sont le même nœud.
  Moins de concepts, un seul espace d’identifiants, un seul arbre.
- **L’humain n’a jamais à demander.** Statut, progression, péremption, qui
  attend quoi — tout est sur le tableau, pas dans un fil de chat.
- **Les rôles sont explicites.** Chaque section ajoutée dit si c’est un
  humain ou un agent qui l’a écrite, qui, et quand. Seules les réponses
  humaines approuvent le contenu sortant.
- **Des références, pas du contenu, depuis l’extérieur.** Les sources
  externes synchronisent des identifiants et des titres ; le corps et les
  identifiants de connexion restent là où ils vivent.

## FAQ

**Est-ce seulement pour Claude Code ?**
Non. La CLI est agnostique côté agent — tout ce qui a un terminal peut
l’appeler. Le plugin Claude Code ajoute des règles de début de session et
utilise `CLAUDECODE` / `CLAUDE_SESSION_ID` pour distinguer les terminaux
d’agent des vôtres, et marquer qui a écrit quoi. Ailleurs, réglez
`NODDIT_ROLE=agent` et `NODDIT_SESSION` (`DECS_ROLE` / `DECS_SESSION`
marchent toujours).

**Ça marche avec les git worktrees ?**
Oui. `nod` résout toujours vers le `decisions/` du clone principal, donc
les voies dans des worktrees partagent un seul dépôt de données.

**Plusieurs dépôts à la fois ?**
`nod init` enregistre chaque projet ; `nod bench` sans argument ouvre
tous les projets, groupés par lettre de projet.

**Et si personne ne répond ?**
Chaque question porte une valeur par défaut et un `--if-no-answer`.
`nod wait --timeout` sort avec le code 2 et affiche la valeur par défaut
— le moment d’avancer avec elle.

**Puis-je modifier les fichiers à la main ?**
Vous pouvez les lire librement. Pour écrire, utilisez la CLI : elle garde
les identifiants, les verrous, la file des réponses et l’historique des
pièces jointes cohérents.

**J’ai un vieux `DECISIONS.md`.**
`nod migrate --dir <project> --dry-run`, puis sans `--dry-run`.

## Développement

```sh
npm test            # node --test
npm run typecheck   # tsc --noEmit
node scripts/render-screenshot.ts --out docs/screenshot.fr   # regenerate docs/screenshot.<lng>.svg/.png (mock data)
```

## Licence

[MIT](LICENSE) © 2026 WeCarbon
