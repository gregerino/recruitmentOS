// ══════════════════════════════════════════════════════════════
//  Shared request guards for the serverless endpoints.
//
//  These are public endpoints on a public domain that spend money
//  per call — an LLM generation, a transcription. None of this is
//  authentication; it is a speed bump that keeps a stray script
//  from draining an API budget. Set an access token to actually
//  close them.
//
//  Vercel does not turn files beginning with "_" into routes.
// ══════════════════════════════════════════════════════════════

const RATE_WINDOW_MS = 60 * 1000;

// Per-instance, so this caps one caller's burst rather than global
// usage — serverless instances do not share memory.
const buckets = new Map();

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

function isRateLimited(req, maxRequests) {
  const ip = clientIp(req);
  const now = Date.now();
  const calls = (buckets.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);

  if (calls.length >= maxRequests) {
    buckets.set(ip, calls);
    return true;
  }

  calls.push(now);
  buckets.set(ip, calls);

  // Keep the map from growing without bound on a long-lived instance
  if (buckets.size > 500) {
    for (const [key, times] of buckets) {
      if (!times.some(t => now - t < RATE_WINDOW_MS)) buckets.delete(key);
    }
  }
  return false;
}

/**
 * Method, access token and rate limit in one call.
 * Responds itself and returns true when the request should not continue.
 *
 * @param options.maxRequests  per-IP calls allowed per minute
 * @param options.tokenEnv     endpoint-specific token variable; API_ACCESS_TOKEN
 *                             locks every endpoint at once
 */
function rejected(req, res, options) {
  const opts = options || {};

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed', code: 'method_not_allowed' });
    return true;
  }

  const required = process.env.API_ACCESS_TOKEN
    || (opts.tokenEnv ? process.env[opts.tokenEnv] : null);
  if (required && req.headers['x-ros-token'] !== required) {
    res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
    return true;
  }

  if (isRateLimited(req, opts.maxRequests || 10)) {
    res.status(429).json({ error: 'Too many requests, try again in a minute', code: 'rate_limited' });
    return true;
  }

  return false;
}

/**
 * Reads the request body with a hard ceiling. Without one, a single
 * large POST is read straight into the function's memory.
 * Rejects with err.code = 'too_large' past the limit.
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('Request body too large');
        err.code = 'too_large';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function readJsonBody(req, maxBytes) {
  const raw = await readBody(req, maxBytes);
  try {
    return JSON.parse(raw.toString('utf8') || '{}');
  } catch (e) {
    const err = new Error('Invalid JSON body');
    err.code = 'bad_request';
    throw err;
  }
}

// Multipart parsing is shared by both transcription endpoints.
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

/**
 * Everything the transcription endpoints do before talking to a
 * provider: guards, capped read, multipart parse, audio part found.
 * Responds itself and returns null when the request is finished.
 */
async function readAudioRequest(req, res, options) {
  const opts = options || {};

  if (rejected(req, res, { maxRequests: opts.maxRequests, tokenEnv: 'TRANSCRIBE_ACCESS_TOKEN' })) {
    return null;
  }

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    res.status(400).json({ error: 'Expected multipart/form-data', code: 'bad_request' });
    return null;
  }

  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) {
    res.status(400).json({ error: 'Missing boundary', code: 'bad_request' });
    return null;
  }

  let body;
  try {
    body = await readBody(req, opts.maxBytes);
  } catch (e) {
    const tooLarge = e.code === 'too_large';
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge
        ? `Recording is too large (limit ${Math.round(opts.maxBytes / (1024 * 1024))} MB)`
        : 'Could not read request body',
      code: e.code || 'bad_request',
    });
    return null;
  }

  const parts = parseMultipart(body, boundaryMatch[1]);
  const filePart = parts.find(p => p.isFile);
  if (!filePart) {
    res.status(400).json({ error: 'No audio file found', code: 'bad_request' });
    return null;
  }
  if (!filePart.data || filePart.data.length < 1024) {
    res.status(400).json({ error: 'Audio file is empty', code: 'bad_request' });
    return null;
  }

  return { parts, filePart };
}

module.exports = { rejected, readBody, readJsonBody, parseMultipart, readAudioRequest };
