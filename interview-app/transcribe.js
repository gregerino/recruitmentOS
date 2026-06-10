function initTranscribe() {
  const recBtn = document.getElementById('rec-btn');
  const micIcon = document.getElementById('rec-mic-icon');
  const stopIcon = document.getElementById('rec-stop-icon');
  const audioLevelEl = document.getElementById('audio-level');
  const statusEl = document.getElementById('rec-status');
  const badgeEl = document.getElementById('rec-badge');
  const timerEl = document.getElementById('rec-timer');
  const sourceBtns = document.querySelectorAll('.source-btn');

  if (!recBtn) return;

  let source = 'microphone';
  let isRecording = false;
  let timerInterval = null;
  let elapsed = 0;
  let transcripts = [];
  let interimText = '';
  const BAR_COUNT = 24;

  let recognition = null;
  let micStream = null;
  let analyser = null;
  let animFrame = 0;

  let mediaRecorder = null;
  let systemStream = null;
  let pendingChunks = 0;
  const CHUNK_MS = 2000;

  // Build audio level bars
  if (audioLevelEl) {
    for (let i = 0; i < BAR_COUNT; i++) {
      const bar = document.createElement('div');
      bar.className = 'audio-bar';
      bar.style.height = '3px';
      audioLevelEl.appendChild(bar);
    }
  }
  const bars = audioLevelEl ? audioLevelEl.querySelectorAll('.audio-bar') : [];

  // Source toggle
  sourceBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (isRecording) return;
      sourceBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      source = btn.dataset.source;
    });
  });

  function getNotesTextarea() {
    return document.getElementById('interview-notes');
  }

  function appendToNotes(text) {
    const textarea = getNotesTextarea();
    if (!textarea || !text) return;
    const current = textarea.value;
    if (current && !current.endsWith('\n') && !current.endsWith(' ')) {
      textarea.value = current + ' ' + text;
    } else {
      textarea.value = current + text;
    }
    textarea.scrollTop = textarea.scrollHeight;
  }

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
    if (audioLevelEl) audioLevelEl.style.display = 'none';
    bars.forEach(b => { b.style.height = '3px'; b.style.opacity = '0.15'; });
  }

  // ─── Web Speech API (microphone — instant) ───
  function startSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      startWhisperRecording('microphone');
      return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'sv-SE';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (text) {
            transcripts.push(text);
            appendToNotes(text);
          }
          interimText = '';
        } else {
          interimText = result[0].transcript;
        }
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') return;
      console.error('Speech recognition error:', event.error);
    };

    recognition.onend = () => {
      if (isRecording && source === 'microphone') {
        try { recognition.start(); } catch (e) { /* already started */ }
      }
    };

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      micStream = stream;
      startLevelMonitor(stream);
      if (audioLevelEl) audioLevelEl.style.display = 'flex';
    }).catch(() => {});

    recognition.start();
  }

  function stopSpeechRecognition() {
    if (recognition) {
      recognition.onend = null;
      recognition.stop();
      recognition = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    if (interimText.trim()) {
      transcripts.push(interimText.trim());
      appendToNotes(interimText.trim());
      interimText = '';
    }
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
        appendToNotes(data.text.trim());
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
      if (audioLevelEl) audioLevelEl.style.display = 'flex';

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
}
