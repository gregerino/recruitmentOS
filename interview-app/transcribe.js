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
  let mediaRecorder = null;
  let stream = null;
  let analyser = null;
  let animFrame = 0;
  let timerInterval = null;
  let elapsed = 0;
  let pendingChunks = 0;
  let transcripts = [];
  const CHUNK_MS = 5000;
  const BAR_COUNT = 24;

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
      if (mediaRecorder) return;
      sourceBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      source = btn.dataset.source;
    });
  });

  function setStatus(status) {
    statusEl.style.display = 'flex';
    badgeEl.className = 'rec-badge ' + status;
    if (status === 'recording') badgeEl.textContent = 'Spelar in...';
    else if (status === 'transcribing') badgeEl.textContent = 'Transkriberar...';
    else { badgeEl.textContent = 'Klar'; statusEl.style.display = 'none'; }
  }

  function formatTime(s) {
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function renderTranscripts() {
    if (transcripts.length === 0) {
      bodyEl.innerHTML = '<p class="placeholder-text">Transkriberad text visas här...</p>';
      footerEl.style.display = 'none';
    } else {
      bodyEl.innerHTML = transcripts.map(t => '<p>' + escapeHtml(t) + '</p>').join('');
      footerEl.style.display = 'flex';
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }
  }

  async function sendChunk(blob) {
    if (blob.size < 1000) return;
    pendingChunks++;
    try {
      const formData = new FormData();
      formData.append('file', blob, 'chunk.webm');
      formData.append('model', 'whisper-1');
      formData.append('language', 'sv');
      formData.append('response_format', 'json');
      formData.append('prompt', 'Transkribera följande svenska ljud noggrant. Använd korrekt svensk stavning, grammatik och interpunktion. Skriv ut siffror som ord när det är naturligt. Använd versaler vid egennamn och meningsstart. Inkludera skiljetecken som punkt, komma och frågetecken.');

      const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'HTTP ' + res.status);
      }
      const data = await res.json();
      if (data.text && data.text.trim()) {
        transcripts.push(data.text.trim());
        renderTranscripts();
      }
    } catch (e) {
      console.error('Transcription error:', e);
    } finally {
      pendingChunks--;
      if (pendingChunks === 0 && (!mediaRecorder || mediaRecorder.state !== 'recording')) {
        setStatus('idle');
      }
    }
  }

  function startLevelMonitor(audioStream) {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(audioStream);
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

  async function startRecording() {
    try {
      if (source === 'microphone') {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, sampleRate: 16000 }
        });
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        stream.getVideoTracks().forEach(t => t.stop());
      }

      startLevelMonitor(stream);
      audioLevelEl.style.display = 'flex';

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
      mediaRecorder = new MediaRecorder(stream, { mimeType });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          setStatus('transcribing');
          sendChunk(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        if (pendingChunks === 0) setStatus('idle');
      };

      mediaRecorder.start(CHUNK_MS);
      setStatus('recording');
      elapsed = 0;
      timerEl.textContent = '00:00';
      timerInterval = setInterval(() => {
        elapsed++;
        timerEl.textContent = formatTime(elapsed);
      }, 1000);

      recBtn.classList.add('recording');
      micIcon.style.display = 'none';
      stopIcon.style.display = 'block';
      toggleBtn.classList.add('is-recording');
    } catch (e) {
      console.error('Recording error:', e);
    }
  }

  function stopRecording() {
    if (mediaRecorder) mediaRecorder.stop();
    if (stream) stream.getTracks().forEach(t => t.stop());
    cancelAnimationFrame(animFrame);
    clearInterval(timerInterval);
    audioLevelEl.style.display = 'none';
    bars.forEach(b => { b.style.height = '3px'; b.style.opacity = '0.15'; });

    recBtn.classList.remove('recording');
    micIcon.style.display = 'block';
    stopIcon.style.display = 'none';
    toggleBtn.classList.remove('is-recording');
    mediaRecorder = null;
    stream = null;
  }

  recBtn.addEventListener('click', () => {
    if (!mediaRecorder) startRecording();
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
    renderTranscripts();
  });
})();
