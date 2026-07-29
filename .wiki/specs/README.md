# Specs

One file per spec: `<8id>_<slug>.md`. Written by the orchestrator **before** any
implementation work is spawned — a spec that exists only in conversation does not exist,
because sub-agents spawn in isolated context and inherit only artifacts.

Each entry carries: the objective (one checkable sentence), acceptance criteria, scope
boundaries, and a status line updated at merge.
