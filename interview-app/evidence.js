// ══════════════════════════════════════════════════════════════
//  Evidence — links transcript utterances to competencies
//
//  The diarized transcript gives us speaker-labelled turns. This
//  module builds a keyword profile per competency (from its name,
//  description, observable behaviours and example evidence),
//  weights the terms by how discriminating they are (IDF across
//  the competency set), and scores each candidate utterance
//  against every profile. The result is a ranked shortlist of
//  quotes the interviewer can pin to a rating.
// ══════════════════════════════════════════════════════════════
const Evidence = (() => {

  const STOPWORDS = new Set([
    // Swedish
    'och','att','det','som','för','med','den','har','till','inte','kan','han','hon','var','sig','men','ett','om','vi','så','de','man','när','där','hur','vad','vem','ska','skulle','vara','blir','blev','från','eller','också','efter','över','under','mellan','genom','sina','sitt','sin','deras','vår','våra','mig','dig','oss','dem','denna','detta','dessa','här','därför','sedan','redan','bara','mycket','många','några','andra','alla','själv','samt','utan','vid','mot','hela','ganska','väldigt','lite','mer','mest','ju','väl','nog','alltså','liksom','typ','sådan','sådant','kanske','faktiskt','egentligen','precis','absolut','verkligen','ibland','alltid','aldrig','sedan','innan','medan','ännu','ändå','trots','därmed','vilket','vilken','vilka','jag','du','ni','min','mitt','dina','ditt',
    // English
    'the','and','that','have','for','not','with','you','this','but','his','from','they','she','will','one','all','would','there','their','what','out','about','who','get','which','when','make','can','like','time','just','him','know','take','into','year','your','some','could','them','see','other','than','then','now','look','only','come','its','over','think','also','back','after','use','two','how','our','work','first','well','way','even','new','want','because','any','these','give','day','most','was','were','are','been','has','had','did','does','doing','being','very','much','more','such','said','say','says','going','got','really','okay','yeah','actually','maybe','something','things','thing','lot','bit','kind','sort','sure','right','good','great','mean','means','need','needs','put','made','let','went','around','still','always','never','every','both','each','same','own','while','where','why','through',
  ]);

  // Filler turns carry no evidence value
  const MIN_WORDS = 10;
  const RELATIVE_CUTOFF = 0.45;
  // Thresholds are expressed as a fraction of the most discriminating
  // term in the index, so they hold whether there are 6 competencies
  // or 20 (which is what sets the IDF scale).
  const MIN_SCORE_RATIO = 0.45;
  const SINGLE_TERM_RATIO = 0.7;
  // A passage is only filed under the competencies it fits best. Without
  // this one good answer ends up quoted under every related competency,
  // because the generated profiles share a lot of vocabulary.
  const ASSIGN_RATIO = 0.75;
  // Several generated competencies share almost identical wording, so a
  // ratio alone cannot separate them — cap the spread outright.
  const MAX_COMPETENCIES_PER_PASSAGE = 2;

  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}+#]+/u)
      .filter(w => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  }

  // Crude prefix stemmer: works acceptably for both Swedish and
  // English inflection without a suffix rule table.
  function stem(word) {
    return word.length > 6 ? word.slice(0, 6) : word;
  }

  function stemSet(text) {
    const set = new Set();
    for (const w of tokenize(text)) set.add(stem(w));
    return set;
  }

  function flatten(value) {
    if (!value) return '';
    if (Array.isArray(value)) return value.join(' ');
    if (typeof value === 'object') return Object.values(value).join(' ');
    return String(value);
  }

  // ─── Transcript parsing ───

  // Turns "[Röst 1]: text" lines back into utterances, so evidence
  // also works on a transcript the user pasted or edited by hand.
  function parseTranscript(text) {
    const utterances = [];
    const lines = String(text || '').split('\n');
    let currentSpeaker = null;
    let buffer = [];

    const flushBuffer = () => {
      if (currentSpeaker && buffer.length) {
        const joined = buffer.join(' ').trim();
        if (joined) utterances.push({ speaker: currentSpeaker, text: joined });
      }
      buffer = [];
    };

    for (const line of lines) {
      const match = line.match(/^\s*[\[(]?\s*([^\]:()]{1,40}?)\s*[\])]?\s*:\s*(.*)$/);
      // Only treat it as a speaker line if the label looks like a name/voice tag,
      // not like a note prefix ("Styrka: ..." would otherwise match).
      if (match && /^(röst|voice|speaker|talare)\s*\d+$/i.test(match[1].trim())) {
        flushBuffer();
        currentSpeaker = match[1].trim();
        if (match[2].trim()) buffer.push(match[2].trim());
      } else if (currentSpeaker && line.trim()) {
        buffer.push(line.trim());
      }
    }
    flushBuffer();
    return utterances;
  }

  function speakerStats(utterances) {
    const stats = new Map();
    (utterances || []).forEach(u => {
      const entry = stats.get(u.speaker) || { speaker: u.speaker, words: 0, turns: 0 };
      entry.words += tokenize(u.text).length;
      entry.turns += 1;
      stats.set(u.speaker, entry);
    });
    const total = [...stats.values()].reduce((sum, s) => sum + s.words, 0) || 1;
    return [...stats.values()]
      .map(s => ({ ...s, share: s.words / total }))
      .sort((a, b) => b.words - a.words);
  }

  // In a well-run interview the candidate does most of the talking,
  // so "most words" is a reasonable default the user can override.
  function guessCandidate(utterances) {
    const stats = speakerStats(utterances);
    return stats.length ? stats[0].speaker : null;
  }

  // ─── Competency profiles ───

  /**
   * @param competencies  competency library entries
   * @param extra         optional { [compId]: 'domain vocabulary' } — the
   *                      template-generated profiles are thin, so callers
   *                      should seed them with role-specific terms (tech
   *                      stack, responsibilities) from the job description.
   */
  function buildIndex(competencies, extra) {
    const comps = (competencies || []).filter(c => c && c.id);
    const hints = extra || {};
    const profiles = comps.map(c => ({
      id: c.id,
      name: c.name,
      stems: stemSet([
        c.name,
        c.description,
        flatten(c.positiveBehaviors),
        flatten(c.exampleEvidence),
        flatten(c.riskIndicators),
        flatten(c.levels),
        flatten(hints[c.id]),
      ].join(' ')),
    }));

    // Document frequency across profiles — a term shared by most
    // competencies tells us nothing about which one a quote supports.
    const df = new Map();
    profiles.forEach(p => p.stems.forEach(s => df.set(s, (df.get(s) || 0) + 1)));

    const total = profiles.length || 1;
    const idf = new Map();
    df.forEach((count, s) => {
      idf.set(s, Math.max(0.05, Math.log(total / (1 + count))));
    });

    const maxIdf = Math.max(0.5, ...idf.values());

    return {
      profiles,
      idf,
      maxIdf,
      minScore: maxIdf * MIN_SCORE_RATIO,
      singleTermScore: maxIdf * SINGLE_TERM_RATIO,
    };
  }

  /**
   * Derives per-competency domain vocabulary from the analysed job
   * description. A responsibility line is attached to a competency only
   * when the two already share vocabulary, so we never dilute every
   * profile with the same words.
   */
  function buildHints(competencies, sources) {
    const src = sources || {};
    const responsibilities = src.responsibilities || [];

    // Questions that are explicitly tied to a competency are the strongest
    // hint we have: candidates answer in the vocabulary they were asked in.
    const byCompetency = new Map();
    (src.questions || []).forEach(q => {
      if (!q || !q.competencyId) return;
      const bucket = byCompetency.get(q.competencyId) || [];
      bucket.push([q.question, q.strong, (q.followups || []).join(' ')].join(' '));
      byCompetency.set(q.competencyId, bucket);
    });

    const hints = {};

    (competencies || []).forEach(c => {
      if (!c || !c.id) return;
      const base = stemSet([c.name, c.description, flatten(c.positiveBehaviors)].join(' '));
      const parts = byCompetency.get(c.id) ? [...byCompetency.get(c.id)] : [];

      responsibilities.forEach(line => {
        let overlap = 0;
        stemSet(line).forEach(st => { if (base.has(st)) overlap++; });
        if (overlap >= 2) parts.push(line);
      });

      hints[c.id] = parts.join(' ');
    });

    return hints;
  }

  // ─── Matching ───

  // How much this quote actually supports the competency, in absolute
  // terms — as opposed to `relevance`, which only ranks it against the
  // other quotes for the same competency.
  function strengthOf(raw, maxIdf) {
    const ratio = raw / (maxIdf || 1);
    if (ratio >= 2) return 'strong';
    if (ratio >= 1.2) return 'medium';
    return 'weak';
  }

  function scoreUtterance(uStems, profile, idf) {
    let raw = 0;
    const terms = [];
    uStems.forEach(s => {
      if (profile.stems.has(s)) {
        raw += idf.get(s) || 0;
        terms.push(s);
      }
    });
    // Damp long turns so volume alone does not win
    const score = raw / Math.log2(8 + uStems.size);
    return { raw, score, terms };
  }

  /**
   * @returns { [compId]: [{ text, speaker, index, score, relevance, terms }] }
   */
  function findEvidence(utterances, index, options) {
    const opts = options || {};
    const perComp = opts.perComp || 3;
    const speaker = opts.candidateSpeaker;
    const results = {};
    if (!index || !index.profiles.length) return results;

    const candidateTurns = (utterances || [])
      .map((u, i) => ({ ...u, index: i }))
      .filter(u => (!speaker || u.speaker === speaker) && tokenize(u.text).length >= MIN_WORDS)
      .map(u => ({ ...u, stems: stemSet(u.text) }));

    // Score every (passage, competency) pair that clears the bar
    const byCompetency = new Map();

    candidateTurns.forEach(u => {
      const hits = [];
      index.profiles.forEach(profile => {
        const { raw, score, terms } = scoreUtterance(u.stems, profile, index.idf);
        if (raw < index.minScore) return;
        if (terms.length < 2 && raw < index.singleTermScore) return;
        hits.push({ profileId: profile.id, raw, score, terms });
      });

      if (!hits.length) return;

      // Keep the passage only where it fits best
      const best = Math.max(...hits.map(h => h.score));
      hits
        .filter(h => h.score >= best * ASSIGN_RATIO)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_COMPETENCIES_PER_PASSAGE)
        .forEach(h => {
          const list = byCompetency.get(h.profileId) || [];
          list.push({
            text: u.text,
            speaker: u.speaker,
            index: u.index,
            raw: h.raw,
            score: h.score,
            terms: h.terms,
          });
          byCompetency.set(h.profileId, list);
        });
    });

    // Then rank the passages within each competency
    byCompetency.forEach((list, compId) => {
      list.sort((a, b) => b.score - a.score);
      const top = list[0].score;
      results[compId] = list
        .filter(r => r.score >= top * RELATIVE_CUTOFF)
        .slice(0, perComp)
        .map(r => ({
          text: r.text,
          speaker: r.speaker,
          index: r.index,
          score: r.score,
          relevance: Math.round((r.score / top) * 100),
          strength: strengthOf(r.raw, index.maxIdf),
          terms: r.terms,
        }));
    });

    return results;
  }

  return { parseTranscript, speakerStats, guessCandidate, buildIndex, buildHints, findEvidence, tokenize };
})();
