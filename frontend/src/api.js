const KEY = "careloop_token";
export const getToken = () => sessionStorage.getItem(KEY);
export const setToken = (t) => (t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY));

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && path !== "/auth/login") {
    setToken(null);
    window.dispatchEvent(new Event("careloop:logout"));
  }
  if (!res.ok) throw new Error((data && data.error) || "Something went wrong. Try again.");
  return data;
}
