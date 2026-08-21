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

## Endpoints

- `POST /api/generate` — `{ jd, lang, competencies? }` → competency framework + questions.
  Pass `competencies` (`[{ id, name }]`) to re-generate the same role in another language
  while keeping the ids stable. Capped at 30 000 characters and 8 requests per minute per IP.
- `POST /api/transcribe-assembly` — multipart audio → diarized transcript.
- `POST /api/transcribe` — multipart audio → plain transcript (Whisper).

## How the package is built

`analyzer.js` always produces a complete rule-based package first. When `/api/generate`
succeeds, `Analyzer.applyAiPackage()` replaces the role competencies and their questions
with the generated ones and keeps the Big Five competencies, which are a fixed
psychometric frame rather than something to re-derive per role. Every failure path —
no API key, network error, refusal, or the user pressing "Continue without AI" — leaves
the rule-based package in place, and the badge above the content says which one is shown.

Generated packages are cached per language in the saved session (`store.js`), so switching
language costs one extra generation the first time and nothing after that.
