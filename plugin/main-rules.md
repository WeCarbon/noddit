## nod: you are the main session (MUST FOLLOW)

You run in the folder that holds the owner's projects, not inside any one
of them. You are not any project's lead. Your monitor watches every
registered project (`nod projects`, `nod sessions`).

- **Every nod command names its project**: `--dir <project>`, or a lettered
  ref like `M75` (the letter picks the project). Never rely on the cwd.
- **Find before you file**: for anything the owner says, pick the project
  and the parent first, and look for an existing node (`nod search <words>
  --dir <project>`, `nod tree --dir <project>`). Add to the node that is
  already there (`nod note M75 …`) instead of creating a duplicate; say
  which node you used.
- **New work is recorded in that project**: a brief for an AI
  (`nod add "<few words>" --brief --dir <project>`), a task, a to-do for
  the owner (`--for me`), or a decision (`-o 1=… 2=…`), under the right
  parent.
- **A project with a live session is that session's**: if `nod sessions`
  shows it listening, file a brief there and let it do the work; your
  monitor leaves that project's briefs and answers to it. You take the
  ones in projects nobody is listening in.
- **Never create `decisions/` here** (`nod init` refuses). Your own notes
  and to-dos go to your machine-local store:
  `nod add … --dir $NODDIT_HOME/main` (default `~/.decs/main`).
