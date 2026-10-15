/**
 * Shared dark theme for the climbing coach web app.
 *
 * Jon's UI preferences: minimalist, monochrome chrome, red reserved
 * ONLY for fault markers. Dark background throughout.
 */

export const c = {
  bg: '#111111',
  surface: '#1a1a1a',
  surfaceHover: '#222222',
  border: '#2e2e2e',
  borderStrong: '#444444',
  text: '#e8e8e8',
  textMuted: '#999999',
  textFaint: '#666666',
  fault: '#c00',
  font: 'system-ui',
} as const;

const base: React.CSSProperties = { fontFamily: c.font };

export const page: React.CSSProperties = {
  ...base,
  maxWidth: '800px',
  margin: '0 auto',
  padding: '20px',
  color: c.text,
  backgroundColor: c.bg,
  minHeight: '100svh',
  textAlign: 'left',
};

export const h1: React.CSSProperties = {
  ...base,
  margin: 0,
  fontSize: '28px',
  fontWeight: 600,
  color: c.text,
  letterSpacing: '-0.5px',
};

export const h2: React.CSSProperties = {
  ...base,
  margin: 0,
  fontSize: '20px',
  fontWeight: 600,
  color: c.text,
};

/** Minimal text tabs with an underline indicator for the active tab. */
export const tabBtn = (active: boolean): React.CSSProperties => ({
  ...base,
  padding: '10px 4px',
  marginRight: '20px',
  fontSize: '15px',
  fontWeight: active ? 600 : 400,
  backgroundColor: 'transparent',
  color: active ? c.text : c.textMuted,
  border: 'none',
  borderBottom: active ? `2px solid ${c.text}` : '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
});

export const tabBar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  borderBottom: `1px solid ${c.border}`,
  margin: '16px 0 24px 0',
  overflowX: 'auto',
};

/** Primary action button: dark with a subtle border. */
export const btnPrimary: React.CSSProperties = {
  ...base,
  padding: '12px 24px',
  fontSize: '16px',
  fontWeight: 500,
  backgroundColor: c.surface,
  color: c.text,
  border: `1px solid ${c.borderStrong}`,
  borderRadius: '8px',
  cursor: 'pointer',
};

export const btnPrimaryDisabled: React.CSSProperties = {
  ...btnPrimary,
  color: c.textFaint,
  borderColor: c.border,
  cursor: 'not-allowed',
};

/** Secondary / quiet button. */
export const btnQuiet: React.CSSProperties = {
  ...base,
  padding: '8px 14px',
  fontSize: '14px',
  backgroundColor: 'transparent',
  color: c.textMuted,
  border: `1px solid ${c.border}`,
  borderRadius: '8px',
  cursor: 'pointer',
};

/** Small inline button (dismiss, copy, etc.). */
export const btnSmall: React.CSSProperties = {
  ...base,
  padding: '6px 12px',
  fontSize: '13px',
  backgroundColor: 'transparent',
  color: c.textMuted,
  border: `1px solid ${c.border}`,
  borderRadius: '6px',
  cursor: 'pointer',
};

export const card: React.CSSProperties = {
  ...base,
  border: `1px solid ${c.border}`,
  borderRadius: '10px',
  padding: '16px',
  marginBottom: '12px',
  backgroundColor: c.surface,
};

export const input: React.CSSProperties = {
  ...base,
  padding: '8px 12px',
  fontSize: '14px',
  color: c.text,
  backgroundColor: c.bg,
  border: `1px solid ${c.borderStrong}`,
  borderRadius: '8px',
};

export const select: React.CSSProperties = {
  ...input,
  cursor: 'pointer',
};

export const muted: React.CSSProperties = {
  ...base,
  color: c.textMuted,
};

export const faint: React.CSSProperties = {
  ...base,
  color: c.textFaint,
  fontSize: '13px',
};

/** Red dot used ONLY for fault markers. */
export const faultDot: React.CSSProperties = {
  display: 'inline-block',
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  backgroundColor: c.fault,
  flexShrink: 0,
};

export const faultText: React.CSSProperties = {
  ...base,
  color: c.fault,
};

/* ------------------------------------------------------------------ */
/* Artifact-style design language                                       */
/* ------------------------------------------------------------------ */

/** Very large hero headline, e.g. "Upload climbs". */
export const hero: React.CSSProperties = {
  ...base,
  margin: 0,
  fontSize: '52px',
  fontWeight: 700,
  letterSpacing: '-1.5px',
  lineHeight: 1.05,
  color: c.text,
};

/** Subtext under a hero headline. */
export const heroSub: React.CSSProperties = {
  ...base,
  margin: '16px 0 32px 0',
  fontSize: '17px',
  lineHeight: 1.5,
  color: c.textMuted,
  maxWidth: '480px',
};

/** Large dashed upload drop card, artifact-style. */
export const uploadCard: React.CSSProperties = {
  ...base,
  border: `2px dashed ${c.borderStrong}`,
  borderRadius: '16px',
  padding: '56px 24px',
  textAlign: 'center',
  cursor: 'pointer',
  backgroundColor: 'transparent',
  width: '100%',
  boxSizing: 'border-box',
};

export const uploadCardTitle: React.CSSProperties = {
  ...base,
  margin: '16px 0 8px 0',
  fontSize: '20px',
  fontWeight: 600,
  color: c.text,
};

export const uploadCardSub: React.CSSProperties = {
  ...base,
  margin: 0,
  fontSize: '15px',
  color: c.textMuted,
};

/** Large section title for non-analyze tabs. */
export const sectionTitle: React.CSSProperties = {
  ...base,
  margin: 0,
  fontSize: '36px',
  fontWeight: 700,
  letterSpacing: '-1px',
  color: c.text,
};

export const sectionSub: React.CSSProperties = {
  ...base,
  margin: '8px 0 24px 0',
  fontSize: '15px',
  color: c.textMuted,
};

/** "CLIMBER" small-caps label. */
export const climberLabel: React.CSSProperties = {
  ...base,
  fontSize: '12px',
  fontWeight: 600,
  letterSpacing: '2px',
  color: c.textFaint,
  textTransform: 'uppercase',
};

/** Verdict line shown above results, e.g. "2 faults" / "Clean climbing". */
export const verdict: React.CSSProperties = {
  ...base,
  margin: '0 0 16px 0',
  fontSize: '24px',
  fontWeight: 700,
  letterSpacing: '-0.5px',
  color: c.text,
};
