import type { ReactNode } from "react";

const icons = {
  diamond: <path d="M11 3.5a1.5 1.5 0 0 1 2 0l7.5 7.5a1.5 1.5 0 0 1 0 2L13 20.5a1.5 1.5 0 0 1-2 0L3.5 13a1.5 1.5 0 0 1 0-2Z" />,
  ellipse: <circle cx="12" cy="12" r="9" />,
  eraser: <><path d="m14 4 6 6a1.5 1.5 0 0 1 0 2l-8 8H8l-5-5a1.5 1.5 0 0 1 0-2l9-9a1.5 1.5 0 0 1 2 0Z" /><path d="m8 8 8 8M12 20h9" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m3 17 4-4 4 3 4-5 6 6" /></>,
  library: <path d="M12 5.5c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1v-14c-3-1-6-1-9 1Zm0 0v14" />,
  line: <path d="M4 12h16" />,
  lock: <><rect x="4.5" y="10" width="15" height="11" rx="2.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" /></>,
  unlock: <><rect x="4.5" y="10" width="15" height="11" rx="2.5" /><path d="M8 10V7a4 4 0 0 1 7.8-1.25M12 14v3" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  more: <><path d="M12 3 8.5 9h7L12 3Z" /><rect x="3.5" y="13" width="6" height="6" rx="1" /><circle cx="17.5" cy="16" r="3" /></>,
  rectangle: <rect x="4" y="4" width="16" height="16" rx="2" />,
  redo: <path d="m16 6 4 4-4 4m4-4H9a4 4 0 0 0 0 8h3" />,
  add: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M5 19 19 5M10 5h9v9" />,
  back: <path d="m13 6-6 6 6 6M7 12h13" />,
  board: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M4 9h16m-10 0v10" /></>,
  connect: <><rect x="3.5" y="3.5" width="6" height="6" rx="1.2" /><rect x="14.5" y="14.5" width="6" height="6" rx="1.2" /><path d="M9.5 6.5h6a2 2 0 0 1 2 2v6" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  export: <><path d="M12 3v12m-4-4 4 4 4-4M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" /></>,
  folder: <path d="M3.5 18V6.5A1.5 1.5 0 0 1 5 5h5l2 2h7a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18Z" />,
  help: <><circle cx="12" cy="12" r="8.5" /><path d="M9.5 9a2.6 2.6 0 0 1 5 .8c0 1.8-2.5 2-2.5 3.8m0 3h.01" /></>,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  minus: <path d="M5 12h14" />,
  pan: <path d="M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v5a6.5 6.5 0 0 1-6.5 6.5h-1a5 5 0 0 1-4-2L4 13a1.5 1.5 0 0 1 2-2Z" />,
  pen: <><path d="m5 15-1 5 5-1L20 8l-4-4L5 15Z" /><path d="m14 6 4 4" /></>,
  plug: <><path d="M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0V8Zm5 8v5" /></>,
  select: <path d="m5 4 14 5-6 2-2 7L5 4Zm8 7 5 5" />,
  text: <path d="m5 20 6-16h2l6 16m-12-5h10M3 20h5m8 0h5" />,
  undo: <path d="M8 6 4 10l4 4m-4-4h11a4 4 0 0 1 0 8h-3" />,
  undoInk: <><path d="M8 6 4 10l4 4m-4-4h10a4 4 0 0 1 0 8h-3m7-14 2 2" /></>,
} satisfies Record<string, ReactNode>;

export function Icon({ name, size = 18 }: { name: keyof typeof icons; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">{icons[name]}</svg>;
}
