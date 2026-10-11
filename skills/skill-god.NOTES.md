# `skill-god.md` — record of a document that could NOT be vendored

> **This is not the original document.** It is a structural summary written from
> a condensed conversation log. The verbatim text does not exist anywhere on disk
> and is no longer recoverable from context. Do not treat anything below as a
> quotation, and do not feed this file to an agent expecting the original
> protocol — it is a description of it, not it.

## Why there is no copy

`skill-god.md` was supplied twice, both times as chat text:

1. As an attachment, declared under `/home/user/uploads/`. That directory did
   not exist, and a filesystem-wide `find -iname "*skill*god*"` located nothing.
   The attachment never landed.
2. Pasted inline into the conversation. That paste was the only real copy.

The conversation was later condensed. The condensation preserved a description of
the document's six sections but not its text, so there is nothing left to save.
Writing out a plausible-looking reconstruction and calling it `skill-god.md`
would be worse than recording the gap.

**To actually vendor it: paste the text again and it will be committed verbatim
as `skills/skill-god.md`.**

## What the document contained

A persona/orchestrator prompt in six sections:

1. **"Frontier Model Trigger Engine"** — techniques for packaging prompts so a
   model router allocates frontier models, while avoiding what it called
   "steerability penalties".
2. **A GitHub reference table** — `mattpocock/skills`, `czlonkowski/n8n-skills`,
   `czlonkowski/n8n-mcp` (all three verified real, HTTP 200 from the GitHub API),
   plus `planetscale.com/docs/llms.txt` and a GitHub *search* URL for frontend
   skills (neither is a repo).
3. **A local skills catalogue** rooted at
   `/Users/gaganrajput11/.gemini/config/skills/` — a macOS path. This sandbox is
   Linux, `HOME=/home/user`, and neither `~/.gemini` nor `/Users` exists. Those
   files were never reachable from here.
4. **A request-triage / skill-orchestration matrix** in Mermaid.
5. **A post-task "next steps" output template.**
6. **Strict stopping criteria** — halt and await approval rather than doing
   speculative work.

It named several skills that have **no upstream** and therefore could not be
vendored from anywhere: `design-system-enforcer`, `component-state-modeler`,
`mobile-a11y-target`, `visual-qa-runner`, `sonetel-dialer-orchestrator`. If those
exist, they exist only on that macOS machine.

## What was adopted, and what was not

Adopted as working method, and visible in this repo's history: triage before
acting; reproduce a bug red before fixing it; minimise the repro; write the
regression test at a real seam before the fix; mutation-test every new test;
five-state component coverage (idle / loading / empty / error / success); WCAG
2.2 AA and 44px coarse-pointer targets; a cleanup checklist before declaring
done; the next-steps output template; and stopping for approval instead of
churning speculatively.

**Section 1 was declined** and remains declined. Deliberately reframing a task to
influence which model a platform allocates is not something I will do, and the
mechanism it described is not verifiable from here. Nothing in this repository
depends on it.

The persona framing was also not adopted: there is no "Skill God" identity or
capability in this environment, and claiming one would have been fiction.
