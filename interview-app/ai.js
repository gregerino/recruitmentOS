// ══════════════════════════════════════════════════════════════
//  AI — client for /api/generate
//
//  Generation runs in two stages so the interviewer sees a usable
//  kit at roughly the halfway mark: competencies first, questions
//  after. Every call is optional — the caller always holds the
//  rule-based package from analyzer.js, so this never throws: it
//  resolves to { ok: false, code } and the app carries on.
// ══════════════════════════════════════════════════════════════
const AI = (() => {
  const ENDPOINT = '/api/generate';
  const TIMEOUT_MS = 240000;

  // Tracked separately: cancelling the competency stage (the user pressed
  // "continue without AI") must not kill a questions call, and vice versa.
  const inFlight = { competencies: null, questions: null };

  function isGenerating(stage) {
    if (stage) return !!inFlight[stage];
    return !!(inFlight.competencies || inFlight.questions);
  }

  function cancel(stage) {
    const stages = stage ? [stage] : Object.keys(inFlight);
    stages.forEach(key => {
      if (inFlight[key]) inFlight[key].abort();
    });
  }

  async function post(stage, body) {
    cancel(stage);
    const controller = new AbortController();
    inFlight[stage] = controller;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ ...body, stage }),
      });

      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        return { ok: false, code: payload.code || httpCode(res.status), error: payload.error || `HTTP ${res.status}` };
      }
      return { ok: true, data: payload };

    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, code: 'cancelled', error: 'Cancelled' };
      return { ok: false, code: 'network', error: e.message || 'Network error' };
    } finally {
      clearTimeout(timer);
      if (inFlight[stage] === controller) inFlight[stage] = null;
    }
  }

  /**
   * Stage 1 — the competency framework.
   * @param reuse  optional [{ id, name }] to reuse when re-generating the
   *               same role in another language, so ids stay stable
   */
  async function generateCompetencies(jd, lang, reuse) {
    const result = await post('competencies', {
      jd,
      lang,
      competencies: (reuse || []).map(c => ({ id: c.id, name: c.name })),
    });
    if (result.ok && !(result.data.competencies || []).length) {
      return { ok: false, code: 'empty', error: 'No competencies returned' };
    }
    return result;
  }

  /** Stage 2 — questions written against the settled framework. */
  async function generateQuestions(jd, lang, competencies) {
    const result = await post('questions', {
      jd,
      lang,
      competencies: (competencies || []).map(c => ({
        id: c.id, name: c.name, weight: c.weight, description: c.description,
      })),
    });
    if (result.ok && !(result.data.questions || []).length) {
      return { ok: false, code: 'empty', error: 'No questions returned' };
    }
    return result;
  }

  function httpCode(status) {
    if (status === 401) return 'unauthorized';
    if (status === 429) return 'rate_limited';
    if (status === 503) return 'not_configured';
    return 'generation_failed';
  }

  return { generateCompetencies, generateQuestions, cancel, isGenerating };
})();
