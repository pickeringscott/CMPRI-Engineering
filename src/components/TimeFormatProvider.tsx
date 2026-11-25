"use client";

import { createContext, useContext } from "react";
import type { TimeFormat } from "@/lib/profile-preferences";

export const TimeFormatContext = createContext<TimeFormat>("12h");

export function useTimeFormat(): TimeFormat {
  return useContext(TimeFormatContext);
}
