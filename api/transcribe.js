import OpenAI from 'openai';
import { Readable } from 'stream';

export const config = {
  api: { bodyParser: false },
};

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
    const body = part.slice(headerEnd + 4, part.length - 2); // strip trailing \r\n

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  // Read raw body
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  // Parse boundary from content-type
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) {
    return res.status(400).json({ error: 'Missing boundary in content-type' });
  }

  const parts = parseMultipart(body, boundaryMatch[1]);
  const filePart = parts.find(p => p.isFile);
  if (!filePart) {
    return res.status(400).json({ error: 'No audio file found' });
  }

  // Build a File object for the OpenAI SDK
  const file = new File([filePart.data], filePart.filename || 'audio.webm', {
    type: 'audio/webm',
  });

  const openai = new OpenAI({ apiKey });

  const prompt = parts.find(p => p.name === 'prompt')?.data.toString() || '';
  const language = parts.find(p => p.name === 'language')?.data.toString() || 'sv';

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language,
    response_format: 'json',
    prompt,
  });

  return res.status(200).json({ text: transcription.text });
}
