export async function readJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    if (!response.ok) {
      throw new Error(`The server returned a non-JSON response (HTTP ${response.status}).`);
    }
    throw new Error(`The server returned invalid JSON (HTTP ${response.status}).`);
  }
}
