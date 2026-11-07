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
    "tone-1": "#241a14",
    "tone-2": "#302117",
    "tone-3": "#493321",
    "tone-4": "#694c32",
    "tone-5": "#8b6847",
    "tone-6": "#ad8b61",
    "tone-7": "#c6a881",
    "tone-8": "#dfc6a5",
    "tone-9": "#efdec6",
    "tone-10": "#fff0d6",
    "tone-11": "#dbc4a0",
    "tone-12": "#f4c477",
    "tone-13": "#271b14",
    "tone-14": "#302117f5",
    "tone-15": "#211911f5",
    "tone-16": "#9a7046",
    "tone-17": "#322319",
    "tone-18": "#694726",
    "tone-19": "#ffdb91",
    "tone-20": "#9e784e",
    "tone-21": "#765137",
    "tone-22": "#ffe8c7",
    "tone-23": "#562b20",
    "tone-24": "#a76549",
    "tone-25": "#ffd3b5",
    "tone-26": "#dfac51",
    "tone-27": "#f6c472",
    "tone-28": "#24180f",
    "action-rgb": "198,136,71",
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
  "desktop-tone-1": "#241a14",
  "desktop-tone-2": "#302117",
  "desktop-tone-3": "#493321",
  "desktop-tone-4": "#694c32",
  "desktop-tone-5": "#8b6847",
  "desktop-tone-6": "#ad8b61",
  "desktop-tone-7": "#c6a881",
  "desktop-tone-8": "#dfc6a5",
  "desktop-tone-9": "#efdec6",
  "desktop-tone-10": "#fff0d6",
  "desktop-tone-11": "#dbc4a0",
  "desktop-tone-12": "#f4c477",
  "desktop-tone-13": "#271b14",
  "desktop-tone-14": "#302117f5",
  "desktop-tone-15": "#211911f5",
  "desktop-tone-16": "#9a7046",
  "desktop-tone-17": "#322319",
  "desktop-tone-18": "#694726",
  "desktop-tone-19": "#ffdb91",
  "desktop-tone-20": "#9e784e",
  "desktop-tone-21": "#765137",
  "desktop-tone-22": "#ffe8c7",
  "desktop-tone-23": "#562b20",
  "desktop-tone-24": "#a76549",
  "desktop-tone-25": "#ffd3b5",
  "desktop-tone-26": "#dfac51",
  "desktop-tone-27": "#f6c472",
  "desktop-tone-28": "#24180f",
  "desktop-action-rgb": "198,136,71",
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
