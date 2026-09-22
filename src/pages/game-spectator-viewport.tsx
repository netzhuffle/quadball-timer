import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

// The scoreboard and reading region share one viewport owner. A standalone
// timeline has no scoreboard clearance and never discovers another page's DOM.
const ScoreboardContext = createContext<RefObject<HTMLElement | null> | null>(null);
type ReadingPosition = { key: string; top: number; height: number };

export function GameSpectatorViewport({
  scoreboard,
  children,
  layoutVersion,
}: {
  scoreboard: ReactNode;
  children: ReactNode;
  // Semantic changes that can reflow the expanded scoreboard or its page header.
  // Keep advancing clocks out of this key; scroll and clock ticks need no remeasurement.
  layoutVersion: string;
}) {
  const scoreboardLayoutRef = useRef<HTMLDivElement | null>(null);
  const scoreboardSentinelRef = useRef<HTMLDivElement | null>(null);
  const scoreboardRef = useRef<HTMLElement | null>(null);
  const scoreboardContentRef = useRef<HTMLDivElement | null>(null);
  const expandedHeightRef = useRef(0);
  const recalibrateScoreboardRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const sentinel = scoreboardSentinelRef.current;
    const scoreboard = scoreboardRef.current;
    const content = scoreboardContentRef.current;
    const layout = scoreboardLayoutRef.current;
    if (!sentinel || !scoreboard || !content || !layout) return;
    const page = sentinel.closest<HTMLElement>(".daylight-game")!;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const supportsNativeScroll =
      window.CSS?.supports?.("animation-timeline", "scroll(root)") === true;
    let start = 0;
    let maximumScroll = 0;
    let nativeScroll = false;
    let active = true;
    const update = () => {
      const scrollY = Math.max(0, Math.min(window.scrollY, maximumScroll));
      const distance = maximumScroll > 0 ? Math.max(0, scrollY - start) : 0;
      const progress = reducedMotion?.matches ? Number(distance > 0) : Math.min(1, distance / 180);
      // Native CSS samples the scroll timeline directly. The fallback also stays
      // local to this element; neither path rerenders the timeline while scrolling.
      if (!nativeScroll) scoreboard.style.setProperty("--score-collapse", String(progress));
      scoreboard.dataset.collapseProgress = String(progress);
      scoreboard.toggleAttribute("data-scoreboard-compact", progress > 0);
    };
    const refreshRange = () => {
      const bottomPadding = Number.parseFloat(window.getComputedStyle(page).paddingBottom) || 0;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      start = sentinel.offsetTop;
      // Only the expanded content extent can enable the morph, never viewport minimum height.
      maximumScroll = Math.max(
        0,
        start + expandedHeightRef.current + content.offsetHeight + bottomPadding - viewportHeight,
      );
      nativeScroll = supportsNativeScroll && !reducedMotion?.matches && maximumScroll > 0;
      scoreboard.style.setProperty("--score-collapse-start", `${start}px`);
      scoreboard.style.setProperty("--score-collapse-end", `${start + 180}px`);
      scoreboard.toggleAttribute("data-scoreboard-native-scroll", nativeScroll);
      update();
    };
    const resize = () => {
      expandedHeightRef.current = measureExpandedScoreboard(scoreboard);
      layout.style.setProperty("--scoreboard-expanded-height", `${expandedHeightRef.current}px`);
      refreshRange();
    };
    recalibrateScoreboardRef.current = resize;
    const contentObserver = new window.ResizeObserver(refreshRange);
    contentObserver.observe(content);
    resize();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", resize);
    scoreboard.addEventListener("load", resize, true);
    document.fonts?.addEventListener("loadingdone", resize);
    void document.fonts?.ready.then(() => {
      if (active) resize();
    });
    reducedMotion?.addEventListener("change", refreshRange);
    return () => {
      active = false;
      recalibrateScoreboardRef.current = null;
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", resize);
      scoreboard.removeEventListener("load", resize, true);
      document.fonts?.removeEventListener("loadingdone", resize);
      contentObserver.disconnect();
      reducedMotion?.removeEventListener("change", refreshRange);
    };
  }, []);

  useEffect(() => {
    recalibrateScoreboardRef.current?.();
  }, [layoutVersion]);
  return (
    <ScoreboardContext value={scoreboardRef}>
      <div ref={scoreboardSentinelRef} aria-hidden="true" data-scoreboard-sentinel />
      <div ref={scoreboardLayoutRef} className="daylight-scoreboard-layout">
        <section
          ref={scoreboardRef}
          aria-label="Live scoreboard"
          className="daylight-morph-scoreboard"
          data-scoreboard-expanded
          data-collapse-progress="0"
          style={{ "--score-collapse": 0 } as CSSProperties}
        >
          <button
            type="button"
            className="daylight-score-return"
            aria-label="Return to full scoreboard"
            onClick={() => {
              scoreboardRef.current?.closest("main")?.focus({ preventScroll: true });
              window.scrollTo({
                top: 0,
                behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
                  ? "auto"
                  : "smooth",
              });
            }}
          />
          {scoreboard}
        </section>
        <div ref={scoreboardContentRef} data-scoreboard-content>
          {children}
        </div>
      </div>
    </ScoreboardContext>
  );
}

function measureExpandedScoreboard(scoreboard: HTMLElement): number {
  const nativeScroll = scoreboard.hasAttribute("data-scoreboard-native-scroll");
  scoreboard.removeAttribute("data-scoreboard-native-scroll");
  const progress = scoreboard.style.getPropertyValue("--score-collapse");
  scoreboard.style.setProperty("--score-collapse", "0");
  const names = [...scoreboard.querySelectorAll<HTMLElement>(".daylight-team-name")];
  // Measure natural wrapping before reserving each name's shrinking footprint.
  // Text may reflow during the morph, but must not move the scores in a jump.
  for (const name of names) name.style.removeProperty("--expanded-name-height");
  const heights = names.map((name) => name.getBoundingClientRect().height);
  names.forEach((name, index) =>
    name.style.setProperty("--expanded-name-height", `${heights[index]}px`),
  );
  const height = scoreboard.getBoundingClientRect().height;
  scoreboard.style.setProperty("--score-collapse", progress);
  scoreboard.toggleAttribute("data-scoreboard-native-scroll", nativeScroll);
  return height;
}

export function GameTimelineReadingRegion({
  children,
  signature,
}: {
  children: ReactNode;
  // Sporting content revision, excluding independently ticking break countdowns.
  signature: string;
}) {
  const headingId = useId();
  const regionRef = useRef<HTMLDivElement | null>(null);
  const readingRef = useRef<ReadingPosition | null>(null);
  const previousKeysRef = useRef<Set<string>>(new Set());
  const [hasNewPlay, setHasNewPlay] = useState(false);
  const [topClearance, setTopClearance] = useState(16);
  const scoreboardRef = useContext(ScoreboardContext);
  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const compactHeaderBottom = () => {
      const scoreboard = scoreboardRef?.current;
      if (!scoreboard?.hasAttribute("data-scoreboard-compact")) return 0;
      const rect = scoreboard.getBoundingClientRect();
      return rect.top < window.innerHeight / 2 ? Math.max(0, rect.bottom) : 0;
    };
    const rememberPosition = () => {
      const bounds = region.getBoundingClientRect();
      const inset = compactHeaderBottom();
      const reading = bounds.top < inset - 8 && bounds.bottom > inset;
      const anchor = Array.from(region.querySelectorAll<HTMLElement>("[data-timeline-key]")).find(
        (node) => node.getBoundingClientRect().bottom > inset,
      );
      readingRef.current =
        reading && anchor
          ? {
              key: anchor.dataset.timelineKey!,
              top: anchor.getBoundingClientRect().top,
              height: region.scrollHeight,
            }
          : null;
      if (bounds.top >= inset - 8) setHasNewPlay(false);
    };
    // Measure the actual compact score: wrapping names can make it taller than a fixed allowance.
    const measureClearance = () => {
      setTopClearance(compactHeaderBottom() + 16);
    };
    const observer = new window.ResizeObserver(measureClearance);
    const scoreboard = scoreboardRef?.current;
    if (scoreboard) observer.observe(scoreboard);
    observer.observe(region);
    rememberPosition();
    measureClearance();
    window.addEventListener("scroll", rememberPosition, { passive: true });
    window.addEventListener("resize", measureClearance);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", rememberPosition);
      window.removeEventListener("resize", measureClearance);
    };
  }, [scoreboardRef]);

  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const keys = new Set(
      Array.from(
        region.querySelectorAll<HTMLElement>("[data-timeline-key]"),
        (node) => node.dataset.timelineKey!,
      ),
    );
    const reading = readingRef.current;
    if (reading) {
      const anchor = Array.from(region.querySelectorAll<HTMLElement>("[data-timeline-key]")).find(
        (node) => node.dataset.timelineKey === reading.key,
      );
      window.scrollBy({
        top: anchor
          ? anchor.getBoundingClientRect().top - reading.top
          : region.scrollHeight - reading.height,
        behavior: "instant",
      });
      if (anchor)
        readingRef.current = {
          key: reading.key,
          top: anchor.getBoundingClientRect().top,
          height: region.scrollHeight,
        };
      if ([...keys].some((key) => !previousKeysRef.current.has(key))) setHasNewPlay(true);
    }
    previousKeysRef.current = keys;
  }, [signature]);

  return (
    <section
      className="daylight-timeline"
      aria-labelledby={headingId}
      data-game-timeline
      style={
        {
          "--timeline-top-clearance": `${topClearance}px`,
        } as CSSProperties
      }
    >
      <h3 id={headingId}>Game Timeline</h3>
      <span role="status" className="sr-only">
        {hasNewPlay ? "New play available" : ""}
      </span>
      {hasNewPlay ? (
        <button
          type="button"
          aria-label="Show newest play"
          className="daylight-new-play"
          onClick={() => {
            const region = regionRef.current;
            if (region) {
              region.scrollIntoView({
                block: "start",
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                  ? "instant"
                  : "smooth",
              });
              region.focus({ preventScroll: true });
            }
            readingRef.current = null;
            setHasNewPlay(false);
          }}
        >
          New play
        </button>
      ) : null}
      <div
        ref={regionRef}
        className="daylight-timeline-region"
        // The labelled history remains keyboard-focusable for page navigation.
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="region"
        data-timeline-scroll-region
        aria-label="Game Timeline"
      >
        {children}
      </div>
    </section>
  );
}
