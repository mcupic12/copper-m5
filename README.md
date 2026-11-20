# Copper State Labs: CIS 591 course app

The starter app for CIS 591. Copper State Labs is a fictional Arizona company
(see the [Product Bible](docs/copper-state-labs/product-bible.md)); each module
adds a feature to this one app.

This is the Module 5 starting point: the Copper site with Ask Copper and the
Refund Console from Module 4, where Copper hands refunds to the Refund agent
and a person approves or rejects refunds over the auto-refund limit. In class
we make Ask Copper safe to ship. The
[`docs/`](docs/README.md) folder explains the company and how the app fits
together.

_Fictional — for educational use._

The app builds and runs with **no environment variables**. Pages that need a
model key show a "Set up …" card until you add one.

## Local setup

1. Install [Node 24](https://nodejs.org) (or run `nvm use`) and the [GitHub CLI](https://cli.github.com).
2. Clone your module branch, then run `npm run start-module` once to create your own public `copper-mN` repo.
3. Run `npm ci`.
4. Optional: copy the variables below into a new `.env.local` file.
5. Run `npm run dev` and open http://localhost:3000.

Or open the repo in **GitHub Codespaces**: it installs everything and starts the dev server for you.

## Environment variables

They're optional until a module needs them. Put them in `.env.local` (never commit it) and in your Vercel project settings.

| Variable                                     | Used for                                | Where to find it                                                                            |
| -------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GOOGLE_GENERATIVE_AI_API_KEY`               | All AI calls (`lib/ai/call.ts`)         | [Google AI Studio](https://aistudio.google.com) > Get API key (free, no card)               |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | Module 5: evals, tracing and monitoring | [Langfuse Cloud](https://cloud.langfuse.com) > new project > Create API keys (free)         |
| `LANGFUSE_BASE_URL`                          | Module 5: your Langfuse region          | The `LANGFUSE_BASE_URL` Langfuse shows next to your keys, e.g. `https://cloud.langfuse.com` |

## Commands

| Command                              | What it does                                          |
| ------------------------------------ | ----------------------------------------------------- |
| `npm run dev`                        | Start the dev server                                  |
| `npm test`                           | Run the app's tests                                   |
| `npm run lint` / `npm run typecheck` | Check code style and types                            |
| `npm run format`                     | Format the code with Prettier                         |
| `npm run start-module`               | One-time setup after cloning a module branch          |
| `npm run env:check`                  | List the variables in `.env.local`, values masked     |
| `npm run eval`                       | Grade Ask Copper on the golden set (Module 5)         |
| `npm run ci:secrets`                 | Copy the eval's keys into your repo's Actions secrets |
| `npm run langfuse:connect`           | Give Langfuse your Google key (its LLM connection)    |
| `npm run langfuse:judge`             | Set up Langfuse's LLM-as-a-Judge on the golden set    |
| `npm run embed-docs`                 | Re-embed the PDFs in `public/docs/` after they change |

## Pull requests and the golden-set eval (Module 5)

`main` is protected: every change goes in through a pull request, and it can
merge only when CI passes. CI (`.github/workflows/ci.yml`) runs lint,
typecheck, the tests and the build on Linux, macOS and Windows, then the
**golden-set eval**: Ask Copper answers every question in
`evals/golden-set.json`, an AI judge grades each answer, and at least 80% must
pass. Each run and its scores are kept in Langfuse (Datasets >
`copper-golden-set`).

Langfuse also grades every run with its own **LLM-as-a-Judge** (the
evaluator "Ask Copper correctness"). Set it up once: run
`npm run langfuse:connect` (gives Langfuse your Google key from `.env.local`,
the same as Settings > LLM Connections), then `npm run langfuse:judge`.

CI needs four keys as Actions secrets. Put them in `.env.local`, then run
`npm run ci:secrets` once (again whenever a key changes):
`GOOGLE_GENERATIVE_AI_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`
and `LANGFUSE_BASE_URL`.

## Tracing every AI call in Langfuse (Module 5)

With the Langfuse keys set, every Ask Copper turn shows up in Langfuse >
Tracing as one **Ask Copper** trace: each agent (Copper, the Refund agent),
each model call with its tokens, cost and time, and each tool call. For the
live site, add the three `LANGFUSE_*` variables to your Vercel project's
environment variables too. Without the keys nothing is traced and the app works
the same.

**Ask Copper says "Sorry, something went wrong" on your computer only?** If
your antivirus scans HTTPS (Avast and AVG do), Node doesn't trust its
certificate, so calls to Google and Langfuse fail. Start the app with Windows'
certificates instead: in PowerShell, `$env:NODE_USE_SYSTEM_CA=1; npm run dev`.

## AI coding agents

`CLAUDE.md` / `AGENTS.md` hold the rules for Claude Code and Codex. `.mcp.json`
gives Claude Code two MCP servers: shadcn and Next.js docs (`next-devtools`).

**Codex** doesn't read `.mcp.json`. Add the same servers to `~/.codex/config.toml`:

```toml
[mcp_servers.shadcn]
command = "npx"
args = ["shadcn@4.21.4", "mcp"]

[mcp_servers.next-devtools]
command = "npx"
args = ["-y", "next-devtools-mcp@0.4.0"]
```
