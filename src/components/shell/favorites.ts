"use client";

import { useSyncExternalStore } from "react";

export const FAVORITES_KEY = "aws-console-favorites";
const CHANGE_EVENT = "aws-favorites-change";
const DEFAULT_FAVORITES = ["s3", "ec2", "lambda", "sqs", "dynamodb", "iam", "cloudwatch"];

let cache: { raw: string | null; list: string[] } = { raw: null, list: DEFAULT_FAVORITES };

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === FAVORITES_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function snapshot(): string[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(FAVORITES_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cache.raw) {
    if (raw === null) {
      cache = { raw: null, list: DEFAULT_FAVORITES };
    } else {
      try {
        const parsed: unknown = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : DEFAULT_FAVORITES;
        cache = { raw, list };
      } catch {
        cache = { raw, list: DEFAULT_FAVORITES };
      }
    }
  }
  return cache.list;
}

export function useFavorites(): { favorites: string[]; toggleFavorite: (id: string) => void } {
  const favorites = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_FAVORITES);

  function toggleFavorite(id: string) {
    const next = favorites.includes(id) ? favorites.filter((x) => x !== id) : [...favorites, id];
    try {
      window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage errors in restricted environments.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return { favorites, toggleFavorite };
}
