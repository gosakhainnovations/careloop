
const KEY = "careloop_token";

// Use the deployed backend URL in production.
// If not configured, use the relative URL for local development.
const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

export const getToken = () => sessionStorage.getItem(KEY);

export const setToken = (t) =>
  t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY);

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }

  if (res.status === 401 && path !== "/auth/login") {
    setToken(null);
    window.dispatchEvent(new Event("careloop:logout"));
  }

  if (!res.ok) {
    throw new Error((data && data.error) || "Something went wrong. Try again.");
  }

  return data;
}
