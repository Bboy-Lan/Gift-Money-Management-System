import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { createVaultApi } from "./tauri";

export const VaultScopeContext = createContext({ active: true });

export function useVaultApi(vaultPath: string) {
  const scope = useContext(VaultScopeContext);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return useMemo(() => createVaultApi(vaultPath, () => scope.active && mounted.current), [vaultPath, scope]);
}
