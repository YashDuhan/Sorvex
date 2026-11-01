---
name: Sorvex Desktop
description: A quiet near-black workbench where the agent's output is the only bright thing on screen.
colors:
  canvas: "#000"
  chrome: "#0a0a0b"
  raised: "#111112"
  code-well: "#0c0c0d"
  hairline-subtle: "rgba(255, 255, 255, 0.06)"
  hairline: "rgba(255, 255, 255, 0.085)"
  hairline-overlay: "rgba(255, 255, 255, 0.1)"
  hairline-strong: "rgba(255, 255, 255, 0.16)"
  hairline-focus: "rgba(255, 255, 255, 0.24)"
  wash-hover: "rgba(255, 255, 255, 0.055)"
  wash-active: "rgba(255, 255, 255, 0.075)"
  wash-selected: "rgba(255, 255, 255, 0.09)"
  ink-heading: "#f5f5f6"
  ink-primary: "#e6e6e8"
  ink-secondary: "#bdbdc2"
  ink-tertiary: "#9a9aa0"
  ink-muted: "#85858b"
  ink-faint: "#7f7f85"
  signal-blue: "#4c8dff"
  signal-blue-border: "rgba(76, 141, 255, 0.4)"
  plan-violet: "#a78bfa"
  security-red: "#f87171"
  added-green: "#4ade80"
  warning-amber: "#fbbf24"
  light-canvas: "#fbfbfb"
  light-chrome: "#f3f3f4"
  light-raised: "#fff"
  light-ink-heading: "#111113"
  light-ink-primary: "#1f1f23"
  light-signal-blue: "#1f63e6"
typography:
  headline:
    fontFamily: "Onest Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 500
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Onest Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
  body:
    fontFamily: "Onest Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "\"ss01\", \"cv11\""
  body-sm:
    fontFamily: "Onest Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  label:
    fontFamily: "Onest Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  mono:
    fontFamily: "JetBrains Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
rounded:
  xs: "4px"
  sm: "6px"
  row: "7px"
  md: "8px"
  lg: "10px"
  card: "12px"
  composer: "14px"
  pill: "999px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  xxl: "14px"
  page: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ink-heading}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "30px"
    typography: "{typography.label}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "30px"
  button-ghost-hover:
    backgroundColor: "{colors.wash-hover}"
    textColor: "{colors.ink-primary}"
  icon-button:
    textColor: "{colors.ink-tertiary}"
    rounded: "{rounded.md}"
    size: "32px"
  send-button-ready:
    backgroundColor: "{colors.ink-heading}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    size: "32px"
  send-button-idle:
    backgroundColor: "{colors.wash-active}"
    textColor: "{colors.ink-faint}"
    rounded: "{rounded.md}"
    size: "32px"
  composer:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.composer}"
    padding: "10px"
  mode-tab-active:
    backgroundColor: "{colors.wash-active}"
    textColor: "{colors.ink-heading}"
    rounded: "{rounded.sm}"
    padding: "0 9px"
    height: "24px"
  mode-tab:
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.sm}"
    padding: "0 9px"
    height: "24px"
  input:
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  card:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.card}"
  popover:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.lg}"
    padding: "4px"
  list-row:
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.row}"
    padding: "6px 8px"
  list-row-hover:
    backgroundColor: "{colors.wash-hover}"
    textColor: "{colors.ink-primary}"
  rail-item-active:
    backgroundColor: "{colors.wash-selected}"
    textColor: "{colors.ink-heading}"
    rounded: "{rounded.md}"
    size: "36px"
  switch-on:
    backgroundColor: "{colors.signal-blue}"
    rounded: "{rounded.pill}"
    width: "34px"
    height: "20px"
---

# Design System: Sorvex Desktop

## Overview

**Creative North Star: "The Dark Workbench"**

Sorvex Desktop is a tool used for hours beside an editor and a terminal, so the system is built to recede. The canvas is true black, the chrome (icon rail and sessions sidebar) sits one step above it as a single dark band, and raised surfaces (composer, menus, dialogs, user turns, the changed-files card) sit one more step up. Separation comes from 1px white hairlines at 6-16% opacity, not from fills, glows or shadows. Text carries the hierarchy through a six-step grey ink ladder; the agent's reply, in near-white body type, is the brightest thing in view.

Density is high but legible: 12-13px controls, 14px body, rows of 26-36px, tight 4-12px gaps. One accent, the logo blue, marks focus, caret, text selection, switches, links and the active marker in a provider rail. Primary actions are not blue; they are solid near-white on black. Other hues appear only to carry state (plan violet, security red, added green, warning amber), and almost always as text or a hairline tint rather than a fill.

Motion is nearly absent. Hovers ease colour and background over 0.12-0.15s. The one ambient movement in the product is the working segment: while the agent runs, a short bright segment travels along the composer's top hairline. Reduced motion stops it. A light theme mirrors every token on a #fbfbfb canvas and must keep working.

**Key Characteristics:**
- True-black canvas, chrome one step up, raised surfaces one more step up.
- Hairlines, not fills, separate regions.
- Hierarchy through grey ink steps, not weight or colour.
- One blue accent for focus and selection; primary buttons are solid near-white.
- State hues as text or tinted hairlines only.
- One moving thing: the working segment on the composer edge.

## Colors

A neutral, almost colourless ladder of black surfaces and grey inks, with a single cool blue held back for focus and selection.

### Primary
- **Signal Blue** (`signal-blue`): focus rings (1.5px outline, 1px offset), text caret, `::selection` at 20% tint, switch on-state, links, focused search underline, the active-provider tick in the model picker rail, and input focus borders (`signal-blue-border`). In light theme it deepens to `light-signal-blue`. It never fills a button or a card.

### Secondary
- **Plan Violet** (`plan-violet`): plan-mode tab text and the composer hairline tint in plan mode.
- **Security Red** (`security-red`): security-mode tab text and composer tint, deletions in diffs and counts, recording state, errors, and the disconnected-rail wash (9% mixed into chrome).

### Tertiary
- **Added Green** (`added-green`): additions in diff counts, guardrails-on state, voice-chat hairline.
- **Warning Amber** (`warning-amber`): warnings (as text on an 8% tint of itself), starred models.

### Neutral
- **Canvas** (`canvas`): page and chat background, header.
- **Chrome** (`chrome`): icon rail and sessions sidebar, one continuous band.
- **Raised** (`raised`): composer, popovers, modals, toasts, user turns, the changed-files card.
- **Code Well** (`code-well`): code blocks and log output.
- **Hairlines** (`hairline-subtle` to `hairline-focus`): subtle for dividers and card edges, default for controls, overlay for floating surfaces, strong for empty checkbox rings, focus for the focused composer edge.
- **Washes** (`wash-hover`, `wash-active`, `wash-selected`): white overlays at 5.5%, 7.5% and 9% for hover, pressed/active tab, and selected rail item.
- **Ink ladder** (`ink-heading` to `ink-faint`): heading for titles and the reply-adjacent emphasis, primary for body text, secondary for controls and rows, tertiary for icons and supporting copy, muted for inactive tabs and metadata, faint for hints, counts and keyboard badges.
- **Light theme** (`light-canvas`, `light-chrome`, `light-raised`, `light-ink-heading`, `light-ink-primary`): the same roles inverted; hairlines and washes become black at 7-28%.

### Named Rules
**The One Accent Rule.** Blue means "this is where your input goes or what you picked": focus, caret, selection, on-switch, link. A blue button, blue card, or blue icon at rest is off-system.

**The Near-White Primary Rule.** The primary action (send when ready, setup confirm, dialog confirm) is solid `ink-heading` on `canvas` text, hover mixing 14% toward black. In light theme it inverts to near-black on white.

**The State-As-Text Rule.** Mode and status hues colour text, an icon, or a hairline (at ~40% mix). Fills, when used, stay at 8-15% tint behind text of the same hue.

## Typography

**Display Font:** none (no display face; the largest type is a 20px headline)
**Body Font:** Onest Variable (with ui-sans-serif, system-ui fallback), self-hosted
**Label/Mono Font:** JetBrains Mono Variable (with ui-monospace, SFMono-Regular, Menlo), self-hosted

**Character:** Onest is a calm, slightly geometric grotesque with stylistic sets ss01 and cv11 on throughout; JetBrains Mono marks anything that is literal machine truth: paths, code, token counts, diff counts, the status bar.

### Hierarchy
- **Headline** (500, 20px, -0.015em, balanced wrap): the empty-state question naming the folder. The only text above 16px in the shell.
- **Title** (600, 15px): dialog headings. Section headings in cards and setup panes run 14-16px at 500-600.
- **Body** (400, 14px, 1.55): replies, user turns, the composer textarea.
- **Body small** (400, 13-13.5px): rows, starters, settings copy, menu items, the header title (500, -0.005em).
- **Label** (500, 12px): mode tabs, guard badge, composer pills, row metadata. Secondary metadata runs 11.5px; keyboard badges and field labels 10.5px.
- **Mono** (400, 12px; 11.5px in the status bar and logs; 12.5px for file names): paths under the headline, changed-file names, +/- counts, code.

### Named Rules
**The Mono-Means-Literal Rule.** Mono is reserved for values the machine produced or will read: paths, code, counts, commands. UI copy is never set in mono.

**The Grey-Not-Bold Rule.** Hierarchy steps down the ink ladder before it steps up in weight. 600 is for dialog and card titles; everything else is 400-500. No uppercase, no tracking-out on labels.

**The Tabular Rule.** Durations, percentages, counts, context sizes and shortcuts use tabular numerals so they don't jitter as they change.

## Layout

A fixed-chrome desktop shell inside a frameless window (6px inset, 12px-radius root with a 1px hairline ring; square when maximized). Left to right: a 60px icon rail, a 290px sessions sidebar (both `chrome`, separated from the canvas by one subtle hairline), the main canvas with a 52px header, and an optional right icon strip and side panes (browser, files, changes, terminal, device).

Chat content and the composer share a centred 48rem column. The empty state is bottom-aligned, left-aligned, directly above the composer: headline, mono path, then four starter rows separated by hairlines (9px vertical padding, hint text pushed right). Below 680px of window height the starters tighten to 5px padding. The composer adapts by container query: under 640px it drops mode icons and guard words, never the controls themselves.

Spacing is a tight 2-4-6-8-10-12-14 rhythm for control internals and gaps, with 20-24px for page padding and 28px for setup panes. Pages such as Skills and Settings use a 20px/24px page inset; setup panes are a centred column of min(440px, 100%).

## Elevation & Depth

Depth is tonal and hairline-led: three surface steps (`canvas`, `chrome`, `raised`) plus white washes for interaction state. Shadows exist only on things that float over content, and they are dark, wide and low-contrast so they read as separation rather than lift.

### Shadow Vocabulary
- **Pop** (`box-shadow: 0 16px 40px -12px rgba(0, 0, 0, 0.9)`; light theme `rgba(0, 0, 0, 0.18)`): popovers, menus, modals, toasts.
- **Composer seat** (`box-shadow: 0 18px 40px -20px rgba(0, 0, 0, 0.9)`): the composer only, so it sits slightly above the scrolling thread.
- **Window ring** (`box-shadow: 0 0 0 1px <hairline>, 0 6px 16px -4px rgba(0, 0, 0, 0.6)`): the frameless window root.

### Named Rules
**The Hairline-First Rule.** If a surface needs separating, add a 1px hairline before reaching for a fill change or a shadow. Cards and rows at rest have no shadow.

**The One Mover Rule.** The working segment on the composer's top edge (35% wide gradient, 1.6s, `cubic-bezier(0.45, 0, 0.55, 1)`, infinite) is the only ambient animation. Progress bars and a pulsing record ring are functional exceptions; everything else is a 0.12-0.15s state transition.

## Shapes

Softly rounded rectangles, sized to their role: 14px for the composer, 12px for the window, cards and user turns, 10px for popovers, toasts and tables, 8px for buttons, inputs and icon buttons, 7px for list rows and rail items in the model picker, 6px for mode tabs and small icon buttons, 4px for keyboard badges and monograms. Full pills (999px) are kept for switches, progress tracks and the few legacy composer pills. Circles mark status: 5-8px dots, a hollow 6px ring for idle sessions that fills when running, a 16px ring that fills near-white when a setup step is done.

Borders are always 1px. Dashed borders appear only for drop targets and queued messages.

## Components

### Buttons
Restrained and flat; colour is not the signal, contrast is.
- **Shape:** 8px radius, 30px tall, 12px horizontal padding, 13px/500 label.
- **Primary:** solid `ink-heading` fill, `canvas` text; hover mixes 14% toward the background.
- **Ghost:** transparent with a `hairline` border and `ink-secondary` text; hover adds `wash-hover` and lifts text to `ink-primary`. A danger ghost swaps text to `security-red`.
- **Icon button:** 32px square (26px small, 6px radius), `ink-tertiary` icon, `wash-hover` on hover, `wash-active` when toggled on.
- **Send:** 32px square; idle is `wash-active` with a faint icon, ready is solid near-white. Stop uses `wash-selected`.
- **Focus:** global 1.5px `signal-blue` outline, 1px offset.

### Composer (signature)
The one raised object in the chat column.
- `raised` box, 14px radius, 10px padding, composer-seat shadow, hairline edge (a mix of the 13% hover and default hairlines); focus strengthens the hairline toward `hairline-focus`.
- Top row: mode tabs (Build / Plan / Security) as 24px text tabs; the active tab gets `wash-active` and its mode colour as text. Guardrails badge sits right.
- Bottom row: ghost controls (attach, effort, tools, voice) and the model select (160px, 32px, 8px radius, status dot + name), then send.
- Plan and security tint the hairline, never the fill. While running, the working segment travels the top edge.

### Model Picker (signature)
A two-pane popover: a 44px provider rail (32px items, 7px radius, active item `wash-active` plus a 2px blue tick on its right edge) and a list with a hairline-underlined search (underline turns blue on focus). Rows are 7px-radius, two lines (13px name, 11.5px faint metadata with tabular numerals), with a check for the current model, a keyboard badge, and a star that appears on hover and turns amber when set.

### Cards / Containers
- **Corner Style:** 12px (changed-files card, user turns), 10px (tables, popovers).
- **Background:** `raised` for anything sitting in the thread; `wash` at 2.5% (`bg-card`) for settings cards and tables on a page.
- **Shadow Strategy:** none at rest (see Elevation).
- **Border:** 1px `hairline-subtle`.
- **Internal Padding:** 8-16px; heads 8px with 14px left inset.
- **Changed files:** head row with title, mono +/- counts in green and red, a ghost "open" action; a hairline-separated tree of 30px rows with mono file names and a rotating chevron.

### Inputs / Fields
- **Style:** 1px `hairline` border, 2.5% wash fill, 8px radius, 8px 10px padding, 13.5px text, blue caret.
- **Focus:** border shifts to `signal-blue-border`; no glow.
- **Search in lists:** borderless with a bottom hairline that turns blue on focus.

### Lists and Rows
Hairline-separated, full-width rows with no card per item: starters, setup checklists, skills tables, session rows. Hover is a wash or an ink step up, never a border. Trailing metadata is right-aligned in `ink-faint` and brightens one step on hover.

### Navigation
- **Rail:** 60px `chrome` column, 36px items with 8px radius, `ink-muted` icons; hover `wash-active`, active `wash-selected` with `ink-heading`. A 5px dot marks rail-item status. A 28px hairline separates groups.
- **Sessions sidebar:** 290px `chrome`, folder groups with 13px/500 collapsible heads and rotating chevrons, session rows with a hollow status ring that fills when the agent is working; timestamps appear on hover.
- **Header:** 52px, `canvas`, centred 13px/500 title in `text-header-title`, icon buttons either side, custom window controls (close hovers to the platform red).

### Switches and Segmented Controls
Switch: 34x20 pill, `wash-selected` off, `signal-blue` on with a white knob sliding 14px. Segmented: 8px radius, 2px inset, `hairline-subtle` edge on a faint wash.

### Device Setup Checklist
A centred 440px column: 16px/500 heading, 13px tertiary lede, then a hairline-ruled checklist whose 16px rings fill near-white when done, mono paths, a 3px near-white progress track, and warnings/errors as coloured text on an 8% tint of the same hue with an 8px radius.

## Do's and Don'ts

### Do:
- **Do** separate regions with 1px hairlines (`hairline-subtle` for dividers, `hairline` for controls, `hairline-overlay` for floating surfaces).
- **Do** keep the canvas `#000`, chrome `#0a0a0b`, raised `#111112`; add depth by stepping surfaces, not by adding shadows.
- **Do** make the primary action solid near-white on black, and reserve blue for focus, caret, selection, switches and links.
- **Do** carry mode and status as coloured text or a ~40% hairline tint; when a fill is needed, an 8-15% tint behind same-hue text.
- **Do** set paths, code, counts and commands in JetBrains Mono, with tabular numerals for anything that changes.
- **Do** use hairline-separated rows for lists of choices (starters, checklists, skills) instead of a card per item.
- **Do** honour `prefers-reduced-motion` for the working segment and pulse.
- **Do** define every new colour in both `:root` and `:root.theme-light`.

### Don't:
- **Don't** add glowing or gradient borders; the only gradient on an edge is the working segment, and only while the agent runs.
- **Don't** fill buttons, cards or chips with the accent blue.
- **Don't** add a second ambient animation; state transitions stay at 0.12-0.15s.
- **Don't** use a logo hero or suggestion cards for empty states; the empty state is a question, a path and plain starter rows.
- **Don't** set UI copy in uppercase or with letter-spacing, and don't place small labels above headings.
- **Don't** use colours outside the token set; reference the custom properties.
