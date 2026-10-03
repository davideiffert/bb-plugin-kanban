import { useEffect, useState, type RefObject } from "react";

/**
 * The board's own width, not the window's. A laptop window is wide while the
 * board beside an open chat panel is not, so every layout decision here has to
 * measure the element. Returns null until it has a real measurement, which is
 * also what happens where ResizeObserver does not exist: no measurement, no
 * layout change.
 */
export function useBoardWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const measure = () => {
      const next = element.getBoundingClientRect().width;
      setWidth(next > 0 ? next : null);
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
