(() => {
  const textarea = document.getElementById('jd-input');
  const analyzeBtn = document.getElementById('analyze-btn');
  const charCount = document.getElementById('char-count');
  const newBtn = document.getElementById('new-btn');
  const mainContent = document.getElementById('main-content');

  let lastAnalysisData = null;
  let lastText = '';
  let preSelectedB5 = new Set(); // Track B5 selections made before analysis

  // --- Character count & button state ---
  function updateCharCount() {
    const len = textarea.value.length;
    charCount.textContent = len;
    analyzeBtn.disabled = len < 50;
  }

  textarea.addEventListener('input', updateCharCount);

  // --- Input method tabs (paste vs file) ---
  const inputTabs = document.querySelectorAll('.input-tab');
  const pasteArea = document.getElementById('paste-input-area');
  const fileArea = document.getElementById('file-input-area');

  inputTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const method = tab.dataset.method;
      inputTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      pasteArea.style.display = method === 'paste' ? '' : 'none';
      fileArea.style.display = method === 'file' ? '' : 'none';
    });
  });

  // --- File Upload ---
  const fileUploadInput = document.getElementById('file-upload');
  const dropzone = document.getElementById('file-dropzone');
  const fileStatus = document.getElementById('file-status');
  const fileName = document.getElementById('file-name');
  const fileRemove = document.getElementById('file-remove');
  const fileError = document.getElementById('file-error');

  // Configure pdf.js worker
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  // Click to browse
  dropzone.addEventListener('click', () => fileUploadInput.click());

  // Drag & drop
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  // File input change
  fileUploadInput.addEventListener('change', () => {
    if (fileUploadInput.files.length > 0) {
      handleFile(fileUploadInput.files[0]);
    }
  });

  // Remove file
  fileRemove.addEventListener('click', () => {
    textarea.value = '';
    updateCharCount();
    fileUploadInput.value = '';
    fileStatus.style.display = 'none';
    fileError.style.display = 'none';
    dropzone.style.display = '';
  });

  async function handleFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();

    if (!['pdf', 'docx', 'doc'].includes(ext)) {
      showFileError(T.get('fileErrorFormat'));
      return;
    }

    // Show loading
    fileError.style.display = 'none';
    dropzone.innerHTML = `<div class="file-loading"><div class="spinner-small"></div><span>${T.get('fileReading')}</span></div>`;

    try {
      let text = '';
      if (ext === 'pdf') {
        text = await extractPdfText(file);
      } else {
        text = await extractDocxText(file);
      }

      // Restore dropzone content
      restoreDropzone();

      text = text.trim();
      if (!text || text.length < 10) {
        showFileError(T.get('fileErrorEmpty'));
        return;
      }

      // Put text into textarea and switch to paste view
      textarea.value = text;
      updateCharCount();

      // Show success status
      dropzone.style.display = 'none';
      fileStatus.style.display = 'flex';
      fileName.textContent = file.name;

      // Show success message with char count
      const msg = T.get('fileSuccess').replace('{chars}', text.length);
      fileError.style.display = 'block';
      fileError.className = 'file-success';
      fileError.textContent = msg;

    } catch (err) {
      restoreDropzone();
      console.error('File read error:', err);
      showFileError(T.get('fileErrorRead'));
    }
  }

  async function extractPdfText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      text += pageText + '\n\n';
    }
    return text;
  }

  async function extractDocxText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  }

  function showFileError(msg) {
    fileError.style.display = 'block';
    fileError.className = 'file-error';
    fileError.textContent = msg;
  }

  function restoreDropzone() {
    dropzone.innerHTML = `
      <div class="dropzone-content">
        <div class="dropzone-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </div>
        <p class="dropzone-text">${T.get('dropzoneText')}</p>
        <p class="dropzone-formats">${T.get('dropzoneFormats')}</p>
      </div>`;
  }

  // --- Analyze ---
  analyzeBtn.addEventListener('click', () => {
    const text = textarea.value.trim();
    if (text.length < 50) return;
    lastText = text;
    runAnalysis(text);
  });

  // --- New Analysis ---
  newBtn.addEventListener('click', () => {
    // The session stays in the archive — we just stop editing it
    Store.flush();
    Store.setCurrent(null);
    currentSession = null;
    lastAnalysisData = null;
    lastText = '';
    updateSavedCount();

    showPage('landing');
    showFloatingToggle(false);
    document.getElementById('floating-scorecard')?.classList.remove('open');
    document.getElementById('scorecard-panel-toggle')?.classList.remove('panel-open');
    textarea.value = '';
    charCount.textContent = '0';
    analyzeBtn.disabled = true;
    // Reset file upload state
    fileUploadInput.value = '';
    fileStatus.style.display = 'none';
    fileError.style.display = 'none';
    dropzone.style.display = '';
    restoreDropzone();
    // Reset to paste tab
    inputTabs.forEach(t => t.classList.toggle('active', t.dataset.method === 'paste'));
    pasteArea.style.display = '';
    fileArea.style.display = 'none';
    textarea.focus();
  });

  // --- Logo Home ---
  const logoHome = document.getElementById('logo-home');
  if (logoHome) {
    logoHome.addEventListener('click', (e) => {
      e.preventDefault();
      newBtn.click();
    });
  }

  // --- Language Toggle ---
  function setupLangToggles() {
    document.querySelectorAll('.lang-toggle').forEach(toggle => {
      toggle.querySelectorAll('.lang-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const lang = btn.dataset.lang;
          switchLanguage(lang);
        });
      });
    });
  }

  async function switchLanguage(lang) {
    T.setLang(lang);
    persist({ lang });

    // Sync all toggle buttons
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });

    // Update HTML lang attribute
    document.documentElement.lang = lang;

    // Update landing page static text
    updateLandingText();

    // Update sidebar nav labels
    updateSidebarNav();

    // Update sidebar phase labels
    updatePhaseLabels();

    // Re-render landing competency library with new language
    Analyzer.setLang(lang);
    renderLandingLibrary();

    // Rebuild the results in the new language. runAnalysis() already knows
    // how to reuse the generated package, carry the selection across the
    // id change, and restore scores, notes and evidence — so go through it
    // rather than keeping a second, near-identical path here.
    if (lastAnalysisData && lastText) {
      Store.flush();
      if (currentSession) {
        currentSession.lang = lang;
        await runAnalysis(lastText, currentSession);
      } else {
        await runAnalysis(lastText);
      }
    }
  }

  function updateLandingText() {
    // data-t attributes: set textContent
    document.querySelectorAll('[data-t]').forEach(el => {
      const key = el.getAttribute('data-t');
      const val = T.get(key);
      if (val && val !== key) {
        el.textContent = val;
      }
    });

    // data-t-html attributes: set innerHTML (for <br> tags etc)
    document.querySelectorAll('[data-t-html]').forEach(el => {
      const key = el.getAttribute('data-t-html');
      const val = T.get(key);
      if (val && val !== key) {
        el.innerHTML = val;
      }
    });

    // data-t-placeholder attributes
    document.querySelectorAll('[data-t-placeholder]').forEach(el => {
      const key = el.getAttribute('data-t-placeholder');
      const val = T.get(key);
      if (val && val !== key) {
        el.placeholder = val;
      }
    });
  }

  function updateSidebarNav() {
    const navLabels = T.get('nav');
    document.querySelectorAll('[data-t-nav]').forEach(el => {
      const key = el.getAttribute('data-t-nav');
      if (navLabels[key]) {
        el.textContent = navLabels[key];
      }
    });
  }

  function updatePhaseLabels() {
    document.querySelectorAll('.phase-label[data-t]').forEach(el => {
      const key = el.getAttribute('data-t');
      const val = T.get(key);
      if (val && val !== key) {
        el.textContent = val;
      }
    });
  }

  // --- Page Navigation ---
  function showPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(page).classList.add('active');
  }

  // --- Loading Animation ---
  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // --- Scroll Spy ---
  let scrollObserver = null;

  function setupScrollSpy() {
    // Disconnect previous observer if exists
    if (scrollObserver) {
      scrollObserver.disconnect();
    }

    const sections = document.querySelectorAll('.section');
    const navLinks = document.querySelectorAll('.nav-link');

    scrollObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          navLinks.forEach(l => l.classList.remove('active'));
          const link = document.querySelector(`.nav-link[data-section="${entry.target.id}"]`);
          if (link) link.classList.add('active');
        }
      }
    }, { rootMargin: '-80px 0px -60% 0px', threshold: 0 });

    sections.forEach(s => observer_observe(s));

    navLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetId = link.getAttribute('data-section');
        const target = document.getElementById(targetId);
        if (target) {
          target.scrollIntoView({ behavior: 'instant', block: 'start' });
        }
      });
    });

    function observer_observe(section) {
      scrollObserver.observe(section);
    }
  }

  // --- Landing Sidebar Previews ---
  function setupLandingPreviews() {
    const previewLinks = document.querySelectorAll('.nav-preview-link');
    const previewPanel = document.getElementById('section-preview-panel');
    const previewIcon = document.getElementById('preview-icon');
    const previewTitle = document.getElementById('preview-title');
    const previewDesc = document.getElementById('preview-desc');
    const previewCta = document.getElementById('preview-cta');

    previewLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const key = link.dataset.preview;
        const previews = T.get('sectionPreviews');
        const info = previews[key];
        if (!info) return;

        // Update active state
        previewLinks.forEach(l => l.classList.remove('active'));
        link.classList.add('active');

        // Show preview
        previewIcon.textContent = info.icon;
        previewTitle.textContent = info.title;
        previewDesc.textContent = info.desc;
        previewCta.textContent = T.get('previewCta');
        previewPanel.style.display = 'block';

        // Scroll preview into view
        previewPanel.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      });
    });
  }

  // --- Star Rating Interactivity ---
  let scorecardScores = {}; // { compId: score }

  // Sync all star-rating widgets for a given comp ID across both panels
  function syncStarRow(compId, val) {
    const labels = T.get('starLabels');
    document.querySelectorAll(`.star-rating[data-row="${compId}"]`).forEach(rating => {
      rating.querySelectorAll('.star').forEach(s => {
        s.classList.toggle('active', val !== undefined && parseInt(s.dataset.value) <= val);
      });
      const label = rating.querySelector('.star-label');
      if (label) label.textContent = val !== undefined ? labels[val - 1] : '';
    });
    // Update floating comp highlight
    document.querySelectorAll(`.floating-comp[data-comp-id="${compId}"]`).forEach(comp => {
      comp.classList.toggle('has-score', val !== undefined);
    });
  }

  function attachStarHandlers(container) {
    if (!container) return;

    container.addEventListener('mouseover', (e) => {
      const star = e.target.closest('.star');
      if (!star) return;
      const rating = star.closest('.star-rating');
      const val = parseInt(star.dataset.value);
      rating.querySelectorAll('.star').forEach(s => {
        s.classList.toggle('hover', parseInt(s.dataset.value) <= val);
      });
    });

    container.addEventListener('mouseout', (e) => {
      const star = e.target.closest('.star');
      if (!star) return;
      const rating = star.closest('.star-rating');
      rating.querySelectorAll('.star').forEach(s => s.classList.remove('hover'));
    });

    container.addEventListener('click', (e) => {
      const star = e.target.closest('.star');
      if (!star) return;
      const rating = star.closest('.star-rating');
      const compId = rating.dataset.row;
      const val = parseInt(star.dataset.value);

      if (scorecardScores[compId] === val) {
        delete scorecardScores[compId];
        syncStarRow(compId, undefined);
      } else {
        scorecardScores[compId] = val;
        syncStarRow(compId, val);
      }

      updateAutoRecommendation();
      persistScores();
    });
  }

  function setupStarRatings() {
    attachStarHandlers(document.getElementById('scorecard-cards'));
  }

  // --- Auto-Recommendation ---
  function updateAutoRecommendation() {
    const recResult = document.getElementById('auto-rec-result');
    const recLevel = document.getElementById('auto-rec-level');
    const recAvg = document.getElementById('auto-rec-avg-num');
    const fillMsg = document.querySelector('.auto-rec-fill-msg');
    if (!recResult || !recLevel || !recAvg) return;

    const { avg, levelKey, levelClass } = Analyzer.computeRecommendation(
      lastAnalysisData ? lastAnalysisData.scorecard : [], scorecardScores);

    if (!levelKey) {
      recResult.style.display = 'none';
      if (fillMsg) fillMsg.style.display = '';
      document.querySelectorAll('.rec-card').forEach(c => c.classList.remove('rec-active'));
      updateFloatingRecSummary();
      return;
    }

    const levels = T.get('autoRecLevels');
    recLevel.textContent = levels[levelKey];
    recLevel.className = 'auto-rec-level ' + levelClass;
    recAvg.textContent = avg.toFixed(1);

    if (fillMsg) fillMsg.style.display = 'none';
    recResult.style.display = '';

    // Highlight matching rec-card
    document.querySelectorAll('.rec-card').forEach(card => {
      card.classList.remove('rec-active');
    });
    const activeCard = document.querySelector(`.rec-card[data-rec-level="${levelClass}"]`);
    if (activeCard) {
      activeCard.classList.add('rec-active');
      // Update the badge avg
      const badge = activeCard.querySelector('.rec-active-badge strong');
      if (badge) badge.textContent = avg.toFixed(1);
    }

    // Also update the recommendation textarea if it exists
    const templateSections = document.querySelectorAll('#section-summary-template .summ-card');
    templateSections.forEach(section => {
      const title = section.querySelector('.summ-card-title') || section.querySelector('h3');
      if (title && (title.textContent.includes('Rekommendation') || title.textContent.includes('Recommendation'))) {
        const ta = section.querySelector('.template-textarea');
        if (ta && !ta.dataset.userEdited) {
          ta.value = `${levels[levelKey]} (${T.get('autoRecAvg')}: ${avg.toFixed(1)}/5)`;
        }
      }
    });

    updateFloatingRecSummary();
  }

  // --- Notes Extraction ---
  function setupNotesExtraction() {
    document.addEventListener('click', (e) => {
      if (e.target.closest('#extract-notes-btn')) {
        extractNotes();
      }
      if (e.target.closest('#clear-notes-btn')) {
        const textarea = document.getElementById('interview-notes');
        if (textarea) textarea.value = '';
        const status = document.getElementById('extract-status');
        if (status) status.style.display = 'none';
      }
    });

    // Mark template textareas as user-edited when typed in
    document.addEventListener('input', (e) => {
      if (e.target.classList.contains('template-textarea')) {
        e.target.dataset.userEdited = 'true';
      }
    });
  }

  function extractNotes() {
    const notesArea = document.getElementById('interview-notes');
    const status = document.getElementById('extract-status');
    if (!notesArea || !notesArea.value.trim()) return;

    const text = notesArea.value.trim();
    const lines = text.split('\n').filter(l => l.trim());

    // --- Extract to summary template ---
    const templateSections = document.querySelectorAll('#section-summary-template .summ-card');
    let matchedTemplate = 0;

    // Each section has:
    //   prefixes: line-start markers that route with high confidence (checked with startsWith)
    //   keywords: broader terms matched anywhere in the line
    // A line can match multiple sections only via keywords; prefix match is exclusive.
    const sectionRules = [
      {
        // Helhetsintryck / Overall Impression
        titles: ['Helhetsintryck', 'Overall Impression'],
        prefixes: ['helhetsintryck:', 'overall:', 'övergripande:', 'sammanfattning:', 'summering:', 'summary:', 'impression:', 'generellt:', 'general:'],
        keywords: ['helhetsintryck', 'overall impression', 'övergripande bedömning', 'sammanfattningsvis', 'sammantaget', 'totalt sett', 'på det hela', 'generellt sett', 'slutsats', 'min bedömning', 'my assessment', 'in summary', 'all in all', 'on the whole', 'bottom line']
      },
      {
        // Nyckelstyrkor / Key Strengths
        titles: ['Nyckelstyrkor', 'Key Strengths'],
        prefixes: ['styrka:', 'styrkor:', 'strength:', 'strengths:', 'plus:', 'fördel:', 'fördelar:', 'bra:', 'positivt:', 'imponerande:', '+:'],
        keywords: ['styrka', 'strength', 'imponera', 'utmärk', 'excellent', 'outstanding', 'fantastisk', 'exceptional', 'superb', 'gedigen', 'övertygande', 'convincing', 'kompetent', 'skicklig', 'duktig', 'talang', 'uppvisar', 'demonstrerade', 'visade prov', 'väl utvecklad', 'impressed', 'strong suit', 'highlight', 'lysande', 'mycket bra', 'överträffa', 'exceeded', 'leverera', 'delivered', 'nailed', 'fördel']
      },
      {
        // Farhågor & luckor / Concerns & Gaps
        titles: ['Farhågor', 'Concerns'],
        prefixes: ['svaghet:', 'svagheter:', 'weakness:', 'weaknesses:', 'oro:', 'concern:', 'risk:', 'minus:', 'negativt:', 'problem:', 'brist:', 'gap:', 'varning:', 'warning:', 'flag:', 'röd flagg:', 'red flag:', '-:'],
        keywords: ['svaghet', 'weakness', 'oro ', 'orolig', 'concern', 'brist', 'sakna', 'saknas', 'gap', 'risk', 'tveksam', 'tveksamhet', 'hesitant', 'uncertain', 'osäker', 'otydlig', 'vag svar', 'vague', 'unclear', 'undvik', 'avoided', 'inte kunna', 'could not', 'couldn\'t', 'unable', 'struggled', 'problematisk', 'problemat', 'röd flagg', 'red flag', 'varning', 'warning', 'bristfällig', 'insufficient', 'inadequate', 'limited experience', 'begränsad', 'ej erfarenhet', 'saknar erfarenhet', 'no experience', 'inte visat', 'did not show', 'missade', 'missed', 'förbättr', 'improve', 'utvecklingsområde', 'nackdel']
      },
      {
        // Teknisk passning / Technical Fit
        titles: ['Teknisk', 'Technical'],
        prefixes: ['teknisk:', 'tekniskt:', 'tech:', 'technical:', 'kod:', 'code:', 'arkitektur:', 'architecture:', 'system:', 'infrastruktur:', 'infra:', 'stack:', 'verktyg:'],
        keywords: ['teknisk', 'technical', 'kodkvalitet', 'kodning', 'kodgranskning', 'code review', 'code quality', 'codebase', 'programmering', 'programming', 'arkitektur', 'architect', 'system design', 'systemdesign', 'databas', 'database', 'sql', 'api', 'backend', 'frontend', 'fullstack', 'full-stack', 'ramverk', 'framework', 'react', 'angular', 'vue', 'node.js', 'python', 'java ', 'typescript', 'javascript', 'devops', 'ci/cd', 'pipeline', 'deploy', 'infrastruktur', 'infrastructure', 'moln', 'cloud', 'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'microservice', 'monolith', 'legacy', 'refaktor', 'refactor', 'algoritm', 'algorithm', 'git', 'versionshantering', 'testning', 'testing', 'debugging', 'debug', 'server', 'skalbar', 'scalab', 'prestanda', 'performance', 'säkerhet', 'security', 'implementer', 'implement']
      },
      {
        // Teampassning / Team Fit
        titles: ['Teampassning', 'Team Fit'],
        prefixes: ['team:', 'teamarbete:', 'teamwork:', 'samarbete:', 'collaboration:', 'kultur:', 'culture:', 'grupp:', 'kolleg:'],
        keywords: ['team', 'samarbete', 'collaborat', 'kolleg', 'colleague', 'grupp', 'group', 'kultur', 'culture', 'arbetssätt', 'working style', 'work style', 'passar in', 'fit in', 'komplement', 'complement', 'tillför', 'contribute', 'dynamik', 'dynamic', 'agil', 'agile', 'scrum', 'sprint', 'tvärfunktion', 'cross-function', 'inkluder', 'inclusive', 'respekt', 'respect', 'öppen', 'open', 'feedback', 'hjälpsam', 'helpful', 'stödj', 'support', 'konflikt', 'conflict', 'medhåll', 'consensus', 'anpass', 'adapt', 'flexib', 'atmosfär', 'environment', 'miljö', 'trivs', 'thrive', 'passa', 'mesh', 'gemenskap', 'belong']
      },
      {
        // Kommunikation / Communication
        titles: ['Kommunikation', 'Communication'],
        prefixes: ['kommunikation:', 'communication:', 'comm:', 'presentation:', 'present:'],
        keywords: ['kommunik', 'communicat', 'tydlig', 'otydlig', 'unclear', 'artikuler', 'articulat', 'lyssnade', 'listened', 'lyssnande', 'listening', 'presenterade', 'presented', 'presentation', 'förklara', 'explain', 'uttryck', 'express', 'formuler', 'formulat', 'resonera', 'reason', 'övertygande', 'persuasi', 'retorisk', 'rhetor', 'verbal', 'skriftlig', 'written', 'koncis', 'concise', 'ordrik', 'verbose', 'nervös', 'nervous', 'självsäker', 'confident', 'karisma', 'charisma', 'engagerande', 'engaging', 'dialog', 'dialogue', 'berättande', 'storytell', 'samtal', 'conversation', 'svarade', 'answered', 'välformulerad', 'well-spoken']
      },
      {
        // Tillväxtpotential / Growth Potential
        titles: ['Tillväxtpotential', 'Growth'],
        prefixes: ['tillväxt:', 'growth:', 'potential:', 'utveckling:', 'development:', 'framtid:', 'future:'],
        keywords: ['tillväxt', 'growth', 'potential', 'utvecklas', 'utveckling', 'develop further', 'lära sig', 'learn', 'nyfiken', 'curious', 'ambitiös', 'ambitious', 'motiverad', 'motivated', 'framtid', 'future', 'karriärplan', 'career plan', 'career path', 'befordra', 'promot', 'avancer', 'advanc', 'tech lead', 'senior roll', 'ledarroll', 'ramp up', 'mentor', 'coacha', 'coach', 'utbild', 'training', 'kurva', 'curve', 'mognad', 'maturity', 'växa', 'grow']
      },
      {
        // Rekommendation / Recommendation
        titles: ['Rekommendation', 'Recommendation'],
        prefixes: ['rekommendation:', 'recommendation:', 'beslut:', 'decision:', 'verdict:'],
        keywords: ['rekommend', 'recommend', 'strong hire', 'stark hire', 'no hire', 'lean hire', 'lean no', 'anställ', 'hire', 'avslå', 'reject', 'erbjudande', 'offer', 'beslut', 'decision', 'verdict', 'slutgiltig', 'final']
      },
      {
        // Nästa steg / Next Steps
        titles: ['Nästa steg', 'Next Steps'],
        prefixes: ['nästa steg:', 'next step:', 'next steps:', 'uppföljning:', 'follow-up:', 'åtgärd:', 'action:'],
        keywords: ['nästa steg', 'next step', 'uppföljning', 'follow up', 'follow-up', 'referenskontroll', 'referenstagning', 'reference check', 'andra intervju', 'second interview', 'tekniskt test', 'technical test', 'case-uppgift', 'prövotid', 'probation', 'erbjudande', 'offer', 'avvakta', 'wait', 'återkoppla', 'get back', 'kontakta', 'contact', 'bakgrundskontroll', 'background check', 'löneförhandling', 'salary negotiation', 'startdatum', 'start date', 'onboarding', 'åtgärd', 'action item', 'boka ', 'schedule']
      }
    ];

    // Two-pass matching:
    // Pass 1: Identify lines that start with a known prefix — route exclusively to that section
    // Pass 2: Remaining lines matched by keywords (can go to multiple sections)

    // Build section-to-textarea map
    const sectionMap = [];
    templateSections.forEach(section => {
      const titleEl = section.querySelector('.summ-card-title') || section.querySelector('h3');
      if (!titleEl) return;
      const title = titleEl.textContent;
      const textarea = section.querySelector('.template-textarea');
      if (!textarea || textarea.dataset.userEdited) return;
      const rule = sectionRules.find(r => r.titles.some(t => title.includes(t)));
      if (!rule) return;
      sectionMap.push({ rule, textarea, matched: [] });
    });

    // Pass 1: prefix-based exclusive routing
    const prefixMatched = new Set(); // line indices that already matched via prefix
    lines.forEach((line, lineIdx) => {
      const lower = line.toLowerCase().trim();
      for (const entry of sectionMap) {
        if (entry.rule.prefixes.some(p => lower.startsWith(p))) {
          entry.matched.push(line.trim());
          prefixMatched.add(lineIdx);
          break; // exclusive: only one section per prefix match
        }
      }
    });

    // Pass 2: keyword matching for non-prefix lines
    lines.forEach((line, lineIdx) => {
      if (prefixMatched.has(lineIdx)) return;
      const lower = line.toLowerCase().trim();
      for (const entry of sectionMap) {
        if (entry.rule.keywords.some(kw => lower.includes(kw))) {
          entry.matched.push(line.trim());
        }
      }
    });

    // Apply results
    sectionMap.forEach(entry => {
      if (entry.matched.length > 0) {
        const existing = entry.textarea.value.trim();
        entry.textarea.value = existing ? existing + '\n' + entry.matched.join('\n') : entry.matched.join('\n');
        matchedTemplate += entry.matched.length;
      }
    });

    // Show status
    if (status) {
      status.textContent = T.get('extractSuccess') + ` (${matchedTemplate} ${T.getLang() === 'sv' ? 'rader matchade' : 'lines matched'})`;
      status.style.display = 'block';
      setTimeout(() => { status.style.display = 'none'; }, 4000);
    }
  }

  // --- Section Toggles ---
  function setupSectionToggles() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    // Remove existing toggles to avoid duplicates on re-render
    sidebar.querySelectorAll('.section-toggle').forEach(t => t.remove());

    const navLinks = sidebar.querySelectorAll('.nav-link[data-section]');

    navLinks.forEach(link => {
      const sectionId = link.dataset.section;

      // Create toggle inside the nav-link
      const toggle = document.createElement('label');
      toggle.className = 'section-toggle';
      toggle.title = T.get('toggleHide');
      toggle.innerHTML = `<input type="checkbox" checked><span class="toggle-slider"></span>`;
      toggle.addEventListener('click', (e) => e.stopPropagation());

      const checkbox = toggle.querySelector('input');
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        const section = document.getElementById(sectionId);
        if (!section) return;

        if (checkbox.checked) {
          section.classList.remove('section-hidden');
          link.classList.remove('section-disabled');
          toggle.title = T.get('toggleHide');
        } else {
          section.classList.add('section-hidden');
          link.classList.add('section-disabled');
          toggle.title = T.get('toggleShow');
        }
      });

      link.appendChild(toggle);
    });
  }

  // --- Floating Scorecard Panel ---
  function buildFloatingScorecard() {
    const body = document.getElementById('floating-scorecard-body');
    if (!body) return;

    const rows = document.querySelectorAll('.scorecard-row');
    const labels = T.get('starLabels');
    const catLabels = T.get('catLabels');

    let html = '';
    rows.forEach((row) => {
      const name = row.dataset.compName;
      const weight = row.dataset.weight;
      const compId = row.dataset.compId;
      html += `
        <div class="floating-comp" data-comp-id="${compId}">
          <div class="floating-comp-top">
            <span class="floating-comp-name">${name}</span>
            <span class="weight-badge weight-${weight}">${weight}</span>
          </div>
          <div class="star-rating" data-row="${compId}">
            ${[1,2,3,4,5].map(n => `<span class="star" data-value="${n}" title="${labels[n-1]}">★</span>`).join('')}
            <span class="star-label" data-row="${compId}"></span>
          </div>
        </div>`;
    });

    body.innerHTML = html;
    attachStarHandlers(body);

    // Restore any existing scores
    Object.entries(scorecardScores).forEach(([row, val]) => {
      syncStarRow(row, val);
    });
  }

  function updateFloatingRecSummary() {
    const footer = document.getElementById('floating-scorecard-footer');
    if (!footer) return;

    const { avg, levelKey, levelClass } = Analyzer.computeRecommendation(
      lastAnalysisData ? lastAnalysisData.scorecard : [], scorecardScores);

    if (!levelKey) {
      footer.innerHTML = `<div class="floating-rec-empty" data-t="autoRecFill">${T.get('autoRecFill')}</div>`;
      return;
    }

    const levels = T.get('autoRecLevels');

    footer.innerHTML = `
      <div class="floating-rec-summary">
        <span class="floating-rec-level ${levelClass}">${levels[levelKey]}</span>
        <span class="floating-rec-avg"><strong>${avg.toFixed(1)}</strong> / 5</span>
      </div>`;
  }

  function setupFloatingPanel() {
    const toggleBtn = document.getElementById('scorecard-panel-toggle');
    const panel = document.getElementById('floating-scorecard');
    const closeBtn = document.getElementById('floating-scorecard-close');
    if (!toggleBtn || !panel) return;

    toggleBtn.addEventListener('click', () => {
      const isOpen = panel.classList.toggle('open');
      toggleBtn.classList.toggle('panel-open', isOpen);
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        panel.classList.remove('open');
        toggleBtn.classList.remove('panel-open');
      });
    }
  }

  function showFloatingToggle(show) {
    const btn = document.getElementById('scorecard-panel-toggle');
    if (btn) btn.style.display = show ? 'flex' : 'none';
    const container = document.getElementById('floating-toggles');
    if (container) container.style.display = show ? 'flex' : 'none';
  }


  // --- Competency Library Selection ---
  function setupCompetencyToggles() {
    const section = document.getElementById('section-competency-library');
    if (!section) return;

    section.addEventListener('change', (e) => {
      const checkbox = e.target;
      if (!checkbox.dataset.compId) return;
      const compId = checkbox.dataset.compId;
      const card = checkbox.closest('.comp-lib-card');

      // Update selection state in data
      const entry = lastAnalysisData.competencyLibrary.find(c => c.id === compId);
      if (entry) entry.selected = checkbox.checked;

      // Update card visual
      if (card) {
        card.classList.toggle('comp-lib-selected', checkbox.checked);
        card.classList.toggle('comp-lib-deselected', !checkbox.checked);
      }

      // Rebuild questions, scorecard from selection
      rebuildFromSelection();
    });

    // Toggle card open/close on header click (but not on checkbox)
    section.addEventListener('click', (e) => {
      if (e.target.closest('.comp-lib-toggle')) return;
      const card = e.target.closest('.comp-lib-card');
      if (card && e.target.closest('.comp-lib-header')) {
        card.classList.toggle('open');
      }
    });
  }

  function rebuildFromSelection() {
    if (!lastAnalysisData) return;

    const selected = lastAnalysisData.competencyLibrary.filter(c => c.selected);
    const selectedIds = selected.map(c => c.id);

    // Rebuild questions
    const questions = Analyzer.buildQuestionsForSelection(
      selectedIds, lastAnalysisData.analysis, T.getLang(), lastAnalysisData.ai);
    lastAnalysisData.questions = questions;
    Renderer.renderQuestions(lastAnalysisData);

    // Rebuild scorecard
    const scorecard = Analyzer.buildScorecardFromLibrary(selected, lastAnalysisData.analysis);
    lastAnalysisData.scorecard = scorecard;
    Renderer.renderScorecard(lastAnalysisData);

    // Rebuild interactivity for new scorecard
    setupStarRatings();
    buildFloatingScorecard();

    // Preserve scores that still exist
    const newScores = {};
    const newIds = new Set(scorecard.map(s => s.id));
    Object.entries(scorecardScores).forEach(([key, val]) => {
      if (newIds.has(key)) newScores[key] = val;
    });
    scorecardScores = newScores;
    updateAutoRecommendation();

    // Re-rendering the questions section recreates the notes panel, so
    // put the interviewer's notes back before anything reads them.
    applySessionContent(currentSession);

    persistSelection();
    persistScores();
    if (evidenceSearched) runEvidenceSearch();
    else renderEvidenceSlots();
  }

  // --- Notes collapse toggle ---
  function setupNotesCollapse() {
    const btn = document.querySelector('.notes-collapse-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      btn.closest('.interview-notes-panel').classList.toggle('collapsed');
    });
  }

  // --- Post-render setup (called after Renderer.renderAll) ---
  function setupResultsInteractivity(preserveScores) {
    setupStarRatings();
    setupSectionToggles();
    setupCompetencyToggles();
    setupNotesCollapse();
    buildFloatingScorecard();
    showFloatingToggle(true);
    initTranscribe();
    if (!preserveScores) {
      scorecardScores = {};
    }
  }

  // Rule-based competency ids are slugs of the translated names, so they
  // change with the language. When a saved selection matches none of the
  // freshly built ids, fall back to matching by position instead.
  function buildIdRemap(session, library) {
    const savedSelection = (session && session.selectedCompIds) || [];
    const savedLibrary = (session && session.libraryIds) || [];
    if (!savedSelection.length) return null;

    const libraryIds = library.map(c => c.id);
    if (savedSelection.some(id => libraryIds.includes(id))) return null;
    if (savedLibrary.length !== libraryIds.length) return null;

    const map = {};
    savedLibrary.forEach((id, i) => { map[id] = libraryIds[i]; });
    return map;
  }

  function remapKeys(obj, idMap) {
    return Object.entries(obj || {}).reduce((out, [id, val]) => {
      out[(idMap && idMap[id]) || id] = val;
      return out;
    }, {});
  }

  function setLoadingStatus(text) {
    const el = document.getElementById('loading-status');
    if (el) el.textContent = text;
  }

  // Runs the generation behind the loading screen, cycling the copy and
  // offering an escape hatch so a slow or missing endpoint never blocks
  // the interviewer from getting a kit.
  async function runGeneration(text, lang, reuseCompetencies) {
    const steps = T.get('loadingAiSteps');
    let step = 0;
    setLoadingStatus(steps[0]);
    const ticker = setInterval(() => {
      step = Math.min(step + 1, steps.length - 1);
      setLoadingStatus(steps[step]);
    }, 6000);

    const skipBtn = document.getElementById('loading-skip');
    let onSkip = null;
    const skipped = new Promise(resolve => {
      onSkip = () => resolve({ ok: false, code: 'cancelled' });
      if (skipBtn) {
        skipBtn.textContent = T.get('loadingSkip');
        skipBtn.style.display = '';
        skipBtn.addEventListener('click', onSkip);
      }
    });

    try {
      return await Promise.race([AI.generate(text, lang, reuseCompetencies), skipped]);
    } finally {
      clearInterval(ticker);
      AI.cancel();
      if (skipBtn) {
        skipBtn.removeEventListener('click', onSkip);
        skipBtn.style.display = 'none';
      }
    }
  }

  // Any competencies we can hand back to keep ids stable across languages
  function reusableCompetencies(session) {
    const cache = (session && session.ai) || {};
    const any = Object.values(cache)[0];
    return any ? any.competencies : null;
  }

  /**
   * @param text         the job description to analyse
   * @param restoreFrom  a saved session to rehydrate into the result,
   *                     or undefined to start a new one
   */
  async function runAnalysis(text, restoreFrom) {
    showPage('loading');
    const lang = T.getLang();

    const loadingMessages = T.get('loadingSteps');
    for (let i = 0; i < loadingMessages.length; i++) {
      setLoadingStatus(loadingMessages[i]);
      await sleep(restoreFrom ? 40 : 220 + Math.random() * 160);
    }

    let data = Analyzer.analyze(text, lang);

    // ── Generated package: from cache, freshly requested, or skipped ──
    const cached = restoreFrom && restoreFrom.ai && restoreFrom.ai[lang];
    let generated = null;
    aiNotice = null;

    if (cached) {
      generated = cached;
    } else {
      // On restore, only regenerate when this role already has a generated
      // package in another language — never silently re-bill a rule-based
      // session the user chose to keep.
      const reuse = reusableCompetencies(restoreFrom);
      const shouldGenerate = forceGeneration || !restoreFrom || !!reuse;
      forceGeneration = false;
      if (shouldGenerate) {
        const outcome = await runGeneration(text, lang, reuse);
        if (outcome.ok) generated = outcome.data;
        else aiNotice = outcome.code;
      }
    }

    if (generated) data = Analyzer.applyAiPackage(data, generated, lang);

    // ── Competency selection ──
    const idMap = buildIdRemap(restoreFrom, data.competencyLibrary);
    const savedSelection = restoreFrom && restoreFrom.selectedCompIds;

    if (savedSelection) {
      const selected = new Set(savedSelection.map(id => (idMap && idMap[id]) || id));
      const known = new Set((restoreFrom.libraryIds || []).map(id => (idMap && idMap[id]) || id));
      data.competencyLibrary.forEach(c => {
        // A competency the saved selection never saw — the package was
        // regenerated since — starts selected rather than silently hidden.
        c.selected = selected.has(c.id) || !known.has(c.id);
      });
    } else if (preSelectedB5.size > 0) {
      // Carry over B5 pre-selections from landing page
      data.competencyLibrary.forEach(c => {
        if (c.source === 'bigFive' && preSelectedB5.has(c.id)) c.selected = true;
      });
    }

    if (savedSelection || preSelectedB5.size > 0) {
      const selected = data.competencyLibrary.filter(c => c.selected);
      data.questions = Analyzer.buildQuestionsForSelection(
        selected.map(c => c.id), data.analysis, lang, data.ai);
      data.scorecard = Analyzer.buildScorecardFromLibrary(selected, data.analysis);
    }

    lastAnalysisData = data;
    lastText = text;

    document.getElementById('role-title-header').textContent = data.analysis.title;
    Renderer.renderAll(data);

    showPage('results');
    mainContent.scrollTop = 0;
    window.scrollTo(0, 0);

    setupScrollSpy();
    setupResultsInteractivity();

    if (restoreFrom) {
      currentSession = restoreFrom;
      // setupResultsInteractivity() cleared the scores, so refill after it
      scorecardScores = remapKeys(restoreFrom.scores, idMap);
      currentSession.evidence = remapKeys(restoreFrom.evidence, idMap);
      Object.entries(scorecardScores).forEach(([compId, val]) => syncStarRow(compId, val));
      applySessionContent(restoreFrom);
      updateAutoRecommendation();
    } else {
      currentSession = Store.create({
        role: data.analysis.title,
        lang,
        jdText: text,
        preSelectedB5: [...preSelectedB5],
      });
      const nameInput = document.getElementById('candidate-name');
      if (nameInput) nameInput.value = '';
    }

    if (generated) {
      persist({ ai: { ...((currentSession && currentSession.ai) || {}), [lang]: generated } });
    }
    persistSelection();
    persistScores();
    renderPackageBar();
    prepareEvidence(restoreFrom);
  }

  // --- Landing Competency Library ---
  function renderLandingLibrary() {
    const container = document.getElementById('landing-competency-library');
    if (!container) return;
    const defaultLib = Analyzer.buildDefaultLibrary();
    // Mark any previously selected ones
    defaultLib.forEach(c => { if (preSelectedB5.has(c.id)) c.selected = true; });
    container.innerHTML = Renderer.renderCompetencyLibraryHTML({ competencyLibrary: defaultLib });
    setupLandingCompetencyToggles();
  }

  function setupLandingCompetencyToggles() {
    const container = document.getElementById('landing-competency-library');
    if (!container) return;

    container.addEventListener('change', (e) => {
      const checkbox = e.target;
      if (!checkbox.dataset.compId) return;
      const compId = checkbox.dataset.compId;
      const card = checkbox.closest('.comp-lib-card');

      if (checkbox.checked) {
        preSelectedB5.add(compId);
      } else {
        preSelectedB5.delete(compId);
      }

      if (card) {
        card.classList.toggle('comp-lib-selected', checkbox.checked);
        card.classList.toggle('comp-lib-deselected', !checkbox.checked);
      }
    });

    container.addEventListener('click', (e) => {
      if (e.target.closest('.comp-lib-toggle')) return;
      const card = e.target.closest('.comp-lib-card');
      if (card && e.target.closest('.comp-lib-header')) {
        card.classList.toggle('open');
      }
    });
  }

  // ══════════════════════════════════════
  //  Session persistence
  // ══════════════════════════════════════

  let currentSession = null;
  let saveIndicatorTimer = null;

  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str === undefined || str === null ? '' : String(str);
    return div.innerHTML;
  }

  // The comparison view only needs the shape of the scorecard, not the
  // full library entry behind it.
  function snapshotScorecard(scorecard) {
    return (scorecard || []).map(c => ({ id: c.id, name: c.name, category: c.category, weight: c.weight }));
  }

  function flashSaved() {
    const el = document.getElementById('save-indicator');
    if (!el || !Store.enabled) return;
    el.textContent = T.get('savedIndicator');
    el.classList.add('visible');
    clearTimeout(saveIndicatorTimer);
    saveIndicatorTimer = setTimeout(() => el.classList.remove('visible'), 1600);
  }

  function persist(fields) {
    if (!currentSession) return;
    Store.patch(fields);
    flashSaved();
  }

  function persistScores() {
    if (!lastAnalysisData) return;
    const rec = Analyzer.computeRecommendation(lastAnalysisData.scorecard, scorecardScores);
    persist({
      scores: { ...scorecardScores },
      scorecard: snapshotScorecard(lastAnalysisData.scorecard),
      recommendation: rec.levelKey ? { levelKey: rec.levelKey, avg: rec.avg, scored: rec.scored, total: rec.total } : null,
    });
  }

  function persistSelection() {
    if (!lastAnalysisData) return;
    persist({
      selectedCompIds: lastAnalysisData.competencyLibrary.filter(c => c.selected).map(c => c.id),
      libraryIds: lastAnalysisData.competencyLibrary.map(c => c.id),
      scorecard: snapshotScorecard(lastAnalysisData.scorecard),
      source: lastAnalysisData.source,
    });
  }

  function collectTemplate() {
    const values = {};
    const edited = [];
    document.querySelectorAll('#section-summary-template .template-textarea').forEach(ta => {
      const idx = ta.dataset.sectionIndex;
      if (idx === undefined) return;
      if (ta.value.trim()) values[idx] = ta.value;
      if (ta.dataset.userEdited) edited.push(idx);
    });
    return { template: values, templateEdited: edited };
  }

  // Put the human-entered parts of a session back into the freshly
  // rendered DOM. The analysis itself is deterministic, so it is
  // rebuilt from the job description rather than stored.
  function applySessionContent(session) {
    if (!session) return;

    const notes = document.getElementById('interview-notes');
    if (notes && session.notes) notes.value = session.notes;

    const edited = new Set(session.templateEdited || []);
    Object.entries(session.template || {}).forEach(([idx, val]) => {
      const ta = document.querySelector(`#section-summary-template .template-textarea[data-section-index="${idx}"]`);
      if (!ta) return;
      ta.value = val;
      if (edited.has(idx)) ta.dataset.userEdited = 'true';
    });

    const nameInput = document.getElementById('candidate-name');
    if (nameInput) nameInput.value = session.candidate || '';
  }

  function setupPersistence() {
    const indicator = document.getElementById('save-indicator');
    if (!Store.enabled) {
      if (indicator) {
        indicator.textContent = T.get('storageUnavailable');
        indicator.classList.add('visible', 'save-indicator-warn');
      }
      return;
    }

    const nameInput = document.getElementById('candidate-name');
    if (nameInput) {
      nameInput.addEventListener('input', () => persist({ candidate: nameInput.value }));
    }

    // The notes and template fields are re-created on every render,
    // so listen at the document level.
    document.addEventListener('input', (e) => {
      if (e.target.id === 'interview-notes') {
        persist({ notes: e.target.value });
      } else if (e.target.classList.contains('template-textarea')) {
        persist(collectTemplate());
      }
    });
  }

  function setupResumeBanner() {
    const banner = document.getElementById('resume-banner');
    if (!banner) return;

    const session = Store.current();
    if (!session || !Store.isResumable(session)) return;

    const desc = document.getElementById('resume-desc');
    if (desc) {
      const who = (session.candidate || '').trim();
      desc.textContent = [
        T.get('resumeDesc').replace('{role}', session.role || '—'),
        who,
        T.relativeTime(session.updatedAt),
      ].filter(Boolean).join(' · ');
    }

    banner.dataset.sessionId = session.id;
    banner.style.display = 'flex';
  }

  function setupSessionUi() {
    const banner = document.getElementById('resume-banner');
    const resumeBtn = document.getElementById('resume-btn');
    const discardBtn = document.getElementById('resume-discard-btn');

    if (resumeBtn) {
      resumeBtn.addEventListener('click', () => {
        const id = banner ? banner.dataset.sessionId : null;
        const session = id ? Store.get(id) : null;
        if (banner) banner.style.display = 'none';
        if (session) restoreSession(session);
      });
    }

    if (discardBtn) {
      discardBtn.addEventListener('click', () => {
        if (banner) banner.style.display = 'none';
        Store.setCurrent(null);
      });
    }
  }

  function restoreSession(session) {
    if (!session || !session.jdText) return;

    Store.setCurrent(session.id);

    const lang = session.lang || T.getLang();
    if (lang !== T.getLang()) {
      T.setLang(lang);
      Analyzer.setLang(lang);
      document.documentElement.lang = lang;
      document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === lang);
      });
      updateLandingText();
      updateSidebarNav();
      updatePhaseLabels();
    }

    preSelectedB5 = new Set(session.preSelectedB5 || []);
    textarea.value = session.jdText;
    updateCharCount();
    runAnalysis(session.jdText, session);
  }

  function updateSavedCount() {
    const btn = document.getElementById('saved-sessions-btn');
    if (!btn) return;
    const count = Store.list().length;
    btn.style.display = count ? 'inline-flex' : 'none';
    const badge = document.getElementById('saved-count');
    if (badge) badge.textContent = count;
  }

  // ══════════════════════════════════════
  //  Package source
  // ══════════════════════════════════════

  let aiNotice = null;
  let forceGeneration = false;

  // Tells the user whether they are looking at a generated package or the
  // rule-based fallback, and why — an interview kit's provenance matters.
  function renderPackageBar() {
    const bar = document.getElementById('package-bar');
    const badge = document.getElementById('package-badge');
    const note = document.getElementById('package-note');
    const button = document.getElementById('package-generate');
    if (!bar || !badge || !note || !button) return;

    const isAi = !!(lastAnalysisData && lastAnalysisData.source === 'ai');
    const notices = T.get('aiNotices');

    badge.className = 'package-badge ' + (isAi ? 'package-badge-ai' : 'package-badge-rules');
    badge.textContent = T.get(isAi ? 'packageAi' : 'packageRules');

    if (aiNotice) note.textContent = notices[aiNotice] || notices.generation_failed;
    else note.textContent = isAi ? T.get('packageAiNote') : T.get('packageRulesNote');

    button.textContent = T.get(aiNotice ? 'packageRetry' : 'packageGenerate');
    button.style.display = isAi ? 'none' : '';
    bar.style.display = 'flex';
  }

  function setupPackageBar() {
    const button = document.getElementById('package-generate');
    if (!button) return;
    button.addEventListener('click', async () => {
      if (!lastText || AI.isGenerating()) return;
      // Generating replaces the competencies, so any rating tied to the
      // old ones is lost. Say so before doing it.
      if (Object.keys(scorecardScores).length && !confirm(T.get('packageRegenerateWarning'))) return;
      Store.flush();
      forceGeneration = true;
      await runAnalysis(lastText, currentSession || undefined);
    });
  }

  // ══════════════════════════════════════
  //  Evidence extraction
  // ══════════════════════════════════════

  let evidenceIndex = null;
  let evidenceSuggestions = {};
  let evidenceSearched = false;
  let evidenceSpeakers = [];
  let candidateSpeaker = null;

  // Only competencies that actually made it onto the scorecard.
  function selectedLibraryEntries() {
    if (!lastAnalysisData) return [];
    const ids = new Set((lastAnalysisData.scorecard || []).map(c => c.id));
    return (lastAnalysisData.competencyLibrary || []).filter(c => ids.has(c.id));
  }

  function buildEvidenceIndex() {
    const comps = selectedLibraryEntries();
    if (!comps.length) {
      evidenceIndex = null;
      return;
    }
    const analysis = (lastAnalysisData && lastAnalysisData.analysis) || {};
    const ai = (lastAnalysisData && lastAnalysisData.ai) || null;
    const hints = Evidence.buildHints(comps, {
      responsibilities: analysis.responsibilities || [],
      questions: ai ? ai.questions : [],
    });
    evidenceIndex = Evidence.buildIndex(comps, hints);
  }

  // Prefer the diarized utterances we stored, but fall back to parsing
  // the notes field so a pasted transcript works too.
  function getUtterances() {
    if (currentSession && (currentSession.utterances || []).length) return currentSession.utterances;
    const notes = document.getElementById('interview-notes');
    return notes ? Evidence.parseTranscript(notes.value) : [];
  }

  function pinnedFor(compId) {
    if (!currentSession || !currentSession.evidence) return [];
    return currentSession.evidence[compId] || [];
  }

  // Must mirror the filtering in Renderer.evidenceSlotHTML so that the
  // rendered positions line up with what we pin.
  function visibleSuggestions(compId) {
    const pinned = pinnedFor(compId);
    return (evidenceSuggestions[compId] || []).filter(sg => !pinned.some(p => p.text === sg.text));
  }

  function renderSpeakerPicker() {
    const el = document.getElementById('evidence-speakers');
    if (!el) return;

    if (evidenceSpeakers.length < 2) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }

    el.style.display = 'flex';
    el.innerHTML = `<span class="evidence-speakers-label">${T.get('evidenceSpeakerQ')}</span>` +
      evidenceSpeakers.map(sp => `
        <button class="speaker-chip${sp.speaker === candidateSpeaker ? ' speaker-chip-on' : ''}" data-speaker="${escHtml(sp.speaker)}">
          <span>${escHtml(sp.speaker)}</span>
          <span class="speaker-share">${Math.round(sp.share * 100)}% ${T.get('evidenceSpeakerHint')}</span>
        </button>`).join('');
  }

  function renderEvidenceSlots() {
    document.querySelectorAll('[data-evidence-for]').forEach(slot => {
      const compId = slot.dataset.evidenceFor;
      slot.innerHTML = Renderer.evidenceSlotHTML(
        compId, pinnedFor(compId), evidenceSuggestions[compId] || []);
    });
  }

  function runEvidenceSearch() {
    const status = document.getElementById('evidence-status');
    const utterances = getUtterances();

    if (!utterances.length) {
      evidenceSpeakers = [];
      evidenceSuggestions = {};
      renderSpeakerPicker();
      // Still repaint, so already-pinned quotes survive a re-render
      renderEvidenceSlots();
      if (status) {
        status.className = 'evidence-status evidence-status-hint';
        status.textContent = T.get('evidenceNoTranscript');
      }
      return;
    }

    evidenceSpeakers = Evidence.speakerStats(utterances);
    if (!candidateSpeaker || !evidenceSpeakers.some(sp => sp.speaker === candidateSpeaker)) {
      candidateSpeaker = Evidence.guessCandidate(utterances);
    }
    renderSpeakerPicker();

    buildEvidenceIndex();
    evidenceSuggestions = evidenceIndex
      ? Evidence.findEvidence(utterances, evidenceIndex, { candidateSpeaker })
      : {};
    evidenceSearched = true;

    const passages = Object.values(evidenceSuggestions).reduce((sum, arr) => sum + arr.length, 0);
    const comps = Object.keys(evidenceSuggestions).length;

    if (status) {
      status.className = 'evidence-status';
      status.textContent = passages
        ? T.get('evidenceSummary').replace('{n}', passages).replace('{m}', comps)
        : T.get('evidenceSummaryNone');
    }

    const label = document.getElementById('find-evidence-label');
    if (label) label.textContent = T.get('evidenceRerun');

    persist({ candidateSpeaker });
    renderEvidenceSlots();
  }

  function prepareEvidence(session) {
    evidenceIndex = null;
    evidenceSuggestions = {};
    evidenceSearched = false;
    evidenceSpeakers = [];
    candidateSpeaker = session ? (session.candidateSpeaker || null) : null;

    const status = document.getElementById('evidence-status');
    if (status) { status.textContent = ''; status.className = 'evidence-status'; }

    renderSpeakerPicker();
    renderEvidenceSlots();

    // A restored session usually already has a transcript — search it
    // straight away so the pinned quotes have their context back.
    if (getUtterances().length) runEvidenceSearch();
  }

  function pinEvidence(compId, position) {
    const quote = visibleSuggestions(compId)[position];
    if (!quote || !currentSession) return;

    const evidence = { ...(currentSession.evidence || {}) };
    evidence[compId] = [...(evidence[compId] || []), {
      text: quote.text,
      speaker: quote.speaker,
      strength: quote.strength,
      pinnedAt: Date.now(),
    }];

    persist({ evidence });
    renderEvidenceSlots();
  }

  function unpinEvidence(compId, position) {
    if (!currentSession) return;

    const evidence = { ...(currentSession.evidence || {}) };
    const list = [...(evidence[compId] || [])];
    list.splice(position, 1);
    if (list.length) evidence[compId] = list;
    else delete evidence[compId];

    persist({ evidence });
    renderEvidenceSlots();
  }

  function setupEvidence() {
    document.addEventListener('click', (e) => {
      if (e.target.closest('#find-evidence-btn')) {
        runEvidenceSearch();
        return;
      }

      const chip = e.target.closest('.speaker-chip');
      if (chip) {
        candidateSpeaker = chip.dataset.speaker;
        runEvidenceSearch();
        return;
      }

      const pin = e.target.closest('[data-pin-evidence]');
      if (pin) {
        pinEvidence(pin.dataset.pinEvidence, parseInt(pin.dataset.evPos, 10));
        return;
      }

      const unpin = e.target.closest('[data-unpin-evidence]');
      if (unpin) {
        unpinEvidence(unpin.dataset.unpinEvidence, parseInt(unpin.dataset.evPos, 10));
        return;
      }

      const quote = e.target.closest('.ev-quote');
      if (quote) quote.classList.toggle('ev-expanded');
    });
  }

  // Called by transcribe.js once AssemblyAI returns diarized speech.
  window.RecruitmentOS = window.RecruitmentOS || {};
  window.RecruitmentOS.onTranscript = function (result) {
    const utterances = (result && result.utterances) || [];
    const notes = document.getElementById('interview-notes');
    persist({ utterances, notes: notes ? notes.value : '' });
    if (utterances.length) runEvidenceSearch();
  };

  // ══════════════════════════════════════
  //  Candidate comparison
  // ══════════════════════════════════════

  function openCompare() {
    Store.flush();
    showFloatingToggle(false);
    const panel = document.getElementById('floating-scorecard');
    if (panel) panel.classList.remove('open');
    const toggle = document.getElementById('scorecard-panel-toggle');
    if (toggle) toggle.classList.remove('panel-open');

    showPage('compare');
    Compare.open(currentSession ? currentSession.role : '');
    window.scrollTo(0, 0);
  }

  function setupCompare() {
    Compare.init({
      onOpenSession(id) {
        const session = Store.get(id);
        if (session) restoreSession(session);
      },
    });

    ['compare-btn', 'saved-sessions-btn'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', openCompare);
    });

    const back = document.getElementById('cmp-back');
    if (back) {
      back.addEventListener('click', () => {
        if (lastAnalysisData) {
          showPage('results');
          showFloatingToggle(true);
        } else {
          showPage('landing');
          updateSavedCount();
        }
      });
    }

    const cmpLogo = document.getElementById('compare-logo-home');
    if (cmpLogo) {
      cmpLogo.addEventListener('click', (e) => {
        e.preventDefault();
        showPage('landing');
        updateSavedCount();
      });
    }
  }

  // --- Init ---
  setupLangToggles();
  setupLandingPreviews();
  updateLandingText();
  setupNotesExtraction();
  setupFloatingPanel();
  renderLandingLibrary();
  setupPersistence();
  setupPackageBar();
  setupEvidence();
  setupCompare();
  setupSessionUi();
  setupResumeBanner();
  updateSavedCount();
})();
