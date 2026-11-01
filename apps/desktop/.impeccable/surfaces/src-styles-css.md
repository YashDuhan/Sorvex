---
version: 1
slug: "src-styles-css"
primary_target: "src/styles.css"
related_targets: ["src/App.tsx","src/components/Composer.tsx","src/components/Thread.tsx"]
---

# Desktop app shell (all pages)

Mode: Operate. Audience: developers who use the sorvex CLI, in long agent sessions beside an editor and terminal.
Scope: full visual reset of the existing app (tokens, type, every component); layout, features and copy facts unchanged. Light theme retuned, dark is default.

## Direction contract

THESIS: The agent's output is the only bright thing on screen. Refuses the category default of glowing gradient borders, tinted pill chips, logo hero with suggestion cards, and accent-colored everything.
OWN-WORLD: True-black canvas (#000); chrome (rail, sessions sidebar) one step up (#0a0a0b); raised surfaces (composer, menus, user turns) #111112 with 1px white-8% hairlines. Onest for UI, JetBrains Mono for code and paths. One accent, the logo blue #4c8dff, only for focus, caret, selection and switches; primary buttons are solid near-white on black. Plan/security keep purple/red as text only.
STORY: A developer opens a session, sees the folder and four plain starters, types into the composer, and watches tool calls and replies with nothing competing for attention.
FIRST VIEWPORT: Rail (left, 60px) and sessions sidebar (290px) as one dark chrome band; centered 48rem chat column; empty state is a left-aligned question naming the folder, its mono path, and four hairline-separated starter rows sitting directly above the composer; composer is a #111 rounded box with mode tabs, guardrails, ghost controls, model picker and a solid send.
FORM: pinned by the user (t3code-inspired restrained near-black, not copied); signature move: while the agent works, a short segment travels along the composer's top hairline, the only motion on screen.
seed: none (direction pinned by the user; no roll)
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
