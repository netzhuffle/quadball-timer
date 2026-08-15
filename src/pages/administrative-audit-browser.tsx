import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export type AdministrativeAuditBrowserRoute = "event-admin" | "technical-admin";
export type AdministrativeAuditBrowserRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type AuditEntry = {
  evidenceId: string;
  evidenceType: "event-administration" | "grant";
  action: string;
  occurredAtMs: number;
  authority: { reference: string };
  scope?: Record<string, string | null>;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  grantId?: string;
  reason?: string;
  links: Record<string, string | null>;
};

type AuditResponse =
  | {
      status: "accepted";
      value: {
        entries: AuditEntry[];
        direction: "ascending" | "descending";
        hasMore: boolean;
        nextCursor: string | null;
      };
    }
  | { status: "rejected" | "unavailable"; detail?: string };

type AuditFilters = {
  action: string;
  grantId: string;
  eventGameId: string;
  gameDayId: string;
  pitchId: string;
  pitchSlotId: string;
};

type ProjectionState = {
  entries: AuditEntry[];
  hasMore: boolean;
  nextCursor: string | null;
  loading: boolean;
};

const PROJECTIONS = ["event-administration", "grant"] as const;
const EMPTY_FILTERS: AuditFilters = {
  action: "",
  grantId: "",
  eventGameId: "",
  gameDayId: "",
  pitchId: "",
  pitchSlotId: "",
};

export function AdministrativeAuditBrowser({
  eventId,
  route,
  request = (input, init) => fetch(input, init),
}: {
  eventId: string;
  route: AdministrativeAuditBrowserRoute;
  request?: AdministrativeAuditBrowserRequest;
}) {
  const [direction, setDirection] = useState<"ascending" | "descending">("descending");
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [pages, setPages] =
    useState<Record<(typeof PROJECTIONS)[number], ProjectionState>>(emptyPages());
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const requestRef = useRef(request);
  requestRef.current = request;
  const queryKey = JSON.stringify({ eventId, direction, filters });
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;

  useEffect(() => {
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    mounted.current = true;
    setPages(emptyPages());
    setError(null);
    let cancelled = false;
    const isCurrent = () =>
      mounted.current &&
      generation.current === currentGeneration &&
      queryKeyRef.current === queryKey;

    const loadInitialPages = async () => {
      await Promise.all(
        PROJECTIONS.map((projection) =>
          loadPage({
            eventId,
            route,
            projection,
            direction,
            filters,
            cursor: null,
            append: false,
            isCurrent,
            cancelled: () => cancelled,
            setPages,
            setError,
            requestRef,
          }),
        ),
      );
    };
    void loadInitialPages().catch(() => undefined);
    return () => {
      cancelled = true;
      generation.current += 1;
      mounted.current = false;
    };
  }, [eventId, route, queryKey]);

  const loadMore = (projection: (typeof PROJECTIONS)[number]) => {
    const page = pages[projection];
    if (!page.hasMore || page.loading || page.nextCursor === null) return;
    const loadGeneration = generation.current;
    const loadQueryKey = queryKey;
    void loadPage({
      eventId,
      route,
      projection,
      direction,
      filters,
      cursor: page.nextCursor,
      append: true,
      isCurrent: () =>
        mounted.current &&
        generation.current === loadGeneration &&
        queryKeyRef.current === loadQueryKey,
      cancelled: () => false,
      setPages,
      setError,
      requestRef,
    }).catch(() => undefined);
  };

  const updateFilter = (name: keyof AuditFilters, value: string) => {
    setFilters((current) => ({ ...current, [name]: value }));
  };

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div>
        <p className="font-semibold">Administrative audit evidence</p>
        <p className="text-sm text-muted-foreground">
          Privileged Event Administration and Grant lifecycle evidence; credentials, sporting
          detail, and Technical Admin operational logs remain separate.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs">
          Audit ordering
          <select
            aria-label="Audit ordering"
            className="mt-1 block w-full rounded border bg-background p-2"
            value={direction}
            onChange={(event) => setDirection(event.target.value as typeof direction)}
          >
            <option value="descending">Newest first</option>
            <option value="ascending">Oldest first</option>
          </select>
        </label>
        <AuditFilter
          label="Audit action filter"
          value={filters.action}
          onChange={(value) => updateFilter("action", value)}
        />
        <AuditFilter
          label="Event Game ID filter"
          value={filters.eventGameId}
          onChange={(value) => updateFilter("eventGameId", value)}
        />
        <AuditFilter
          label="Game Day ID filter"
          value={filters.gameDayId}
          onChange={(value) => updateFilter("gameDayId", value)}
        />
        <AuditFilter
          label="Pitch ID filter"
          value={filters.pitchId}
          onChange={(value) => updateFilter("pitchId", value)}
        />
        <AuditFilter
          label="Pitch Slot ID filter"
          value={filters.pitchSlotId}
          onChange={(value) => updateFilter("pitchSlotId", value)}
        />
        <AuditFilter
          label="Grant ID filter (Grant Audit only)"
          value={filters.grantId}
          onChange={(value) => updateFilter("grantId", value)}
        />
      </div>
      {error ? <p className="text-sm text-destructive">Unable to load audit evidence.</p> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <AuditProjectionCard
          label="Event Administration"
          projection="event-administration"
          page={pages["event-administration"]}
          onLoadMore={() => loadMore("event-administration")}
        />
        <AuditProjectionCard
          label="Grant Audit"
          projection="grant"
          page={pages.grant}
          onLoadMore={() => loadMore("grant")}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Changing the Event, projection, filters, or ordering starts a fresh bounded result set.
      </p>
    </div>
  );
}

function AuditFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs">
      {label}
      <input
        aria-label={label}
        className="mt-1 block w-full rounded border bg-background p-2"
        value={value}
        onInput={(event) => onChange(event.currentTarget.value)}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function AuditProjectionCard({
  label,
  projection,
  page,
  onLoadMore,
}: {
  label: string;
  projection: (typeof PROJECTIONS)[number];
  page: ProjectionState;
  onLoadMore: () => void;
}) {
  return (
    <div aria-label={`${label} audit projection`} className="rounded border p-2">
      <p className="text-xs font-semibold">{label}</p>
      {page.entries.length === 0 && !page.loading ? (
        <p className="text-xs text-muted-foreground">No evidence.</p>
      ) : (
        page.entries.map((entry) => (
          <div className="border-b py-2 text-xs last:border-0" key={entry.evidenceId}>
            <p className="font-mono text-[10px]">Evidence: {entry.evidenceId}</p>
            <p className="font-medium">{entry.action}</p>
            <p className="text-muted-foreground">
              {new Date(entry.occurredAtMs).toLocaleString()} · {entry.authority.reference}
            </p>
            <p className="text-muted-foreground">Scope: {JSON.stringify(entry.scope ?? {})}</p>
            <p className="text-muted-foreground">
              {projection === "grant" ? "Lifecycle" : "Before → after"}:{" "}
              {JSON.stringify(entry.before)} → {JSON.stringify(entry.after)}
            </p>
            {entry.reason ? <p className="text-muted-foreground">Reason: {entry.reason}</p> : null}
            <p className="text-muted-foreground">Links: {JSON.stringify(entry.links)}</p>
          </div>
        ))
      )}
      {page.hasMore ? (
        <Button disabled={page.loading} onClick={onLoadMore} size="sm" variant="outline">
          {page.loading ? "Loading…" : `Load more ${label}`}
        </Button>
      ) : null}
    </div>
  );
}

function emptyPages(): Record<(typeof PROJECTIONS)[number], ProjectionState> {
  return {
    "event-administration": { entries: [], hasMore: false, nextCursor: null, loading: false },
    grant: { entries: [], hasMore: false, nextCursor: null, loading: false },
  };
}

async function loadPage({
  eventId,
  route,
  projection,
  direction,
  filters,
  cursor,
  append,
  isCurrent,
  cancelled,
  setPages,
  setError,
  requestRef,
}: {
  eventId: string;
  route: AdministrativeAuditBrowserRoute;
  projection: (typeof PROJECTIONS)[number];
  direction: "ascending" | "descending";
  filters: AuditFilters;
  cursor: string | null;
  append: boolean;
  isCurrent: () => boolean;
  cancelled: () => boolean;
  setPages: React.Dispatch<
    React.SetStateAction<Record<(typeof PROJECTIONS)[number], ProjectionState>>
  >;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  requestRef: React.MutableRefObject<AdministrativeAuditBrowserRequest>;
}) {
  setPages((current) => ({
    ...current,
    [projection]: { ...current[projection], loading: true },
  }));
  const params = new URLSearchParams({ projection, limit: "10", direction });
  if (route === "event-admin") params.set("eventId", eventId);
  for (const [name, value] of Object.entries(filters)) {
    if (value.length > 0 && (projection === "grant" || name !== "grantId")) params.set(name, value);
  }
  if (cursor !== null) params.set("cursor", cursor);
  const path =
    route === "event-admin"
      ? `/api/event-admin/audit?${params}`
      : `/api/admin/events/${encodeURIComponent(eventId)}/audit?${params}`;
  const response = await requestRef.current(path);
  const payload = (await response.json()) as AuditResponse;
  if (!response.ok || payload.status !== "accepted") {
    if (!cancelled() && isCurrent()) setError("Unable to load audit evidence.");
    throw new Error("Unable to load audit evidence.");
  }
  if (cancelled() || !isCurrent()) return;
  setPages((current) => ({
    ...current,
    [projection]: {
      entries: append
        ? [...current[projection].entries, ...payload.value.entries]
        : payload.value.entries,
      hasMore: payload.value.hasMore,
      nextCursor: payload.value.nextCursor,
      loading: false,
    },
  }));
}
