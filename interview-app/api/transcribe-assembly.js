const https = require('https');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not configured' });
  }

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return res.status(400).json({ error: 'Expected multipart/form-data' });
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) {
    return res.status(400).json({ error: 'Missing boundary' });
  }

  const parts = parseMultipart(body, boundaryMatch[1]);
  const filePart = parts.find(p => p.isFile);
  if (!filePart) {
    return res.status(400).json({ error: 'No audio file found' });
  }

  try {
    const uploadUrl = await uploadAudio(apiKey, filePart.data);
    const transcriptId = await createTranscript(apiKey, uploadUrl);
    const result = await pollTranscript(apiKey, transcriptId);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Transcription failed' });
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

function parseMultipart(buf, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  let start = buf.indexOf(boundaryBuf) + boundaryBuf.length;

  while (start < buf.length) {
    const nextBoundary = buf.indexOf(boundaryBuf, start);
    if (nextBoundary === -1) break;

    const part = buf.slice(start, nextBoundary);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) { start = nextBoundary + boundaryBuf.length; continue; }

    const headers = part.slice(0, headerEnd).toString();
    const body = part.slice(headerEnd + 4, part.length - 2);

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);

    if (nameMatch) {
      parts.push({
        name: nameMatch[1],
        filename: filenameMatch ? filenameMatch[1] : null,
        data: body,
        isFile: !!filenameMatch,
      });
    }
    start = nextBoundary + boundaryBuf.length;
  }
  return parts;
}
