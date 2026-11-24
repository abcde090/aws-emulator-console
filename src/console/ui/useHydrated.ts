"use client";

import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/**
 * False during server rendering and hydration, true once React runs in the browser.
 * Controls whose click handlers need React (Actions menus, form submits) stay disabled
 * until then, so an early click is never silently lost.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false
  );
}
