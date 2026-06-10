function initTranscribe() {
  const recBtn = document.getElementById('rec-btn');
  const micIcon = document.getElementById('rec-mic-icon');
  const stopIcon = document.getElementById('rec-stop-icon');
  const audioLevelEl = document.getElementById('audio-level');
  const statusEl = document.getElementById('rec-status');
  const badgeEl = document.getElementById('rec-badge');
  const timerEl = document.getElementById('rec-timer');
  const labelEl = document.getElementById('rec-label');

  if (!recBtn) return;

  let isRecording = false;
  let timerInterval = null;
  let elapsed = 0;
  const BAR_COUNT = 24;

  let mediaRecorder = null;
  let micStream = null;
  let analyser = null;
  let animFrame = 0;
  let recordedChunks = [];

  if (audioLevelEl) {
    for (let i = 0; i < BAR_COUNT; i++) {
      const bar = document.createElement('div');
      bar.className = 'audio-bar';
      bar.style.height = '3px';
      audioLevelEl.appendChild(bar);
    }
  }
  const bars = audioLevelEl ? audioLevelEl.querySelectorAll('.audio-bar') : [];

  function getNotesTextarea() {
    return document.getElementById('interview-notes');
  }

  function setStatus(status) {
    statusEl.style.display = 'flex';
    badgeEl.className = 'rec-badge ' + status;
    if (status === 'recording') {
      badgeEl.textContent = 'Spelar in...';
      if (labelEl) labelEl.style.display = 'none';
    } else if (status === 'transcribing') {
      badgeEl.textContent = 'Transkriberar...';
      if (labelEl) labelEl.style.display = 'none';
    } else {
      badgeEl.textContent = '';
      statusEl.style.display = 'none';
      if (labelEl) labelEl.style.display = '';
    }
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

  // ─── Recording ───
  async function startRecording() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000 }
      });
    } catch (e) {
      console.error('Microphone access denied:', e);
      return;
    }

    recordedChunks = [];
    isRecording = true;
    elapsed = 0;
    timerEl.textContent = '00:00';
    timerInterval = setInterval(() => { elapsed++; timerEl.textContent = formatTime(elapsed); }, 1000);
    setStatus('recording');

    recBtn.classList.add('recording');
    micIcon.style.display = 'none';
    stopIcon.style.display = 'block';

    startLevelMonitor(micStream);
    if (audioLevelEl) audioLevelEl.style.display = 'flex';

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';
    mediaRecorder = new MediaRecorder(micStream, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
      if (blob.size > 500) {
        sendToAssemblyAI(blob);
      }
    };

    mediaRecorder.start(1000);
  }

  function stopRecording() {
    isRecording = false;
    clearInterval(timerInterval);
    stopLevelMonitor();

    recBtn.classList.remove('recording');
    micIcon.style.display = 'block';
    stopIcon.style.display = 'none';
    recBtn.disabled = true;

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }

    setStatus('transcribing');
  }

  // ─── AssemblyAI ───
  async function sendToAssemblyAI(blob) {
    try {
      const formData = new FormData();
      formData.append('file', blob, 'interview.webm');

      const res = await fetch('/api/transcribe-assembly', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const textarea = getNotesTextarea();
      if (textarea && data.text) {
        const current = textarea.value.trim();
        textarea.value = current
          ? current + '\n\n' + data.text
          : data.text;
        textarea.scrollTop = textarea.scrollHeight;
      }
    } catch (e) {
      console.error('AssemblyAI transcription error:', e);
      const textarea = getNotesTextarea();
      if (textarea) {
        const current = textarea.value.trim();
        textarea.value = current
          ? current + '\n\n[Transkribering misslyckades: ' + e.message + ']'
          : '[Transkribering misslyckades: ' + e.message + ']';
      }
    } finally {
      setStatus('idle');
      recBtn.disabled = false;
    }
  }

  recBtn.addEventListener('click', () => {
    if (!isRecording) startRecording();
    else stopRecording();
  });
}
