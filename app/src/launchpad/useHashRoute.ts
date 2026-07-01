/// Tiny hash-based router for the launchpad SPA. Hash routing works identically
/// whether the app is served at the subdomain root (launchpad.openperps.fun/#/...)
/// or a local path (localhost/launchpad#/...), so no router basepath juggling.

import { useState, useEffect, useCallback } from "react";

export type LpRoute =
  | { name: "home" }
  | { name: "create" }
  | { name: "coin"; mint: string }
  | { name: "profile"; address?: string };

function parse(): LpRoute {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (h.startsWith("coin/")) return { name: "coin", mint: decodeURIComponent(h.slice(5)) };
  if (h.startsWith("profile/")) return { name: "profile", address: decodeURIComponent(h.slice(8)) };
  if (h === "profile") return { name: "profile" };
  if (h === "create") return { name: "create" };
  return { name: "home" };
}

export function useHashRoute(): [LpRoute, (to: string) => void] {
  const [route, setRoute] = useState<LpRoute>(parse);
  useEffect(() => {
    const on = () => {
      setRoute(parse());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const nav = useCallback((to: string) => {
    window.location.hash = to.startsWith("#") ? to : `#${to}`;
  }, []);
  return [route, nav];
}
