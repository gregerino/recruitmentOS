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

  // Web Speech API (real-time)
  let recognition = null;
  let liveTranscripts = [];
  let interimText = '';

  // MediaRecorder (for AssemblyAI)
  let mediaRecorder = null;
  let micStream = null;
  let analyser = null;
  let animFrame = 0;
  let recordedChunks = [];

  // Track where live text starts in the textarea
  let textBeforeRecording = '';

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

  // Setting .value in code does not fire an input event, so autosave
  // would never see transcribed text. Dispatch one explicitly.
  function setNotesValue(textarea, value) {
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function setStatus(status) {
    statusEl.style.display = 'flex';
    badgeEl.className = 'rec-badge ' + status;
    if (status === 'recording') {
      badgeEl.textContent = 'Lyssnar...';
      if (labelEl) labelEl.style.display = 'none';
    } else if (status === 'transcribing') {
      badgeEl.textContent = 'Analyserar röster...';
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

  // Render live transcript into textarea
  function renderLive() {
    const textarea = getNotesTextarea();
    if (!textarea) return;
    const parts = liveTranscripts.slice();
    if (interimText) parts.push(interimText);
    const liveText = parts.join(' ');
    textarea.value = textBeforeRecording
      ? textBeforeRecording + '\n' + liveText
      : liveText;
    textarea.scrollTop = textarea.scrollHeight;
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

  // ─── Web Speech API (real-time feedback) ───
  function startSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

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
          if (text) liveTranscripts.push(text);
          interimText = '';
        } else {
          interim += result[0].transcript;
        }
      }
      if (interim) interimText = interim;
      renderLive();
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') return;
      console.error('Speech recognition error:', event.error);
    };

    recognition.onend = () => {
      if (isRecording) {
        try { recognition.start(); } catch (e) { /* already started */ }
      }
    };

    recognition.start();
  }

  function stopSpeechRecognition() {
    if (recognition) {
      recognition.onend = null;
      recognition.stop();
      recognition = null;
    }
    if (interimText.trim()) {
      liveTranscripts.push(interimText.trim());
      interimText = '';
      renderLive();
    }
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

    const textarea = getNotesTextarea();
    textBeforeRecording = textarea ? textarea.value.trim() : '';
    liveTranscripts = [];
    interimText = '';
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

    // Start real-time speech recognition
    startSpeechRecognition();

    // Start recording for AssemblyAI
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
      } else {
        setStatus('idle');
        recBtn.disabled = false;
      }
    };

    mediaRecorder.start(1000);
  }

  function stopRecording() {
    isRecording = false;
    clearInterval(timerInterval);
    stopLevelMonitor();
    stopSpeechRecognition();

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

  // ─── AssemblyAI (diarized final result) ───
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
        // Replace live text with diarized version
        setNotesValue(textarea, textBeforeRecording
          ? textBeforeRecording + '\n\n' + data.text
          : data.text);
        textarea.scrollTop = textarea.scrollHeight;
      }
      // Hand the speaker-labelled turns to the app so it can save them
      // and match passages against the competencies.
      if (window.RecruitmentOS && window.RecruitmentOS.onTranscript) {
        window.RecruitmentOS.onTranscript(data);
      }
    } catch (e) {
      console.error('AssemblyAI error:', e);
      // Keep the live text as fallback — don't overwrite it, but still
      // make sure it gets saved
      const textarea = getNotesTextarea();
      if (textarea) textarea.dispatchEvent(new Event('input', { bubbles: true }));
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
