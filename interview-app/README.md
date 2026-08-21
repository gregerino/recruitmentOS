# RecruitmentOS — interview app

Static front end (vanilla JS, no build step) plus three serverless functions under `api/`.
Deployed on Vercel with this directory as the project root.

## Environment variables

| Variable | Used by | Required | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `api/generate.js` | for AI packages | Generates role-specific competencies and interview questions with Claude. Without it the app falls back to the built-in template library and says so in the UI. |
| `ASSEMBLYAI_API_KEY` | `api/transcribe-assembly.js` | for transcription | Speaker-diarized transcription of the interview. |
| `OPENAI_API_KEY` | `api/transcribe.js` | optional | Older Whisper transcription path, kept as a fallback. |
| `GENERATE_ACCESS_TOKEN` | `api/generate.js` | optional | When set, `/api/generate` requires a matching `x-ros-token` header. |
| `TRANSCRIBE_ACCESS_TOKEN` | both transcription endpoints | optional | Same, for `/api/transcribe` and `/api/transcribe-assembly`. |
| `API_ACCESS_TOKEN` | all endpoints | optional | Locks every endpoint at once; takes precedence over the two above. |

## Endpoints

- `POST /api/generate` — `{ jd, lang, stage, competencies? }`. Two stages:
  - `stage: "competencies"` (default) → `{ roleTitle, seniority, competencies }`.
    Pass `competencies` (`[{ id, name }]`) to re-generate the same role in another
    language while keeping the ids stable.
  - `stage: "questions"` → `{ questions }`, written against the `competencies` you pass in.

  Capped at 30 000 characters and 12 requests per minute per IP.
- `POST /api/transcribe-assembly` — multipart audio → diarized transcript.
- `POST /api/transcribe` — multipart audio → plain transcript (Whisper).

Both audio endpoints cap the upload at 10 MB and allow 6 requests per minute per IP.

## Request guards

`api/_guards.js` holds what every endpoint does before spending money: method check,
optional access token, per-IP rate limit, and a capped body read. The cap matters most —
without one a single large POST is read straight into the function's memory.

None of this is authentication. These are public endpoints on a public domain, so the
rate limit is a speed bump against a stray script, not a lock. Rate-limit state lives in
one serverless instance's memory, so it caps a single caller's burst rather than global
usage. Set an access token to actually close them.

Note that Vercel rejects request bodies over 4.5 MB before the handler sees them, so the
10 MB cap is a memory guard rather than the effective ceiling — roughly 25 minutes of
WebM/Opus audio gets through. A longer recording needs a different upload path
(browser straight to the provider), not a bigger cap here.

## How the package is built

`analyzer.js` always produces a complete rule-based package first. When `/api/generate`
succeeds, `Analyzer.applyAiPackage()` replaces the role competencies and their questions
with the generated ones and keeps the Big Five competencies, which are a fixed
psychometric frame rather than something to re-derive per role. Every failure path —
no API key, network error, refusal, or the user pressing "Continue without AI" — leaves
the rule-based package in place, and the badge above the content says which one is shown.

Generation latency is proportional to output volume (~56 tokens/second), which is why it
runs in two stages. Stage 1 returns the competencies and the app renders the whole kit
immediately; stage 2 fetches the questions in the background and repaints that section
when they arrive. If stage 2 fails, the generated competencies stay and the questions fall
back to the template library — the action button then retries stage 2 alone, without
regenerating the competencies or discarding any ratings.

Generated packages are cached per language in the saved session (`store.js`), so switching
language costs one extra generation the first time and nothing after that. A package cached
with no questions (saved while stage 2 was still running) re-runs stage 2 on restore.
