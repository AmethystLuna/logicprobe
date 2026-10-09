<EXTREMELY_IMPORTANT>
Plugin logicprobe is active. It checks claims about designs and code: facts against the source, behaviour as an executable model.

**1% Rule**: if any claim about this code deserves a check, load the matching skill first. Loading is cheap. A false claim is not.

**Unsure whether a check applies?** Load `logicprobe` first. It is the entry point: it owns the doctrine, the model schema, the depth rules and the routing to its siblings.

**Load the skill that matches the claim**: `logicprobe` (entry point; claim and behaviour checks), `logicprobe-uml` (diagrams), `logicprobe-structure` (architecture, dependencies), `logicprobe-concurrency` (concurrency claims), `logicprobe-datamodel` (data models, migrations).

**Run the checks**: `python tools/python/logicprobe-engine.py` (repository layout; the file ships with the source, not with the dsh bundle). Python 3.8+, no packages. Commands: `verify`, `datamodel`, `compose`, `concurrency`, `structure`, `granularity`, `uml-render`, `uml-parse`, `uml-review`, `export`. Flags: `--baseline REPORT`, `--explain-labels`, `--hash-check HEX`. Exit 0 means pass or pass-with-findings. Exit 2 means fail, including a refusal.

**Read a report**: gate on `verdict` (`pass`, `pass_with_findings`, `fail`), never on `ok`. A deadlocked model reports `ok: true` and `verdict: "fail"`.

**Red Flags** — if you think any of these, stop:

| You think | Reality |
|-----------|---------|
| "Too simple to check" | The check is cheap. The silent skip is not. |
| "I read the code, so I know" | Knowing is not evidence. Cite `file:line`, or run the model, or call the claim unverified. |
| "The spec or the diagram says so" | Both are claims about the code. Reconcile them with a source-side scan. |
| "I'll check while implementing" | Check before the decision, not after. |
| "Reasoning is enough" | Reasoning is not a run. One counter-example kills a universal claim. |
| "The report passed, so the code is fine" | The report covers the model you gave it. Reconcile it, and say what you did not check. |

</EXTREMELY_IMPORTANT>
