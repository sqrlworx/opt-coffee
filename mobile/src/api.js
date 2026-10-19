// The off hours server's JSON API, on the same origin (the server serves this app at /m/).

// `body` is sent as JSON, or as-is if it's a Blob (a recorded video). `timeout` (ms) gives up on a
// request that hangs.
export async function api(method, path, body, { timeout } = {}) {
  const blob = typeof Blob !== 'undefined' && body instanceof Blob;
  const res = await fetch(path, {
    method,
    headers: blob ? { 'Content-Type': body.type.split(';')[0] } : body ? { 'Content-Type': 'application/json' } : {},
    body: blob ? body : body ? JSON.stringify(body) : undefined,
    signal: timeout ? AbortSignal.timeout(timeout) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Like api() with a Blob, for a file the user picked: tells `progress` how much of it has gone, from
// 0 to 1, which fetch can't. Aborting `signal` stops sending it (rejecting with an AbortError).
export function sendFile(method, path, file, { progress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && progress?.(e.loaded / e.total);
    xhr.upload.onload = () => progress?.(1);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.response ?? {});
      const err = new Error(xhr.response?.error ?? `Request failed (${xhr.status})`);
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error("Couldn't send it. Check your connection and try again."));
    xhr.onabort = () => reject(new DOMException('Stopped', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
