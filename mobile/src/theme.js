// The page's look (public/styles.css), for React Native styles: editorial minimalism, big serif
// type, hairlines, and one accent for what's live or yours. Actions are ink.
export const color = {
  paper: '#f8f6f2',
  raised: '#ffffff',
  surface: '#f0ece5',
  surface2: '#e7e1d7',
  ink: '#1c1a17',
  ink2: '#4f4a43',
  muted: '#6f6a62',
  line: '#e6e0d7',
  lineStrong: '#cfc7bb',
  accent: '#a8441f',
  accentInk: '#ffffff',
  accentSoft: '#f3e5dc',
  accentRing: 'rgba(168, 68, 31, 0.25)',
  brollSpan: 'rgba(226, 132, 96, 0.9)', // the accent, lightened for a dark timeline
};

export const font = {
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, P052, 'URW Palladio L', 'Book Antiqua', Georgia, serif",
  sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
};

export const radius = { lg: 18, sm: 12, pill: 999 };

// Fingers need bigger targets than pointers: 44 points, as the platforms recommend.
export const TOUCH = 44;

// How wide the content gets on a tablet, or a phone turned sideways.
export const MAX_WIDTH = 640;

// Under the notch: the player docks under the top bar.
export const TOP_BAR_HEIGHT = 52;
export const TAB_BAR_HEIGHT = 58;
