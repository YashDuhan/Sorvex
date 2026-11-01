# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who already use the `sorvex` CLI and want a desktop GUI for long coding sessions: chat with the agent, watch tool calls, review changes, and use the built-in browser, files, terminal and local-model panes. Security work (security mode) happens in the same app but is not the primary audience.

## Product Purpose

Sorvex Desktop drives the Sorvex coding and security agent over RPC mode. It adds what a terminal cannot show well: streaming chat with tool calls and subagents, side panes (browser the agent can drive, files, git changes, terminals), provider sign-in, local llama.cpp models, MCP servers, skills, SSH hosts, guardrails and remote access. Success means a developer can run long agent sessions in it all day without the UI getting in the way.

## Positioning

A GUI over the same agent, credentials, sessions, MCP config and skills the CLI uses (`~/.sorvex/agent`), so the CLI and desktop app are interchangeable views of one tool, with local models and guardrails built in.

## Operating Context

Tauri window (frameless, custom window controls) around a local Node server on 127.0.0.1; the UI is React with plain CSS (`src/styles.css`). Used for hours at a time beside an editor and terminal. Dark theme is the default; a light theme exists and must keep working.

## Capabilities and Constraints

- Pages: Chat, MCP, Skills, SSH, Providers, Local models, Logs, Settings, About.
- Chat modes: build, plan, security.
- Desktop-only; no marketing surface in this app.

## Brand Commitments

- Name: Sorvex. Logo at `public/logo.svg`.
- Visual direction the user set: restrained near-black dark theme in the spirit of t3code (github.com/pingdotgg/t3code), used as inspiration only, not copied.
- The current look reads as AI-generated and is an anti-reference.

## Product Principles

1. The agent's work is the content; chrome stays quiet.
2. Same truth as the CLI: show real state (models, tools, guardrails, paths), never decorative stand-ins.
3. Built for long sessions: low glare, dense but legible, predictable controls.
