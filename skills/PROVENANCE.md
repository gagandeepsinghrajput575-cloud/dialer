# Vendored skill packs

Third-party agent skill packs, committed so they survive a sandbox reset and do
not have to be re-cloned. **Nothing in this directory is part of the Pulse Dialer
application** — the Vite build only follows imports from `index.html`, and no test
reads this tree.

## Sources

| Directory | Upstream | Commit | Commit date |
|---|---|---|---|
| `mattpocock/` | https://github.com/mattpocock/skills | `49dd158d1076134a641b33efb035946536778336` | 2026-10-09 |
| `n8n/` | https://github.com/czlonkowski/n8n-skills | `cb6caa7b3ae8d4206c768d7f69f598438ef25595` | 2026-10-09 |

Cloned with `--depth 1` on 2026-10-11.

## Licences

Both packs are **MIT**. The full texts are kept in place, as MIT requires:

- `mattpocock/LICENSE` — Copyright (c) 2026 Matt Pocock
- `n8n/LICENSE` — Copyright (c) 2025 Romuald Członkowski
- `n8n/NOTICES`, `n8n/NOTICES-APACHE-2.0.txt` — upstream third-party notices

These files must not be deleted if this directory is redistributed.

## What was removed from the upstream trees

- `.git/` from both — a nested git directory would either be swallowed as a
  broken submodule or silently excluded by the parent repo.
- `n8n/skills.png` — a 2 MB screenshot, 40% of the payload, with no offline use.
  Everything else is a faithful copy.

Total: 364 files, 2.9 MB.

## What is in here

**`mattpocock/skills/engineering/`** is the load-bearing set, and the skills this
repo's recent work actually followed:

`tdd` · `diagnosing-bugs` · `code-review` · `codebase-design` · `implement` ·
`implement-spec` · `to-spec` · `to-tickets` · `triage` · `pr` · `prototype` ·
`research` · `retro` · `domain-modeling` · `improve-codebase-architecture` ·
`grill-with-docs` · `wayfinder` · `wizard` · `ask-matt` ·
`setup-matt-pocock-skills`

Plus `productivity/`, `misc/`, `in-progress/` and `deprecated/` groups, and the
upstream `AGENTS.md`, `CLAUDE.md`, `GLOSSARY.md`, `SCOPE.md` and `docs/`.

**`n8n/skills/`** is 15 n8n workflow-automation skills (`n8n-workflow-patterns`,
`n8n-error-handling`, `n8n-validation-expert`, `n8n-code-javascript`, …) plus its
`docs/`, `evaluations/` and `hooks/`. **This pack is dormant** — Pulse Dialer has
no n8n surface. It is vendored because it was asked for, not because it is used.

## Refreshing

```bash
git clone --depth 1 https://github.com/mattpocock/skills   /tmp/mp
git clone --depth 1 https://github.com/czlonkowski/n8n-skills /tmp/n8n
rm -rf skills/mattpocock skills/n8n
mkdir -p skills/mattpocock skills/n8n
cp -a /tmp/mp/.  skills/mattpocock/
cp -a /tmp/n8n/. skills/n8n/
rm -rf skills/mattpocock/.git skills/n8n/.git skills/n8n/skills.png
```

Then update the commit SHAs in the table above.

## `skill-god.md`

See `skill-god.NOTES.md`. That document was **not** vendored, because the only
copy of it existed in a chat conversation that has since been condensed — there is
no file to copy and no verbatim text left to reproduce.
