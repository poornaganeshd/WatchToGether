import { useSyncExternalStore } from "react";

/** Live result of a CSS media query. */
export const useMediaQuery = (query: string) =>
  useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false
  );

/** Phones (and small tablets in portrait): the stacked room layout. Matches Tailwind's `md` breakpoint. */
export const useIsMobile = () => useMediaQuery("(max-width: 767px), (max-height: 500px) and (pointer: coarse)");
