// ══════════════════════════════════════════════════════════════
//  /api/generate — turns a job description into a role-specific
//  competency framework and interview questions using Claude.
//
//  The client always has the rule-based package from analyzer.js
//  to fall back on, so every failure path here is non-fatal: it
//  returns an error the UI reports while keeping the local result.
// ══════════════════════════════════════════════════════════════
const Anthropic = require('@anthropic-ai/sdk').default;

const MODEL = 'claude-opus-5';
const MAX_JD_CHARS = 30000;
const MIN_JD_CHARS = 50;
const MAX_BODY_BYTES = 200 * 1024;

// Per-instance rate limit. Serverless instances are not shared, so this
// caps a single caller's burst rather than global usage — a speed bump,
// not authentication. Set GENERATE_ACCESS_TOKEN to actually lock it down.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 8;
const recentCalls = new Map();

const CATEGORIES = ['technical', 'behavioral', 'leadership', 'communication', 'problemSolving'];
const WEIGHTS = ['critical', 'high', 'medium'];
const QUESTION_CATEGORIES = ['competency', 'situational', 'technical', 'culture'];

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['roleTitle', 'seniority', 'competencies', 'questions'],
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

const SYSTEM_PROMPT = `You design structured, competency-based interviews for a hiring tool used by recruiters and hiring managers.

Your output drives a real scorecard, so it must be specific enough to rate a candidate against. Follow these rules:

COMPETENCIES — 6 to 9 of them.
- Derive them from what this role actually does. "Kubernetes troubleshooting under production pressure" is useful; "Communication" on its own is not.
- Never invent requirements the job description does not support. If the description is thin, say less rather than padding it out.
- Weight by how much the role depends on it: at most 3 "critical".
- description: why this competency matters for this specific role.
- strongLooks: one or two sentences on what a strong candidate demonstrates here.
- positiveBehaviors, riskIndicators and exampleEvidence: 3-4 entries each, observable in an interview. Write what the candidate says or does, not personality traits.
- levels: describe beginner / mid / senior performance in THIS role, in concrete terms a rater can distinguish.

QUESTIONS — 10 to 14 of them.
- Each question maps to exactly one competency via competencyId, and every competency gets at least one question.
- Behavioural and past-experience based ("Tell me about a time..."), or a realistic situational scenario drawn from this role. No puzzles, no trivia, nothing answerable from a job ad.
- why: what the question actually reveals.
- strong: what a strong answer contains — specific, observable.
- warning: the concrete signals of a weak or evasive answer.
- followups: 2-3 probes that push for specifics.

FAIRNESS — this is a hiring instrument.
- Never reference or imply age, gender, ethnicity, religion, disability, pregnancy, family status, sexual orientation, or nationality.
- No questions about personal life outside work.
- Ask only about capabilities the job description supports.

IDS — id is a lowercase ASCII slug derived from the ENGLISH name of the competency (e.g. "incident-response", "stakeholder-alignment"), regardless of the output language. Keep them stable and unique.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured', code: 'not_configured' });
  }

  const requiredToken = process.env.GENERATE_ACCESS_TOKEN;
  if (requiredToken && req.headers['x-ros-token'] !== requiredToken) {
    return res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
  }

  if (isRateLimited(req)) {
    return res.status(429).json({ error: 'Too many requests, try again in a minute', code: 'rate_limited' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return res.status(400).json({ error: e.message, code: 'bad_request' });
  }

  const jd = typeof body.jd === 'string' ? body.jd.trim() : '';
  const lang = body.lang === 'sv' ? 'sv' : 'en';
  const existing = Array.isArray(body.competencies) ? body.competencies.slice(0, 12) : [];

  if (jd.length < MIN_JD_CHARS) {
    return res.status(400).json({ error: 'Job description too short', code: 'bad_request' });
  }
  if (jd.length > MAX_JD_CHARS) {
    return res.status(413).json({ error: 'Job description too long', code: 'too_large' });
  }

  try {
    const result = await generatePackage({ apiKey, jd, lang, existing });
    return res.status(200).json(result);
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    console.error('generate failed:', e && e.message);
    return res.status(status).json({
      error: e.message || 'Generation failed',
      code: e.code || 'generation_failed',
    });
  }
};

async function generatePackage({ apiKey, jd, lang, existing }) {
  const client = new Anthropic({ apiKey });

  const language = lang === 'sv'
    ? 'Swedish (svenska). Use natural professional Swedish, not translated English.'
    : 'English.';

  const reuse = existing.length
    ? `\n\nThis role has already been analysed. Reuse these competencies and their ids exactly — same set, same order, same ids — and write the text in ${language} Do not add, drop, or rename anything:\n${
        existing.map(c => `- ${c.id}: ${c.name}`).join('\n')}`
    : '';

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
    },
    // Rescue the request on the fallback model if a safety classifier declines
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{
      role: 'user',
      content: `Write all human-readable text in ${language}\n\nJob description:\n\n<job_description>\n${jd}\n</job_description>${reuse}`,
    }],
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

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const err = new Error('Model returned unparseable output');
    err.code = 'unparseable';
    throw err;
  }

  return normalize(parsed, message);
}

// Trust nothing: the schema constrains shape, not sanity.
function normalize(parsed, message) {
  const seen = new Set();
  const competencies = (parsed.competencies || [])
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

  if (!competencies.length) {
    const err = new Error('Model returned no usable competencies');
    err.code = 'empty';
    throw err;
  }

  const validIds = new Set(competencies.map(c => c.id));
  const questions = (parsed.questions || [])
    .map(q => ({
      competencyId: slugify(q.competencyId),
      category: QUESTION_CATEGORIES.includes(q.category) ? q.category : 'competency',
      question: String(q.question || '').trim(),
      why: String(q.why || '').trim(),
      strong: String(q.strong || '').trim(),
      warning: String(q.warning || '').trim(),
      followups: cleanList(q.followups),
    }))
    // Drop questions pointing at a competency that did not survive
    .filter(q => q.question && validIds.has(q.competencyId))
    .slice(0, 20);

  if (!questions.length) {
    const err = new Error('Model returned no usable questions');
    err.code = 'empty';
    throw err;
  }

  return {
    roleTitle: String(parsed.roleTitle || '').trim(),
    seniority: parsed.seniority || 'unspecified',
    competencies,
    questions,
    meta: {
      model: message.model,
      inputTokens: message.usage && message.usage.input_tokens,
      outputTokens: message.usage && message.usage.output_tokens,
    },
  };
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

function isRateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const calls = (recentCalls.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);

  if (calls.length >= RATE_MAX_REQUESTS) {
    recentCalls.set(ip, calls);
    return true;
  }

  calls.push(now);
  recentCalls.set(ip, calls);

  // Keep the map from growing without bound on a long-lived instance
  if (recentCalls.size > 500) {
    for (const [key, times] of recentCalls) {
      if (!times.some(t => now - t < RATE_WINDOW_MS)) recentCalls.delete(key);
    }
  }
  return false;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}
