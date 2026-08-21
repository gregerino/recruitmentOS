// ══════════════════════════════════════════════════════════════
//  Compare — side-by-side view of saved candidate interviews
//
//  Structured interviews exist to make candidates comparable; this
//  is where that pays off. Rows are competencies, columns are
//  candidates, and the footer carries the weighted score and hire
//  level straight from Analyzer.computeRecommendation().
// ══════════════════════════════════════════════════════════════
const Compare = (() => {
  let onOpenSession = null;
  let selected = new Set();
  let roleFilter = '';

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str === undefined || str === null ? '' : String(str);
    return div.innerHTML;
  }

  function init(options) {
    onOpenSession = (options || {}).onOpenSession || null;
    const root = document.getElementById('compare');
    if (!root) return;

    root.addEventListener('change', (e) => {
      if (e.target.matches('[data-cmp-session]')) {
        const id = e.target.dataset.cmpSession;
        if (e.target.checked) selected.add(id); else selected.delete(id);
        renderMatrix();
      }
      if (e.target.matches('#cmp-role-filter')) {
        roleFilter = e.target.value;
        syncSelectionToFilter();
        render();
      }
    });

    root.addEventListener('click', (e) => {
      const openBtn = e.target.closest('[data-cmp-open]');
      if (openBtn) {
        const id = openBtn.dataset.cmpOpen;
        if (onOpenSession) onOpenSession(id);
        return;
      }
      const delBtn = e.target.closest('[data-cmp-delete]');
      if (delBtn) {
        const id = delBtn.dataset.cmpDelete;
        if (confirm(T.get('compareDeleteConfirm'))) {
          Store.remove(id);
          selected.delete(id);
          render();
        }
        return;
      }
      if (e.target.closest('#cmp-export')) exportCsv();
    });
  }

  function roleKey(session) {
    return (session.role || '').trim().toLowerCase();
  }

  function visibleSessions() {
    const all = Store.list();
    return roleFilter ? all.filter(s => roleKey(s) === roleFilter) : all;
  }

  function syncSelectionToFilter() {
    const visible = new Set(visibleSessions().map(s => s.id));
    selected = new Set([...selected].filter(id => visible.has(id)));
  }

  // Open the view, preselecting everything interviewed for `preferRole`.
  function open(preferRole) {
    const all = Store.list();
    const key = (preferRole || '').trim().toLowerCase();
    if (key && all.some(s => roleKey(s) === key)) {
      roleFilter = key;
    }
    syncSelectionToFilter();
    if (!selected.size) {
      visibleSessions().slice(0, 4).forEach(s => selected.add(s.id));
    }
    render();
  }

  function candidateName(session) {
    return (session.candidate || '').trim() || T.get('unnamedCandidate');
  }

  // ─── Rendering ───

  function render() {
    renderPicker();
    renderMatrix();
  }

  function renderPicker() {
    const el = document.getElementById('cmp-picker');
    if (!el) return;

    const all = Store.list();
    if (!all.length) {
      el.innerHTML = `<p class="cmp-empty">${T.get('compareEmpty')}</p>`;
      return;
    }

    const roles = [...new Map(all.map(s => [roleKey(s), s.role])).entries()]
      .filter(([key]) => key);

    const sessions = visibleSessions();

    el.innerHTML = `
      <div class="cmp-picker-bar">
        <label class="cmp-role-label">
          ${T.get('compareRole')}
          <select id="cmp-role-filter" class="cmp-select">
            <option value="">${T.get('compareAllRoles')}</option>
            ${roles.map(([key, label]) => `
              <option value="${esc(key)}"${key === roleFilter ? ' selected' : ''}>${esc(label)}</option>
            `).join('')}
          </select>
        </label>
        <span class="cmp-hint">${T.get('compareSelectHint')}</span>
      </div>
      <div class="cmp-chips">
        ${sessions.map(s => {
          const rec = Analyzer.computeRecommendation(s.scorecard, s.scores);
          return `
          <div class="cmp-chip${selected.has(s.id) ? ' cmp-chip-on' : ''}">
            <label class="cmp-chip-main">
              <input type="checkbox" data-cmp-session="${esc(s.id)}"${selected.has(s.id) ? ' checked' : ''}>
              <span class="cmp-chip-name">${esc(candidateName(s))}</span>
              <span class="cmp-chip-meta">${esc(s.role || '—')} · ${esc(T.relativeTime(s.updatedAt))}</span>
            </label>
            <div class="cmp-chip-actions">
              ${rec.scored ? `<span class="cmp-chip-score">${rec.avg.toFixed(1)}</span>` : ''}
              <button class="btn-ghost btn-sm" data-cmp-open="${esc(s.id)}">${T.get('compareOpen')}</button>
              <button class="btn-ghost btn-sm cmp-danger" data-cmp-delete="${esc(s.id)}" title="${T.get('compareDelete')}">✕</button>
            </div>
          </div>`;
        }).join('')}
      </div>`;
  }

  function selectedSessions() {
    const byId = new Map(Store.list().map(s => [s.id, s]));
    return [...selected].map(id => byId.get(id)).filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // Union of competencies across the selected sessions, keeping the
  // order of the first session that defines each one.
  function unionCompetencies(sessions) {
    const seen = new Map();
    sessions.forEach(s => {
      (s.scorecard || []).forEach(c => {
        if (!seen.has(c.id)) seen.set(c.id, { id: c.id, name: c.name, weight: c.weight, category: c.category });
      });
    });
    return [...seen.values()];
  }

  function renderMatrix() {
    const el = document.getElementById('cmp-body');
    if (!el) return;

    const sessions = selectedSessions();
    if (!sessions.length) {
      el.innerHTML = `<p class="cmp-empty">${T.get('compareNeedOne')}</p>`;
      return;
    }

    const comps = unionCompetencies(sessions);
    const recs = new Map(sessions.map(s => [s.id, Analyzer.computeRecommendation(s.scorecard, s.scores)]));
    const levels = T.get('autoRecLevels');
    const mixedRoles = new Set(sessions.map(roleKey)).size > 1;

    const rows = comps.map(comp => {
      const values = sessions.map(s => (s.scores || {})[comp.id]);
      const best = Math.max(...values.filter(v => v !== undefined), -1);
      return `
        <tr>
          <th scope="row" class="cmp-comp">
            <span class="cmp-comp-name">${esc(comp.name)}</span>
            <span class="weight-badge weight-${esc(comp.weight)}">${esc(comp.weight)}</span>
          </th>
          ${sessions.map((s, i) => {
            const v = values[i];
            const inScope = (s.scorecard || []).some(c => c.id === comp.id);
            if (v === undefined) {
              return `<td class="cmp-cell cmp-cell-empty" title="${inScope ? T.get('compareNotRated') : '—'}">–</td>`;
            }
            const isBest = v === best && values.filter(x => x !== undefined).length > 1;
            return `<td class="cmp-cell${isBest ? ' cmp-best' : ''}" title="${isBest ? T.get('compareBest') : ''}">
              <span class="cmp-score cmp-score-${v}">${v}</span>
            </td>`;
          }).join('')}
        </tr>`;
    }).join('');

    el.innerHTML = `
      ${mixedRoles ? `<div class="cmp-warning">${T.get('compareMixedRoles')}</div>` : ''}
      <div class="cmp-table-wrap">
        <table class="cmp-table">
          <thead>
            <tr>
              <th class="cmp-corner">${T.get('compareCompetency')}</th>
              ${sessions.map(s => `
                <th class="cmp-head">
                  <span class="cmp-head-name">${esc(candidateName(s))}</span>
                  <span class="cmp-head-role">${esc(s.role || '—')}</span>
                </th>`).join('')}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <th scope="row">${T.get('compareWeighted')}</th>
              ${sessions.map(s => {
                const r = recs.get(s.id);
                return `<td class="cmp-cell cmp-total">${r.scored ? r.avg.toFixed(1) : '–'}</td>`;
              }).join('')}
            </tr>
            <tr>
              <th scope="row">${T.get('compareRecommendation')}</th>
              ${sessions.map(s => {
                const r = recs.get(s.id);
                return `<td class="cmp-cell">${r.levelKey
                  ? `<span class="auto-rec-level ${r.levelClass}">${esc(levels[r.levelKey])}</span>`
                  : '–'}</td>`;
              }).join('')}
            </tr>
            <tr>
              <th scope="row">${T.get('compareScored')}</th>
              ${sessions.map(s => {
                const r = recs.get(s.id);
                return `<td class="cmp-cell cmp-muted">${r.scored} / ${r.total}</td>`;
              }).join('')}
            </tr>
          </tfoot>
        </table>
      </div>

      <div class="cmp-evidence">
        <h3>${T.get('compareEvidenceTitle')}</h3>
        <div class="cmp-evidence-grid">
          ${sessions.map(s => renderEvidenceColumn(s, comps)).join('')}
        </div>
      </div>`;
  }

  function renderEvidenceColumn(session, comps) {
    const evidence = session.evidence || {};
    const blocks = comps
      .map(comp => {
        const quotes = evidence[comp.id] || [];
        if (!quotes.length) return '';
        return `
          <div class="cmp-ev-block">
            <div class="cmp-ev-comp">${esc(comp.name)}</div>
            ${quotes.map(q => `<blockquote class="cmp-ev-quote">${esc(q.text)}</blockquote>`).join('')}
          </div>`;
      })
      .filter(Boolean)
      .join('');

    return `
      <div class="cmp-ev-col">
        <div class="cmp-ev-head">${esc(candidateName(session))}</div>
        ${blocks || `<p class="cmp-muted">${T.get('compareNoEvidence')}</p>`}
      </div>`;
  }

  // ─── CSV export ───

  function csvCell(value) {
    return '"' + String(value === undefined || value === null ? '' : value).replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    const sessions = selectedSessions();
    if (!sessions.length) return;

    const comps = unionCompetencies(sessions);
    const levels = T.get('autoRecLevels');
    const lines = [];

    lines.push([T.get('compareCompetency'), T.get('compareWeightCol'), ...sessions.map(candidateName)].map(csvCell).join(','));
    comps.forEach(comp => {
      const cells = sessions.map(s => {
        const v = (s.scores || {})[comp.id];
        return v === undefined ? '' : v;
      });
      lines.push([comp.name, comp.weight, ...cells].map(csvCell).join(','));
    });

    const recs = sessions.map(s => Analyzer.computeRecommendation(s.scorecard, s.scores));
    lines.push([T.get('compareWeighted'), '', ...recs.map(r => r.scored ? r.avg.toFixed(1) : '')].map(csvCell).join(','));
    lines.push([T.get('compareRecommendation'), '', ...recs.map(r => r.levelKey ? levels[r.levelKey] : '')].map(csvCell).join(','));
    lines.push([T.get('compareScored'), '', ...recs.map(r => `${r.scored}/${r.total}`)].map(csvCell).join(','));

    // BOM so Excel reads the Swedish characters correctly
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `candidate-comparison-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { init, open, render };
})();
