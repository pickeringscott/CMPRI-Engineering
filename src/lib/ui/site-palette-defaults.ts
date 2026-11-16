// Generated from site-palette.json; shared header/modal defaults and token names.
export const sitePalette = {
  "accents": [
    {
      "name": "apricot",
      "rgb": "243,187,117"
    },
    {
      "name": "orchid",
      "rgb": "207,144,254"
    },
    {
      "name": "coral",
      "rgb": "254,139,156"
    },
    {
      "name": "sky",
      "rgb": "98,181,241"
    },
    {
      "name": "lemon",
      "rgb": "239,230,83"
    },
    {
      "name": "mint",
      "rgb": "117,223,180"
    }
  ],
  "maintenance": "0,212,146",
  "modalBase": "#181818",
  "special": {
    "create": {
      "rgb": "148,180,206",
      "base": "#101319"
    },
    "detail": {
      "rgb": "162,171,209",
      "base": "#11131a"
    },
    "hours": {
      "rgb": "142,189,170",
      "base": "#101512"
    }
  },
  "signOut": {
    "rgb": "200,100,115",
    "background": "#2a1721",
    "border": "#73333e",
    "text": "#fecaca"
  },
  "semantic": {
    "gold": "#fbbf24",
    "gold-light": "#fcd34d",
    "reply-gold": "#c9b66e",
    "link": "#7dd3fc",
    "link-hover": "#bae6fd",
    "control-rgb": "56,189,248",
    "white": "#ffffff",
    "black": "#000000",
    "pending": "#d8b4fe",
    "open": "#86efac",
    "progress": "#fde047",
    "priority": "#fca5a5",
    "overdue": "#fdba74",
    "completed": "#93c5fd",
    "closed": "#cbd5e1",
    "all": "#f1f5f9",
    "modal-text": "rgb(253,243,230)"
  },
  "desktop": {
    "tone-1": "#0b1423",
    "tone-2": "#13233a",
    "tone-3": "#20344c",
    "tone-4": "#334b64",
    "tone-5": "#4d657d",
    "tone-6": "#6f879d",
    "tone-7": "#96a9b9",
    "tone-8": "#bdcad4",
    "tone-9": "#dce4e9",
    "tone-10": "#f3f5f2",
    "tone-11": "#c0d2e0",
    "tone-12": "#f2cc63",
    "tone-13": "#081321",
    "tone-14": "#13233af5",
    "tone-15": "#0b1728f5",
    "tone-16": "#ba773e",
    "tone-17": "#172b42",
    "tone-18": "#5c351d",
    "tone-19": "#ffe0a3",
    "tone-20": "#9a8256",
    "tone-21": "#546c82",
    "tone-22": "#edf1e9",
    "tone-23": "#332213",
    "tone-24": "#b16633",
    "tone-25": "#ffe2bd",
    "tone-26": "#ed8a37",
    "tone-27": "#ffbd72",
    "tone-28": "#20180d",
    "action-rgb": "237,138,55",
    "sign-out-rgb": "167,101,73"
  }
} as const;
export const sitePaletteTokens = {
  "modal-base": "#181818",
  "maintenance": "0,212,146",
  "maintenance-text": "rgb(209,247,235)",
  "gold": "#fbbf24",
  "gold-light": "#fcd34d",
  "reply-gold": "#c9b66e",
  "link": "#7dd3fc",
  "link-hover": "#bae6fd",
  "control-rgb": "56,189,248",
  "white": "#ffffff",
  "black": "#000000",
  "pending": "#d8b4fe",
  "open": "#86efac",
  "progress": "#fde047",
  "priority": "#fca5a5",
  "overdue": "#fdba74",
  "completed": "#93c5fd",
  "closed": "#cbd5e1",
  "all": "#f1f5f9",
  "modal-text": "rgb(253,243,230)",
  "desktop-tone-1": "#0b1423",
  "desktop-tone-2": "#13233a",
  "desktop-tone-3": "#20344c",
  "desktop-tone-4": "#334b64",
  "desktop-tone-5": "#4d657d",
  "desktop-tone-6": "#6f879d",
  "desktop-tone-7": "#96a9b9",
  "desktop-tone-8": "#bdcad4",
  "desktop-tone-9": "#dce4e9",
  "desktop-tone-10": "#f3f5f2",
  "desktop-tone-11": "#c0d2e0",
  "desktop-tone-12": "#f2cc63",
  "desktop-tone-13": "#081321",
  "desktop-tone-14": "#13233af5",
  "desktop-tone-15": "#0b1728f5",
  "desktop-tone-16": "#ba773e",
  "desktop-tone-17": "#172b42",
  "desktop-tone-18": "#5c351d",
  "desktop-tone-19": "#ffe0a3",
  "desktop-tone-20": "#9a8256",
  "desktop-tone-21": "#546c82",
  "desktop-tone-22": "#edf1e9",
  "desktop-tone-23": "#332213",
  "desktop-tone-24": "#b16633",
  "desktop-tone-25": "#ffe2bd",
  "desktop-tone-26": "#ed8a37",
  "desktop-tone-27": "#ffbd72",
  "desktop-tone-28": "#20180d",
  "desktop-action-rgb": "237,138,55",
  "desktop-sign-out-rgb": "167,101,73",
  "apricot-rgb": "243,187,117",
  "apricot-text": "rgb(253,243,230)",
  "orchid-rgb": "207,144,254",
  "orchid-text": "rgb(246,235,255)",
  "coral-rgb": "254,139,156",
  "coral-text": "rgb(255,234,237)",
  "sky-rgb": "98,181,241",
  "sky-text": "rgb(227,242,252)",
  "lemon-rgb": "239,230,83",
  "lemon-text": "rgb(252,251,224)",
  "mint-rgb": "117,223,180",
  "mint-text": "rgb(230,249,242)",
  "create-rgb": "148,180,206",
  "create-base": "#101319",
  "detail-rgb": "162,171,209",
  "detail-base": "#11131a",
  "hours-rgb": "142,189,170",
  "hours-base": "#101512",
  "sign-out-rgb": "200,100,115",
  "sign-out-background": "#2a1721",
  "sign-out-border": "#73333e",
  "sign-out-text": "#fecaca"
} as const;
export function paletteToken(name: string, fallback: string): string { return `var(--cmpri-palette-${name},${fallback})`; }
