export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('x-user-id')) {
    headers.set('x-user-id', 'default');
  }

  return fetch(input, {
    ...init,
    headers,
  });
}

export async function parseJsonResponse<T = any>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    if (contentType.includes('application/json')) {
      try {
        const data = await res.json();
        throw new Error(data.error || `Server error (${res.status})`);
      } catch (e: any) {
        if (e.message && !e.message.startsWith('Unexpected')) throw e;
      }
    }
    if (res.status === 404) {
      throw new Error(`Backend route not found (404). If deployed on Netlify or a static host, please note that Steam idling requires an active Node.js server (server.ts) on a server host like Cloud Run, Render, or Railway.`);
    }
    throw new Error(`Server returned HTTP ${res.status} (${res.statusText || 'Error'})`);
  }

  if (!contentType.includes('application/json')) {
    const text = await res.text();
    if (!text || !text.trim()) {
      throw new Error(`Empty response from backend server. If deployed on Netlify or a static host, please deploy to a Node.js host (Cloud Run, Render, Railway) as Steam idling requires a persistent Node backend server.`);
    }
    throw new Error(`Expected JSON from backend server, but received non-JSON response.`);
  }

  try {
    return await res.json();
  } catch (err: any) {
    throw new Error(`Failed to parse JSON from backend response: ${err.message}`);
  }
}

