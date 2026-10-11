<EXTREMELY_IMPORTANT>
Plugin logicprobe is active. It checks claims about designs and code: facts against the source, behaviour as an executable model.

**Unsure whether a check applies?** Load `logicprobe` first. It is the entry point: it owns the doctrine, the model schema, the depth rules and the routing to its siblings.

**Load the skill that matches the claim**: `logicprobe` (entry point; claim and behaviour checks), `logicprobe-uml` (diagrams), `logicprobe-structure` (architecture, dependencies), `logicprobe-concurrency` (concurrency claims), `logicprobe-datamodel` (data models, migrations).

**Run the checks**: `python tools/python/logicprobe-engine.py --help` lists the subcommands and the flags this mirror carries. It covers the behaviour checks, composition, the UML front end, structure, granularity and the exporters, and `--baseline REPORT` diffs a report against an earlier one. The file ships with the repository, not with the dsh bundle, and needs the Python standard library only. Exit 0 means pass or pass-with-findings; exit 2 means fail, including a refusal. Two capabilities are dsh-only. Data-model verification uses `tools/python/data-model-harness.py` here, and the concurrency claim scan routes its claims in `logicprobe-concurrency`. The CLI prints the report JSON; a dsh host's tools print a report body instead.

**Read a report**: gate on `verdict` (`pass`, `pass_with_findings`, `fail`), never on `ok`. A deadlocked model reports `ok: true` and `verdict: "fail"`.

</EXTREMELY_IMPORTANT>
