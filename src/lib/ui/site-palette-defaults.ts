// Generated from site-palette.json; shared header/modal defaults and token names.
export const sitePalette = {
  "accents": [
    {
      "name": "apricot",
      "rgb": "255,95,5"
    },
    {
      "name": "orchid",
      "rgb": "255,205,0"
    },
    {
      "name": "coral",
      "rgb": "255,125,56"
    },
    {
      "name": "sky",
      "rgb": "255,218,64"
    },
    {
      "name": "lemon",
      "rgb": "255,205,0"
    },
    {
      "name": "mint",
      "rgb": "240,112,40"
    }
  ],
  "maintenance": "255,205,0",
  "modalBase": "#101010",
  "special": {
    "create": {
      "rgb": "255,95,5",
      "base": "#0b0b0b"
    },
    "detail": {
      "rgb": "255,205,0",
      "base": "#101010"
    },
    "hours": {
      "rgb": "255,205,0",
      "base": "#0d0d0d"
    }
  },
  "signOut": {
    "rgb": "255,95,5",
    "background": "#2e1609",
    "border": "#b5480b",
    "text": "#ffe4d3"
  },
  "semantic": {
    "gold": "#ffcd00",
    "gold-light": "#ffe066",
    "reply-gold": "#ffcd00",
    "link": "#ffcd00",
    "link-hover": "#ffe682",
    "control-rgb": "255,95,5",
    "white": "#ffffff",
    "black": "#000000",
    "pending": "#ffe066",
    "open": "#ffcd00",
    "progress": "#ffb36b",
    "priority": "#ff7b2b",
    "overdue": "#ff5f05",
    "completed": "#ffe9ad",
    "closed": "#cfcfcf",
    "all": "#fffdf5",
    "modal-text": "rgb(255,248,230)"
  },
  "desktop": {
    "tone-1": "#000000",
    "tone-2": "#101010",
    "tone-3": "#1a1a1a",
    "tone-4": "#333333",
    "tone-5": "#555555",
    "tone-6": "#777777",
    "tone-7": "#999999",
    "tone-8": "#cccccc",
    "tone-9": "#eeeeee",
    "tone-10": "#fff8e6",
    "tone-11": "#ffe4cc",
    "tone-12": "#ffcd00",
    "tone-13": "#000000",
    "tone-14": "#111111f5",
    "tone-15": "#000000f5",
    "tone-16": "#ff5f05",
    "tone-17": "#161616",
    "tone-18": "#3b1e08",
    "tone-19": "#ffcd00",
    "tone-20": "#805009",
    "tone-21": "#5c4c23",
    "tone-22": "#fff8e6",
    "tone-23": "#241008",
    "tone-24": "#ff5f05",
    "tone-25": "#ffe4cc",
    "tone-26": "#ff5f05",
    "tone-27": "#ffcd00",
    "tone-28": "#000000",
    "action-rgb": "255,95,5",
    "sign-out-rgb": "255,95,5"
  }
} as const;
export const sitePaletteTokens = {
  "modal-base": "#101010",
  "maintenance": "255,205,0",
  "maintenance-text": "rgb(255,246,209)",
  "gold": "#ffcd00",
  "gold-light": "#ffe066",
  "reply-gold": "#ffcd00",
  "link": "#ffcd00",
  "link-hover": "#ffe682",
  "control-rgb": "255,95,5",
  "white": "#ffffff",
  "black": "#000000",
  "pending": "#ffe066",
  "open": "#ffcd00",
  "progress": "#ffb36b",
  "priority": "#ff7b2b",
  "overdue": "#ff5f05",
  "completed": "#ffe9ad",
  "closed": "#cfcfcf",
  "all": "#fffdf5",
  "modal-text": "rgb(255,248,230)",
  "desktop-tone-1": "#000000",
  "desktop-tone-2": "#101010",
  "desktop-tone-3": "#1a1a1a",
  "desktop-tone-4": "#333333",
  "desktop-tone-5": "#555555",
  "desktop-tone-6": "#777777",
  "desktop-tone-7": "#999999",
  "desktop-tone-8": "#cccccc",
  "desktop-tone-9": "#eeeeee",
  "desktop-tone-10": "#fff8e6",
  "desktop-tone-11": "#ffe4cc",
  "desktop-tone-12": "#ffcd00",
  "desktop-tone-13": "#000000",
  "desktop-tone-14": "#111111f5",
  "desktop-tone-15": "#000000f5",
  "desktop-tone-16": "#ff5f05",
  "desktop-tone-17": "#161616",
  "desktop-tone-18": "#3b1e08",
  "desktop-tone-19": "#ffcd00",
  "desktop-tone-20": "#805009",
  "desktop-tone-21": "#5c4c23",
  "desktop-tone-22": "#fff8e6",
  "desktop-tone-23": "#241008",
  "desktop-tone-24": "#ff5f05",
  "desktop-tone-25": "#ffe4cc",
  "desktop-tone-26": "#ff5f05",
  "desktop-tone-27": "#ffcd00",
  "desktop-tone-28": "#000000",
  "desktop-action-rgb": "255,95,5",
  "desktop-sign-out-rgb": "255,95,5",
  "apricot-rgb": "255,95,5",
  "apricot-text": "rgb(255,226,210)",
  "orchid-rgb": "255,205,0",
  "orchid-text": "rgb(255,246,209)",
  "coral-rgb": "255,125,56",
  "coral-text": "rgb(255,232,219)",
  "sky-rgb": "255,218,64",
  "sky-text": "rgb(255,248,221)",
  "lemon-rgb": "255,205,0",
  "lemon-text": "rgb(255,246,209)",
  "mint-rgb": "240,112,40",
  "mint-text": "rgb(252,229,216)",
  "create-rgb": "255,95,5",
  "create-base": "#0b0b0b",
  "detail-rgb": "255,205,0",
  "detail-base": "#101010",
  "hours-rgb": "255,205,0",
  "hours-base": "#0d0d0d",
  "sign-out-rgb": "255,95,5",
  "sign-out-background": "#2e1609",
  "sign-out-border": "#b5480b",
  "sign-out-text": "#ffe4d3"
} as const;
export function paletteToken(name: string, fallback: string): string { return `var(--cmpri-palette-${name},${fallback})`; }
