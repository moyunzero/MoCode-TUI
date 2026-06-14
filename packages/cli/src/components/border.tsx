// Border glyph set borrowed from opencode; empty sides hide box edges.

export const EmptyBorder = {
    topLeft: "",
    bottomLeft: "",
    vertical: "",
    topRight: "",
    bottomRight: "",
    horizontal: " ",
    bottomT: "",
    topT: "",
    cross: "",
    leftT: "",
    rightT: "",
  };
  
  export const SplitBorderChars = {
    ...EmptyBorder,
    vertical: "┃",
  };