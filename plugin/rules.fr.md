## nod : les tâches et décisions de ce projet vivent dans decisions/ (MUST FOLLOW)

(`decs` fonctionne toujours, comme alias de chaque commande ci-dessous.)

Le responsable ne demande pas en chat le statut, l'avancement ou la
suite — tout est dans `nod bench`. Hors nod, invisible. Détails :
`nod --help`, ou le skill decs.

- **Nœuds** : tâche et décision sont la même chose. `--task` pour ce que
  vous savez faire seul ; `-o` si le responsable doit répondre avant de
  continuer. Pas de `decisions/` ? `nod init`.
- **Seul nod écrit dans `decisions/`** : add / note / ask / attach /
  start / done / close / retitle / move … — jamais un éditeur, `sed`,
  une redirection, ni fichier déplacé, en-tête modifié ou `.ids/`
  supprimé à la main. Commande insuffisante ? Notez un nœud disant ce
  qui manque, sans contourner.
- **Ouvrez un nœud avant de commencer** : `nod add --task "<titre, ≤16
  car.>" --author "<agent> · <ce qu'il fait>"`, `nod start <id>`,
  `export NODDIT_NODE=<id>`. Le nœud d'une voie va sous celui de la session
  principale (`--parent`).
- **Les plans sont des nœuds enfants** : étapes pas encore faites →
  nœuds enfants (`--parent`), ordonnés par `--after`, estimés par
  `--est 30m`. Un imprévu devient un nœud enfant, pas une mention au
  chat.
- **La progression avance seule** : connectez les longues commandes à
  `nod progress` (`pytest … | nod progress --parse pytest`) ;
  plusieurs étapes → `nod steps` / `nod step`. Pas de mise à jour
  depuis la durée de relance (30 min par défaut, `nod config
  checkin-after`) = une ligne `NODDIT-CHECKIN` — voir plus bas. Toujours
  en cours mais rien de nouveau à dire ? `nod beat <id>` seul compte
  comme une réponse.
- **En attente côté extérieur** : `nod hold <id> --on "<qui/quoi>"`
  (statut « en attente », pas bloqué) ; `nod start <id>` une fois
  réglé.
- **Décision requise** : `nod ask <id> -o …` sur le nœud courant, ou un
  nœud enfant à options ; la réponse arrive via nod monitor (plus bas).
- **Qui termine un nœud le ferme, sans attendre personne** : dès que le travail
  est fusionné et que les vérifications (tests, verrou) passent, lancez `nod done
  <id> --note "<résultat, commit>"` tout de suite. Un relecteur qui trouve un
  problème le rouvre avec `nod start <id>` — relire n’est pas conclure. En
  déléguant, n’écrivez jamais à un sous-agent « ne le marque pas terminé,
  attends-moi ». Avant de fusionner, la session principale lance `nod tree
  <parent>` et vérifie chaque nœud enfant, y compris ceux créés par les
  sous-agents.
- **Pour conclure** : `nod done <id> --note "<résultat>"` ; sinon →
  `nod close <id> --reason obsolete|superseded|merged-into:<id>`.
  `nod read` récupère la réponse ; `done` seulement une fois la
  question réglée.
- **Contenu qui sort** : `nod attach <id> brouillon --approval-content
  --approve-on <option>` avant d'envoyer ; `nod approved <id> --check
  brouillon` doit réussir d'abord. Jamais `--human` pour approuver à sa
  place.
- **Une pièce jointe suit le message qui l'a jointe, pas tout à la fin** :
  `nod attach` sans `--to` tombe sur votre propre dernière note, sinon le
  corps ; `nod note <id> "…" --attach a.png` écrit une réponse et sa preuve
  ensemble. `--to body|last|<n>` choisit la section explicitement.
- **Sources externes** : la session principale enregistre un suivi de
  tickets, une boîte mail ou un formulaire avec `nod source register` ;
  le script ne synchronise qu'identifiants et titres. Nouveautés via
  nod monitor ; `nod source ack` une fois traitées.
- **Reporter** : le responsable peut reporter un nœud (`d` dans le tableau, ou
  `nod defer`) — il quitte disponible/actif/à décider sans changer
  d'état ; voir qu'il a été reporté par le responsable signifie s'arrêter
  jusqu'à sa reprise ; `--until fri` le fait revenir ce jour-là
  (`NODDIT-UNDEFERRED <id>` dans le monitor).
- **Tâches du responsable** (`assignee: human`, « À vous ») : ne jamais
  y travailler. En noter une pour lui : `nod add --for me "…"` ;
  `nod assign <id> me|ai` (ai seulement s'il l'a dit).
- **Relayez les réponses du chat** : avant de répondre, enregistrez ce
  que le responsable a dit d'un nœud (W305, X4, ou un repéré) :
  `nod note <id> --human --by "owner (dit dans le chat, relayé par
  <vous>)" "<ses mots>"` (captures via `nod attach`), puis
  `nod read <id>` ; notez ce que vous avez fait avec `--agent` une fois
  traité. Un nœud où il a répondu est à vous ; `nod ask <id>` pour le
  remettre devant lui.

## Être notifié : nod monitor (MUST FOLLOW)

- **La session principale n'arme rien** : le plugin démarre
  `nod monitor --here` à chaque session (projet courant, toute la
  session, n'expire jamais). Chaque ligne, une chose à traiter :
  réponse → `nod read`, puis répondez sur le nœud ce que vous allez
  faire (une courte note, ou en une étape `nod read <id> --ack "…"`) —
  une réponse que le responsable peut voir est elle-même un événement
  notifiant, c'est important ; `DECS-UNCLAIMED` → réponse non prise, à
  prendre ; élément externe → traitez, puis `nod source ack` ;
  `NODDIT-CHECKIN` → répondez tout de suite sur ce nœud avec
  `nod progress`, `nod note`, ou `nod beat <id>` si rien de nouveau à
  dire — après 3 relances sans réponse le tableau le signale (en général
  en écho d'une autre ligne, mais elle peut apparaître seule après un
  silence assez long) ; `NODDIT-STALE` → des nœuds ni à décider ni en
  cours dorment depuis trop longtemps — `nod start`, `nod defer`,
  `nod close`, ou replanifiez chacun ; `DECS-ERROR` → regardez, la
  surveillance continue.
- **`DECS-IDLE`** : après 2 heures de calme, la surveillance s'arrête seule.
  Besoin d'attendre une réponse ensuite ?
  `Monitor({ command: "nod monitor", description: "nod", timeout_ms:
  1800000 })`, réarmé à l'identique à l'expiration (il se souvient d'où
  il s'est arrêté).
- **Un `nod monitor` nu ne surveille que le projet sous son cwd** —
  comme `--here`, sauf qu'il ne quitte pas s'il n'y en a aucun.
  Surveiller tous les projets enregistrés demande `--all-projects`
  explicitement ; ne l'ajoutez pas par précaution, cela veut dire voir
  aussi les nœuds des autres projets.
- **Sous-agents et coéquipiers ne traitent que leurs propres nœuds, toujours
  avec `--mine`** : armez `Monitor({ command: "nod monitor --mine",
  description: "nod", timeout_ms: 1800000 })` au démarrage et réarmez-le à
  l’identique à l’expiration. Dans une session coéquipier, la surveillance lancée
  par le plugin reconnaît le coéquipier et ne signale que ses nœuds. Un nœud
  qui n’est pas le vôtre revient à la session principale : n’y touchez pas.
  `nod whoami` montre l'identité (`NODDIT_IDENTITY`, sinon votre nom
  d'auteur plus un identifiant de session) qu'une surveillance reconnaît,
  et qui est inscrite — invisiblement — sur tout ce que vous écrivez, si
  bien que relayer les propres mots du responsable ne vous revient jamais
  en écho.
- La session principale n'ajoute jamais `--mine` (le nœud d'un sous-agent
  est signé de son nom — l'ajouter fait manquer la notification).
- Pas de `nod wait` en arrière-plan, pas de script de sondage maison,
  pas de `nod watch` (pour les humains).

## Demandes du responsable : prendre → détailler → confirmer (MUST FOLLOW)

- Le responsable confie un travail en quelques mots — `nod add "…"` dans
  son propre terminal, `p` dans le tableau, la boîte « nouvelle tâche » de
  l’app. Ce nœud est une demande : ✎ dans le tableau, `intake: true`, ses
  mots tels quels sous `## 原话`. Le monitor de la session principale
  affiche `DECS-BRIEF <id> …` (une fois de plus si personne ne l’a prise
  après 5 minutes) ; un monitor `--mine` seulement pour les demandes
  déposées sous ses propres nœuds.
- **Prendre d’abord** : `nod claim <id>`. C’est atomique : s’il dit que
  quelqu’un d’autre l’a, laissez-la. Ne détaillez jamais une demande que
  vous n’avez pas prise.
- **Détailler** : `nod expand <id> [--title "…"] <<'EOF' … EOF` — quoi,
  pourquoi, terminé quand ; signalez les hypothèses comme telles. Les mots
  sous 原话 ne sont jamais modifiés.
- **Découper** : nœuds enfants `nod add --task "…" --parent <id> --after
  <id> --est 30m`.
- **Le responsable confirme avant tout travail** : `nod ask <id> -o
  1="démarrer comme prévu" 2="à modifier (précisez dans la réponse)"`,
  sans défaut. Réponse 1 → `nod read <id>` puis travail normal ; réponse
  2 → révisez (nouveau expand, enfants ajustés) et redemandez.
- Si le responsable vous demande dans le chat de traiter ainsi un nœud
  court qu’il a écrit : `nod claim <id>`, puis les mêmes étapes. Pour
  relayer un travail qu’il décrit dans le chat : `nod add --brief --author
  owner "<ses mots>"`.
- `nod briefs` liste ce qui attend ; `nod sessions` montre qui écoute.
  Ouvrir une nouvelle session (`nod session start`) revient au
  responsable : n’en lancez pas vous-même.
