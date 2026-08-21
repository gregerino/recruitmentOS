// Plain transcription via OpenAI Whisper — the fallback path.
const OpenAI = require('openai').default;
const { readAudioRequest } = require('./_guards');

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_REQUESTS_PER_MINUTE = 6;

module.exports = async function handler(req, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'OPENAI_API_KEY not configured', code: 'not_configured' });
  }

  const request = await readAudioRequest(req, res, {
    maxBytes: MAX_AUDIO_BYTES,
    maxRequests: MAX_REQUESTS_PER_MINUTE,
  });
  if (!request) return;

  const { parts, filePart } = request;

  const file = new File([filePart.data], filePart.filename || 'audio.webm', {
    type: 'audio/webm',
  });

  const openai = new OpenAI({ apiKey });

  const prompt = parts.find(p => p.name === 'prompt')?.data.toString() || '';
  const language = parts.find(p => p.name === 'language')?.data.toString() || 'sv';

  try {
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language,
      response_format: 'json',
      prompt,
    });
    return res.status(200).json({ text: transcription.text });
  } catch (e) {
    console.error('transcribe failed:', e && e.message);
    return res.status(502).json({ error: e.message || 'Transcription failed', code: 'transcription_failed' });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};

