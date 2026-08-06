# Agent Handbook Design

## Goal

Make the root `AGENTS.md` the single operational handbook every agent reads before working in this repository. Agents should not need to rescan the full codebase to understand ownership, commands, constraints, or current work.

## Structure

The handbook will contain:

- mandatory startup and update rules;
- project scope and supported behavior;
- an architecture map from features to source files;
- discovery, stream, playback, history, Trakt, and build flows;
- IINA lifecycle and webview constraints;
- security and privacy requirements;
- build, test, package, and release commands;
- git author and worktree safety rules;
- current implementation state and known issues.

## Agent Workflow

Every agent must read `AGENTS.md` before inspecting or changing code. It should then open only the files relevant to the requested feature according to the architecture map. A whole-repository scan is reserved for repository-wide audits or when the map is demonstrably stale.

Agents update `AGENTS.md` when a change affects architecture, behavior, commands, constraints, ownership, or known issues. Small internal edits that do not change those facts do not require an update.

## Maintenance

`AGENTS.md` describes the current repository rather than duplicating git history. Current work is recorded only when another agent must know about it to continue safely. Obsolete state and resolved issues are removed instead of accumulated indefinitely.
