(() => {
  const toggleBtn = document.getElementById('transcribe-panel-toggle');
  const panel = document.getElementById('floating-transcribe');
  const closeBtn = document.getElementById('transcribe-close');
  const recBtn = document.getElementById('rec-btn');
  const micIcon = document.getElementById('rec-mic-icon');
  const stopIcon = document.getElementById('rec-stop-icon');
  const audioLevelEl = document.getElementById('audio-level');
  const statusEl = document.getElementById('rec-status');
  const badgeEl = document.getElementById('rec-badge');
  const timerEl = document.getElementById('rec-timer');
  const bodyEl = document.getElementById('transcribe-body');
  const footerEl = document.getElementById('transcribe-footer');
  const copyBtn = document.getElementById('transcribe-copy');
  const downloadBtn = document.getElementById('transcribe-download');
  const clearBtn = document.getElementById('transcribe-clear');
  const sourceBtns = document.querySelectorAll('.source-btn');

  if (!toggleBtn || !panel) return;

  let source = 'microphone';
  let isRecording = false;
  let timerInterval = null;
  let elapsed = 0;
  let transcripts = [];    // finalized segments
  let interimText = '';     // current interim (speech API only)
  const BAR_COUNT = 24;

  // Speech recognition (mic mode)
  let recognition = null;
  let micStream = null;
  let analyser = null;
  let animFrame = 0;

  // Whisper fallback (system audio mode)
  let mediaRecorder = null;
  let systemStream = null;
  let pendingChunks = 0;
  const CHUNK_MS = 2000;

  // Build audio level bars
  for (let i = 0; i < BAR_COUNT; i++) {
    const bar = document.createElement('div');
    bar.className = 'audio-bar';
    bar.style.height = '3px';
    audioLevelEl.appendChild(bar);
  }
  const bars = audioLevelEl.querySelectorAll('.audio-bar');

  // Panel toggle
  toggleBtn.addEventListener('click', () => {
    const isOpen = panel.classList.toggle('open');
    toggleBtn.classList.toggle('panel-open', isOpen);
  });

  closeBtn.addEventListener('click', () => {
    panel.classList.remove('open');
    toggleBtn.classList.remove('panel-open');
  });

  // Source toggle
  sourceBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (isRecording) return;
      sourceBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      source = btn.dataset.source;
    });
  });

  function setStatus(status) {
    statusEl.style.display = 'flex';
    badgeEl.className = 'rec-badge ' + status;
    if (status === 'recording') badgeEl.textContent = 'Lyssnar...';
    else if (status === 'transcribing') badgeEl.textContent = 'Transkriberar...';
    else { badgeEl.textContent = ''; statusEl.style.display = 'none'; }
  }

  function formatTime(s) {
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function render() {
    const hasContent = transcripts.length > 0 || interimText;
    if (!hasContent) {
      bodyEl.innerHTML = '<p class="placeholder-text">Transkriberad text visas här...</p>';
      footerEl.style.display = 'none';
      return;
    }

    let html = '';
    if (transcripts.length > 0) {
      html += transcripts.map(t => '<span>' + escapeHtml(t) + '</span>').join(' ');
    }
    if (interimText) {
      html += ' <span class="interim-text">' + escapeHtml(interimText) + '</span>';
    }
    bodyEl.innerHTML = '<p class="transcript-flow">' + html + '</p>';
    footerEl.style.display = transcripts.length > 0 ? 'flex' : 'none';
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // ─── Audio level monitor ───
  function startLevelMonitor(stream) {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    function tick() {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length / 255;
      bars.forEach((bar, i) => {
        const active = i / BAR_COUNT < avg;
        bar.style.height = Math.max(3, avg * 24 * (0.5 + Math.random() * 0.5)) + 'px';
        bar.style.opacity = active ? '1' : '0.15';
      });
      animFrame = requestAnimationFrame(tick);
    }
    tick();
  }

  function stopLevelMonitor() {
    cancelAnimationFrame(animFrame);
    audioLevelEl.style.display = 'none';
    bars.forEach(b => { b.style.height = '3px'; b.style.opacity = '0.15'; });
  }

  // ─── Web Speech API (microphone — instant) ───
  function startSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      // Fallback to Whisper if Speech API unavailable
      startWhisperRecording('microphone');
      return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'sv-SE';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (text) {
            transcripts.push(text);
          }
          interimText = '';
        } else {
          interim += result[0].transcript;
        }
      }
      if (interim) interimText = interim;
      render();
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') return; // normal, just silence
      console.error('Speech recognition error:', event.error);
    };

    recognition.onend = () => {
      // Auto-restart if still recording (browser stops after silence)
      if (isRecording && source === 'microphone') {
        try { recognition.start(); } catch (e) { /* already started */ }
      }
    };

    // Get mic stream for level monitor
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      micStream = stream;
      startLevelMonitor(stream);
      audioLevelEl.style.display = 'flex';
    }).catch(() => {});

    recognition.start();
  }

  function stopSpeechRecognition() {
    if (recognition) {
      recognition.onend = null; // prevent auto-restart
      recognition.stop();
      recognition = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    // Finalize any interim text
    if (interimText.trim()) {
      transcripts.push(interimText.trim());
      interimText = '';
    }
    render();
  }

  // ─── Whisper API (system audio — chunked) ───
  async function sendChunk(blob) {
    if (blob.size < 500) return;
    pendingChunks++;
    setStatus('transcribing');
    try {
      const formData = new FormData();
      formData.append('file', blob, 'chunk.webm');
      formData.append('model', 'whisper-1');
      formData.append('language', 'sv');
      formData.append('response_format', 'json');
      formData.append('prompt', (transcripts.slice(-3).join('. ') || 'Transkribera följande svenska ljud noggrant.'));

      const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.text && data.text.trim()) {
        transcripts.push(data.text.trim());
        render();
      }
    } catch (e) {
      console.error('Transcription error:', e);
    } finally {
      pendingChunks--;
      if (pendingChunks === 0 && isRecording) setStatus('recording');
      if (pendingChunks === 0 && !isRecording) setStatus('idle');
    }
  }

  async function startWhisperRecording(src) {
    try {
      let stream;
      if (src === 'microphone') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        if (stream.getAudioTracks().length === 0) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        stream.getVideoTracks().forEach(t => t.stop());
      }

      systemStream = stream;
      startLevelMonitor(stream);
      audioLevelEl.style.display = 'flex';

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
      mediaRecorder = new MediaRecorder(stream, { mimeType });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) sendChunk(e.data);
      };

      mediaRecorder.start(CHUNK_MS);
    } catch (e) {
      console.error('Recording error:', e);
    }
  }

  function stopWhisperRecording() {
    if (mediaRecorder) { mediaRecorder.stop(); mediaRecorder = null; }
    if (systemStream) { systemStream.getTracks().forEach(t => t.stop()); systemStream = null; }
  }

  // ─── Start / Stop ───
  function startRecording() {
    isRecording = true;
    elapsed = 0;
    timerEl.textContent = '00:00';
    timerInterval = setInterval(() => { elapsed++; timerEl.textContent = formatTime(elapsed); }, 1000);
    setStatus('recording');

    recBtn.classList.add('recording');
    micIcon.style.display = 'none';
    stopIcon.style.display = 'block';
    toggleBtn.classList.add('is-recording');

    if (source === 'microphone') {
      startSpeechRecognition();
    } else {
      startWhisperRecording('system');
    }
  }

  function stopRecording() {
    isRecording = false;
    clearInterval(timerInterval);
    stopLevelMonitor();

    recBtn.classList.remove('recording');
    micIcon.style.display = 'block';
    stopIcon.style.display = 'none';
    toggleBtn.classList.remove('is-recording');

    if (source === 'microphone') {
      stopSpeechRecognition();
    } else {
      stopWhisperRecording();
    }

    if (pendingChunks === 0) setStatus('idle');
  }

  recBtn.addEventListener('click', () => {
    if (!isRecording) startRecording();
    else stopRecording();
  });

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(transcripts.join(' '));
  });

  downloadBtn.addEventListener('click', () => {
    const blob = new Blob([transcripts.join('\n\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'transkription-' + new Date().toISOString().slice(0, 19) + '.txt';
    a.click();
    URL.revokeObjectURL(url);
  });

  clearBtn.addEventListener('click', () => {
    transcripts = [];
    interimText = '';
    render();
  });
})();
