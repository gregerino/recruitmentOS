// ══════════════════════════════════════════════════════════════
//  /api/generate — turns a job description into a role-specific
//  competency framework and interview questions using Claude.
//
//  Generation runs in two stages. Latency is proportional to
//  output volume (~56 tokens/second), so one call for the whole
//  package meant three minutes of blank loading screen. Splitting
//  it lets the client render the competencies, scorecard and
//  weighting at roughly the halfway mark and slot the questions in
//  when they land.
//
//  The client always has the rule-based package from analyzer.js
//  to fall back on, so every failure path here is non-fatal: it
//  returns an error the UI reports while keeping the local result.
// ══════════════════════════════════════════════════════════════
const Anthropic = require('@anthropic-ai/sdk').default;
const { rejected, readJsonBody } = require('./_guards');

const MODEL = 'claude-opus-5';
const MAX_JD_CHARS = 30000;
const MIN_JD_CHARS = 50;
const MAX_BODY_BYTES = 200 * 1024;
const MAX_REQUESTS_PER_MINUTE = 12;

const CATEGORIES = ['technical', 'behavioral', 'leadership', 'communication', 'problemSolving'];
const WEIGHTS = ['critical', 'high', 'medium'];
const QUESTION_CATEGORIES = ['competency', 'situational', 'technical', 'culture'];

const COMPETENCIES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['roleTitle', 'seniority', 'competencies'],
  properties: {
    roleTitle: { type: 'string' },
    seniority: { type: 'string', enum: ['junior', 'mid', 'senior', 'lead', 'unspecified'] },
    competencies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'category', 'weight', 'description', 'strongLooks',
                   'positiveBehaviors', 'riskIndicators', 'exampleEvidence', 'levels'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          weight: { type: 'string', enum: WEIGHTS },
          description: { type: 'string' },
          strongLooks: { type: 'string' },
          positiveBehaviors: { type: 'array', items: { type: 'string' } },
          riskIndicators: { type: 'array', items: { type: 'string' } },
          exampleEvidence: { type: 'array', items: { type: 'string' } },
          levels: {
            type: 'object',
            additionalProperties: false,
            required: ['beginner', 'mid', 'senior'],
            properties: {
              beginner: { type: 'string' },
              mid: { type: 'string' },
              senior: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

const QUESTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['competencyId', 'category', 'question', 'why', 'strong', 'warning', 'followups'],
        properties: {
          competencyId: { type: 'string' },
          category: { type: 'string', enum: QUESTION_CATEGORIES },
          question: { type: 'string' },
          why: { type: 'string' },
          strong: { type: 'string' },
          warning: { type: 'string' },
          followups: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const SHARED_RULES = `You design structured, competency-based interviews for a hiring tool used by recruiters and hiring managers. Your output drives a real scorecard, so it must be specific enough to rate a candidate against.

FAIRNESS — this is a hiring instrument.
- Never reference or imply age, gender, ethnicity, religion, disability, pregnancy, family status, sexual orientation, or nationality.
- Nothing about personal life outside work.
- Cover only capabilities the job description supports.

IDS — id is a lowercase ASCII slug derived from the ENGLISH name of the competency (e.g. "incident-response", "stakeholder-alignment"), regardless of the output language. Keep them stable and unique.`;

const COMPETENCY_PROMPT = `${SHARED_RULES}

Produce 6 to 9 competencies for this role.
- Derive them from what this role actually does. "Kubernetes troubleshooting under production pressure" is useful; "Communication" on its own is not.
- Never invent requirements the job description does not support. If the description is thin, say less rather than padding it out.
- Weight by how much the role depends on it: at most 3 "critical".
- description: why this competency matters for this specific role.
- strongLooks: one or two sentences on what a strong candidate demonstrates here.
- positiveBehaviors, riskIndicators and exampleEvidence: 3-4 entries each, observable in an interview. Write what the candidate says or does, not personality traits.
- levels: describe beginner / mid / senior performance in THIS role, in concrete terms a rater can distinguish.`;

const QUESTION_PROMPT = `${SHARED_RULES}

The competency framework for this role has already been settled and is given to you. Write 10 to 14 interview questions against it.
- Each question maps to exactly one of the given competencies via competencyId. Use the ids exactly as given — do not invent new ones.
- Every competency gets at least one question; the ones weighted "critical" deserve two.
- Behavioural and past-experience based ("Tell me about a time..."), or a realistic situational scenario drawn from this role. No puzzles, no trivia, nothing answerable from a job ad.
- why: what the question actually reveals.
- strong: what a strong answer contains — specific, observable.
- warning: the concrete signals of a weak or evasive answer.
- followups: 2-3 probes that push for specifics.`;

module.exports = async function handler(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured', code: 'not_configured' });
  }

  if (rejected(req, res, {
    maxRequests: MAX_REQUESTS_PER_MINUTE,
    tokenEnv: 'GENERATE_ACCESS_TOKEN',
  })) return;

  let body;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (e) {
    const tooLarge = e.code === 'too_large';
    return res.status(tooLarge ? 413 : 400).json({ error: e.message, code: e.code || 'bad_request' });
  }

  const jd = typeof body.jd === 'string' ? body.jd.trim() : '';
  const lang = body.lang === 'sv' ? 'sv' : 'en';
  const stage = body.stage === 'questions' ? 'questions' : 'competencies';
  const competencies = Array.isArray(body.competencies) ? body.competencies.slice(0, 12) : [];

  if (jd.length < MIN_JD_CHARS) {
    return res.status(400).json({ error: 'Job description too short', code: 'bad_request' });
  }
  if (jd.length > MAX_JD_CHARS) {
    return res.status(413).json({ error: 'Job description too long', code: 'too_large' });
  }
  if (stage === 'questions' && !competencies.length) {
    return res.status(400).json({ error: 'Questions stage needs competencies', code: 'bad_request' });
  }

  try {
    const result = stage === 'questions'
      ? await generateQuestions({ apiKey, jd, lang, competencies })
      : await generateCompetencies({ apiKey, jd, lang, reuse: competencies });
    return res.status(200).json(result);
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    console.error(`generate(${stage}) failed:`, e && e.message);
    return res.status(status).json({
      error: e.message || 'Generation failed',
      code: e.code || 'generation_failed',
    });
  }
};

function languageInstruction(lang) {
  return lang === 'sv'
    ? 'Swedish (svenska). Use natural professional Swedish, not translated English.'
    : 'English.';
}

async function callClaude({ apiKey, system, prompt, schema }) {
  const client = new Anthropic({ apiKey });

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    system,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema },
    },
    // Rescue the request on the fallback model if a safety classifier declines
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: prompt }],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    const err = new Error('The model declined to process this job description');
    err.code = 'refused';
    err.status = 422;
    throw err;
  }
  if (message.stop_reason === 'max_tokens') {
    const err = new Error('Generation was cut off before it finished');
    err.code = 'truncated';
    throw err;
  }

  const text = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  try {
    return { parsed: JSON.parse(text), message };
  } catch (e) {
    const err = new Error('Model returned unparseable output');
    err.code = 'unparseable';
    throw err;
  }
}

async function generateCompetencies({ apiKey, jd, lang, reuse }) {
  const language = languageInstruction(lang);

  // Re-generating the same role in another language: keep the ids so the
  // client's ratings and pinned evidence still line up.
  const reuseBlock = reuse.length
    ? `\n\nThis role has already been analysed. Reuse these competencies and their ids exactly — same set, same order, same ids — and write the text in ${language} Do not add, drop, or rename anything:\n${
        reuse.map(c => `- ${c.id}: ${c.name}`).join('\n')}`
    : '';

  const { parsed, message } = await callClaude({
    apiKey,
    system: COMPETENCY_PROMPT,
    schema: COMPETENCIES_SCHEMA,
    prompt: `Write all human-readable text in ${language}\n\nJob description:\n\n<job_description>\n${jd}\n</job_description>${reuseBlock}`,
  });

  const competencies = normalizeCompetencies(parsed.competencies);
  if (!competencies.length) {
    const err = new Error('Model returned no usable competencies');
    err.code = 'empty';
    throw err;
  }

  return {
    stage: 'competencies',
    roleTitle: String(parsed.roleTitle || '').trim(),
    seniority: parsed.seniority || 'unspecified',
    competencies,
    meta: usage(message),
  };
}

async function generateQuestions({ apiKey, jd, lang, competencies }) {
  const language = languageInstruction(lang);

  const framework = competencies
    .map(c => `- ${c.id} (${c.weight || 'medium'}): ${c.name}\n  ${c.description || ''}`)
    .join('\n');

  const { parsed, message } = await callClaude({
    apiKey,
    system: QUESTION_PROMPT,
    schema: QUESTIONS_SCHEMA,
    prompt: `Write all human-readable text in ${language}\n\nJob description:\n\n<job_description>\n${jd}\n</job_description>\n\nCompetency framework:\n\n<competencies>\n${framework}\n</competencies>`,
  });

  const validIds = new Set(competencies.map(c => slugify(c.id)));
  const questions = normalizeQuestions(parsed.questions, validIds);
  if (!questions.length) {
    const err = new Error('Model returned no usable questions');
    err.code = 'empty';
    throw err;
  }

  return { stage: 'questions', questions, meta: usage(message) };
}

function usage(message) {
  return {
    model: message.model,
    inputTokens: message.usage && message.usage.input_tokens,
    outputTokens: message.usage && message.usage.output_tokens,
  };
}

// Trust nothing: the schema constrains shape, not sanity.
function normalizeCompetencies(list) {
  const seen = new Set();
  return (list || [])
    .map(c => {
      const id = slugify(c.id || c.name);
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        name: String(c.name || '').trim(),
        category: CATEGORIES.includes(c.category) ? c.category : 'behavioral',
        weight: WEIGHTS.includes(c.weight) ? c.weight : 'medium',
        description: String(c.description || '').trim(),
        strongLooks: String(c.strongLooks || '').trim(),
        positiveBehaviors: cleanList(c.positiveBehaviors),
        riskIndicators: cleanList(c.riskIndicators),
        exampleEvidence: cleanList(c.exampleEvidence),
        levels: {
          beginner: String((c.levels && c.levels.beginner) || '').trim(),
          mid: String((c.levels && c.levels.mid) || '').trim(),
          senior: String((c.levels && c.levels.senior) || '').trim(),
        },
      };
    })
    .filter(c => c && c.name)
    .slice(0, 12);
}

function normalizeQuestions(list, validIds) {
  return (list || [])
    .map(q => ({
      competencyId: slugify(q.competencyId),
      category: QUESTION_CATEGORIES.includes(q.category) ? q.category : 'competency',
      question: String(q.question || '').trim(),
      why: String(q.why || '').trim(),
      strong: String(q.strong || '').trim(),
      warning: String(q.warning || '').trim(),
      followups: cleanList(q.followups),
    }))
    // Drop questions pointing at a competency the framework does not have
    .filter(q => q.question && validIds.has(q.competencyId))
    .slice(0, 20);
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}


