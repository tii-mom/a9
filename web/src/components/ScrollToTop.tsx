import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/** React Router handles navigation; wait for the destination to mount before an anchor jump. */
export function ScrollToTop() {
  const { pathname, hash, key } = useLocation();
  useEffect(() => {
    let frame = 0;
    let attempts = 0;
    const scroll = () => {
      if (!hash) {
        window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
        return;
      }
      let id: string;
      try { id = decodeURIComponent(hash.slice(1)); } catch { return; }
      const target = document.getElementById(id);
      if (!target && attempts++ < 30) {
        frame = requestAnimationFrame(scroll);
        return;
      }
      if (target) {
        target.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
        // Anchors also work for keyboard users, including the skip link.
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [pathname, hash, key]);
  return null;
}
