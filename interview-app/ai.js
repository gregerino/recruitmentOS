// ══════════════════════════════════════════════════════════════
//  AI — client for /api/generate
//
//  Every call is optional. The caller always holds the rule-based
//  package from analyzer.js, so this never throws: it resolves to
//  { ok: false, code } and the app carries on without it.
// ══════════════════════════════════════════════════════════════
const AI = (() => {
  const ENDPOINT = '/api/generate';
  const TIMEOUT_MS = 240000;

  let inFlight = null;

  function isGenerating() {
    return !!inFlight;
  }

  // Abort a running generation — used by the "continue without AI" escape.
  function cancel() {
    if (inFlight) inFlight.abort();
  }

  /**
   * @param jd            the job description text
   * @param lang          'sv' | 'en'
   * @param competencies  optional [{ id, name }] to reuse when re-generating
   *                      the same role in another language, so ids stay stable
   * @returns { ok: true, data } | { ok: false, code, error }
   */
  async function generate(jd, lang, competencies) {
    cancel();
    const controller = new AbortController();
    inFlight = controller;

    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          jd,
          lang,
          competencies: (competencies || []).map(c => ({ id: c.id, name: c.name })),
        }),
      });

      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        return { ok: false, code: payload.code || httpCode(res.status), error: payload.error || `HTTP ${res.status}` };
      }
      if (!payload.competencies || !payload.competencies.length) {
        return { ok: false, code: 'empty', error: 'No competencies returned' };
      }
      return { ok: true, data: payload };

    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, code: 'cancelled', error: 'Cancelled' };
      return { ok: false, code: 'network', error: e.message || 'Network error' };
    } finally {
      clearTimeout(timer);
      if (inFlight === controller) inFlight = null;
    }
  }

  function httpCode(status) {
    if (status === 401) return 'unauthorized';
    if (status === 429) return 'rate_limited';
    if (status === 503) return 'not_configured';
    return 'generation_failed';
  }

  return { generate, cancel, isGenerating };
})();
