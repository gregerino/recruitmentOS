// Speaker-diarized transcription via AssemblyAI.
const https = require('https');
const { readAudioRequest } = require('./_guards');

// A WebM/Opus recording runs roughly 180 KB per minute, so this covers
// a long interview while keeping a stray upload out of the function's
// memory. Note Vercel caps request bodies at 4.5 MB before this is
// reached — see README.
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_REQUESTS_PER_MINUTE = 6;

module.exports = async function handler(req, res) {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'ASSEMBLYAI_API_KEY not configured', code: 'not_configured' });
  }

  const request = await readAudioRequest(req, res, {
    maxBytes: MAX_AUDIO_BYTES,
    maxRequests: MAX_REQUESTS_PER_MINUTE,
  });
  if (!request) return;

  try {
    const uploadUrl = await uploadAudio(apiKey, request.filePart.data);
    const transcriptId = await createTranscript(apiKey, uploadUrl);
    const result = await pollTranscript(apiKey, transcriptId);
    return res.status(200).json(result);
  } catch (e) {
    console.error('transcribe-assembly failed:', e && e.message);
    return res.status(502).json({ error: e.message || 'Transcription failed', code: 'transcription_failed' });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};

function apiRequest(method, path, apiKey, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.assemblyai.com',
      path,
      method,
      headers: {
        'authorization': apiKey,
        'content-type': body ? 'application/json' : undefined,
      },
    };
    if (!options.headers['content-type']) delete options.headers['content-type'];

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (res.statusCode >= 400) reject(new Error(data.error || `HTTP ${res.statusCode}`));
        else resolve(data);
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function uploadAudio(apiKey, audioBuffer) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.assemblyai.com',
      path: '/v2/upload',
      method: 'POST',
      headers: {
        'authorization': apiKey,
        'content-type': 'application/octet-stream',
        'transfer-encoding': 'chunked',
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (res.statusCode >= 400) reject(new Error(data.error || 'Upload failed'));
        else resolve(data.upload_url);
      });
    });
    req.on('error', reject);
    req.write(audioBuffer);
    req.end();
  });
}

async function createTranscript(apiKey, audioUrl) {
  const data = await apiRequest('POST', '/v2/transcript', apiKey, {
    audio_url: audioUrl,
    speaker_labels: true,
    speakers_expected: 2,
    language_code: 'sv',
  });
  return data.id;
}

async function pollTranscript(apiKey, transcriptId) {
  const maxAttempts = 120;
  for (let i = 0; i < maxAttempts; i++) {
    const data = await apiRequest('GET', `/v2/transcript/${transcriptId}`, apiKey);
    if (data.status === 'completed') {
      return formatResult(data);
    }
    if (data.status === 'error') {
      throw new Error(data.error || 'Transcription failed');
    }
    await sleep(1000);
  }
  throw new Error('Transcription timed out');
}

function formatResult(data) {
  if (!data.utterances || data.utterances.length === 0) {
    return { text: data.text || '', utterances: [] };
  }

  const speakerMap = {};
  let nextNum = 1;

  const utterances = data.utterances.map(u => {
    if (!speakerMap[u.speaker]) {
      speakerMap[u.speaker] = `Röst ${nextNum}`;
      nextNum++;
    }
    return {
      speaker: speakerMap[u.speaker],
      text: u.text,
    };
  });

  const formatted = utterances.map(u => `[${u.speaker}]: ${u.text}`).join('\n');
  return { text: formatted, utterances };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

