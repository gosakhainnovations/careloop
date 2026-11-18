import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, getToken, setToken } from "./api";

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(!!getToken());

  const loadMeta = useCallback(async () => setMeta(await api("/meta")), []);
  useEffect(() => {
    if (!getToken()) return;
    api("/auth/me").then((r) => { setUser(r.user); return loadMeta(); }).catch(() => setToken(null)).finally(() => setLoading(false));
  }, [loadMeta]);
  useEffect(() => {
    const out = () => { setUser(null); setMeta(null); };
    window.addEventListener("careloop:logout", out);
    return () => window.removeEventListener("careloop:logout", out);
  }, []);

  const login = async (email, password) => {
    const r = await api("/auth/login", { method: "POST", body: { email, password } });
    setToken(r.token); setUser(r.user); await loadMeta();
  };
  const logout = () => { setToken(null); setUser(null); setMeta(null); };
  const can = (perm) => !!user && user.permissions.includes(perm);
  return <Ctx.Provider value={{ user, meta, loading, login, logout, can }}>{children}</Ctx.Provider>;
}
