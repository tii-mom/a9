/** Inline SVG icons matching the prototype's ICO set. */
export function IcoOk() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" />
    </svg>
  );
}

export function IcoNo() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" />
    </svg>
  );
}

export function IcoDot() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="8" cy="8" r="3.5" fill="currentColor" />
    </svg>
  );
}

export function IcoWarn() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path d="M10 2l9 16H1L10 2z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10 8v5M10 15v1.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
