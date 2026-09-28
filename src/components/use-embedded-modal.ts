"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const getSnapshot = () => window.parent !== window;
const getServerSnapshot = () => false;

export default function useEmbeddedModal() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
