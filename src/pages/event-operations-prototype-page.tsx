// PROTOTYPE — Three Event Admin / Pitch Manager operations variants, switchable via ?variant=.
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  KeyRound,
  MapPin,
  MoreHorizontal,
  QrCode,
  RefreshCw,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype-switcher";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LargeEventOperationsVariant } from "@/pages/event-operations-large-event-prototype";

type PrototypeRole = "event-admin" | "pitch-manager";
type GameStatus = "live" | "ready" | "handoff" | "upcoming";

type PrototypeGame = {
  id: string;
  time: string;
  pitch: string;
  home: string;
  away: string;
  status: GameStatus;
  controllers: number;
  code: string;
};

const GAMES: PrototypeGame[] = [
  {
    id: "game-1",
    time: "09:00",
    pitch: "Pitch 1",
    home: "Basel Basilisks",
    away: "Turicum Thunderbirds",
    status: "live",
    controllers: 2,
    code: "MINT-73",
  },
  {
    id: "game-2",
    time: "10:15",
    pitch: "Pitch 1",
    home: "Lausanne Lumieres",
    away: "Basel Basilisks",
    status: "handoff",
    controllers: 0,
    code: "FORK-28",
  },
  {
    id: "game-3",
    time: "11:30",
    pitch: "Pitch 1",
    home: "Turicum Thunderbirds",
    away: "Lausanne Lumieres",
    status: "upcoming",
    controllers: 0,
    code: "LAKE-41",
  },
];

const STATUS_LABELS: Record<GameStatus, string> = {
  live: "Live · 12:48",
  ready: "Ready",
  handoff: "Needs handoff",
  upcoming: "Upcoming",
};

const MANAGEMENT_LINKS: { label: string; detail: string; Icon: LucideIcon }[] = [
  { label: "Schedule", detail: "3 games", Icon: Clock3 },
  { label: "Teams", detail: "3 registered", Icon: Users },
  { label: "Pitch setup", detail: "1 pitch", Icon: MapPin },
];

const PITCH_MANAGER_LINKS: { label: string; detail: string; Icon: LucideIcon }[] = [
  { label: "Schedule", detail: "3 games on Pitch 1", Icon: Clock3 },
  { label: "Control grants", detail: "Open each game", Icon: KeyRound },
];

export function EventOperationsPrototypePage() {
  const { variant, selectVariant } = usePrototypeVariant();
  const [role, setRole] = useState<PrototypeRole>("event-admin");
  const [selectedGameId, setSelectedGameId] = useState("game-2");
  const [revealedCode, setRevealedCode] = useState<string | null>(null);
  const [rotatedGames, setRotatedGames] = useState<Set<string>>(() => new Set());

  const selectedGame = GAMES.find((game) => game.id === selectedGameId) ?? GAMES[1]!;

  const rotateGrant = (gameId: string) => {
    setRotatedGames((current) => new Set(current).add(gameId));
    setRevealedCode(gameId);
  };

  const prototypeProps = {
    role,
    setRole,
    selectedGame,
    selectGame: setSelectedGameId,
    revealedCode,
    revealCode: setRevealedCode,
    rotatedGames,
    rotateGrant,
  };

  return (
    <>
      {variant === "A" ? <RunSheetVariant {...prototypeProps} /> : null}
      {variant === "B" ? <NowNextVariant {...prototypeProps} /> : null}
      {variant === "C" ? <LargeEventOperationsVariant role={role} setRole={setRole} /> : null}
      <PrototypeSwitcher variant={variant} onChange={selectVariant} />
    </>
  );
}

type VariantProps = {
  role: PrototypeRole;
  setRole: (role: PrototypeRole) => void;
  selectedGame: PrototypeGame;
  selectGame: (gameId: string) => void;
  revealedCode: string | null;
  revealCode: (gameId: string | null) => void;
  rotatedGames: Set<string>;
  rotateGrant: (gameId: string) => void;
};

function RunSheetVariant(props: VariantProps) {
  return (
    <PrototypeShell
      title={props.role === "event-admin" ? "SQM 2026" : "Pitch 1"}
      subtitle={
        props.role === "event-admin"
          ? "Sunday, 16 August · 1 pitch · 3 games"
          : "Sunday, 16 August · 3 games"
      }
      role={props.role}
      setRole={props.setRole}
    >
      <section className="border-b bg-white px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase">Run sheet</p>
            <h2 className="text-lg font-semibold">Pitch 1 schedule</h2>
          </div>
          {props.role === "event-admin" ? (
            <Button size="sm" variant="outline">
              Teams & pitches
            </Button>
          ) : (
            <span className="text-xs font-semibold text-slate-500">Pitch access only</span>
          )}
        </div>
      </section>

      <div className="divide-y bg-white">
        {GAMES.map((game) => {
          const selected = game.id === props.selectedGame.id;
          return (
            <button
              key={game.id}
              className={cn(
                "grid w-full grid-cols-[3.25rem_1fr_auto] items-center gap-3 px-4 py-4 text-left transition-colors",
                selected ? "bg-blue-50" : "hover:bg-slate-50",
              )}
              onClick={() => props.selectGame(game.id)}
            >
              <span className="text-sm font-bold tabular-nums">{game.time}</span>
              <span>
                <span className="block text-sm font-semibold">{game.home}</span>
                <span className="block text-sm text-slate-500">vs {game.away}</span>
              </span>
              <StatusLabel status={game.status} />
            </button>
          );
        })}
      </div>

      <section className="m-3 rounded-2xl border border-slate-300 bg-slate-950 p-4 text-white shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase">Selected game</p>
            <h3 className="mt-1 font-semibold">
              {props.selectedGame.home} vs {props.selectedGame.away}
            </h3>
          </div>
          <MoreHorizontal className="size-5 text-slate-400" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button
            className="border-slate-700 bg-slate-900 text-white hover:bg-slate-800"
            variant="outline"
            onClick={() => props.revealCode(props.selectedGame.id)}
          >
            <QrCode /> Share control
          </Button>
          <Button className="bg-blue-500 text-white hover:bg-blue-400">
            Open game <ArrowRight />
          </Button>
        </div>
        <GrantReveal {...props} game={props.selectedGame} dark />
      </section>
    </PrototypeShell>
  );
}

function NowNextVariant(props: VariantProps) {
  const activeGame = GAMES[0]!;
  const handoffGame = GAMES[1]!;
  const managementLinks = props.role === "event-admin" ? MANAGEMENT_LINKS : PITCH_MANAGER_LINKS;

  return (
    <PrototypeShell
      title={props.role === "event-admin" ? "Event operations" : "My pitch"}
      subtitle="SQM 2026 · Pitch 1"
      role={props.role}
      setRole={props.setRole}
      tone="blue"
    >
      <main className="space-y-5 p-4">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-bold tracking-wider text-slate-500 uppercase">Now</h2>
            <span className="flex items-center gap-1 text-xs font-medium text-emerald-700">
              <span className="size-2 rounded-full bg-emerald-500" /> Pitch online
            </span>
          </div>
          <div className="rounded-3xl bg-blue-700 p-5 text-white shadow-xl shadow-blue-200">
            <p className="text-sm font-medium text-blue-100">Game 1 · 12:48 running</p>
            <h3 className="mt-4 text-2xl font-bold leading-tight">
              {activeGame.home}
              <span className="block font-normal text-blue-200">vs {activeGame.away}</span>
            </h3>
            <div className="mt-6 flex items-center justify-between border-t border-blue-500 pt-4">
              <span className="flex items-center gap-2 text-sm">
                <Users className="size-4" /> 2 controllers connected
              </span>
              <Button className="bg-white text-blue-800 hover:bg-blue-50" size="sm">
                View game
              </Button>
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-bold tracking-wider text-slate-500 uppercase">Next</h2>
          <div className="overflow-hidden rounded-3xl border border-amber-300 bg-amber-50">
            <div className="flex gap-3 p-4">
              <CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-700" />
              <div>
                <p className="font-semibold text-amber-950">Controller handoff needed</p>
                <p className="mt-1 text-sm text-amber-800">
                  10:15 · {handoffGame.home} vs {handoffGame.away}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 border-t border-amber-200 bg-white">
              <button
                className="flex min-h-16 items-center justify-center gap-2 border-r text-sm font-semibold"
                onClick={() => props.revealCode(handoffGame.id)}
              >
                <QrCode className="size-4" /> Show QR
              </button>
              <button
                className="flex min-h-16 items-center justify-center gap-2 text-sm font-semibold"
                onClick={() => props.revealCode(handoffGame.id)}
              >
                <KeyRound className="size-4" /> Say code
              </button>
            </div>
          </div>
          <GrantReveal {...props} game={handoffGame} />
        </section>

        <section className="rounded-2xl border bg-white p-1">
          {managementLinks.map(({ label, detail, Icon }) => (
            <button
              key={label}
              className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-slate-50"
            >
              <span className="grid size-9 place-items-center rounded-xl bg-slate-100">
                <Icon className="size-4" />
              </span>
              <span className="flex-1">
                <span className="block text-sm font-semibold">{label}</span>
                <span className="block text-xs text-slate-500">{detail}</span>
              </span>
              <ChevronRight className="size-4 text-slate-400" />
            </button>
          ))}
        </section>
      </main>
    </PrototypeShell>
  );
}

function PrototypeShell({
  title,
  subtitle,
  role,
  setRole,
  tone = "slate",
  children,
}: {
  title: string;
  subtitle: string;
  role: PrototypeRole;
  setRole: (role: PrototypeRole) => void;
  tone?: "slate" | "blue" | "green";
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto min-h-screen w-full max-w-md bg-slate-50 pb-24 shadow-2xl">
      <header
        className={cn(
          "border-b px-4 pt-5 pb-4",
          tone === "blue" && "border-blue-800 bg-blue-950 text-white",
          tone === "green" && "border-emerald-900 bg-emerald-950 text-white",
          tone === "slate" && "bg-white",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">{title}</h1>
            <p
              className={cn(
                "mt-0.5 text-xs",
                tone === "slate" ? "text-slate-500" : "text-white/70",
              )}
            >
              {subtitle}
            </p>
          </div>
          <span className="rounded-md border border-current/20 px-2 py-1 text-[10px] font-bold tracking-wider uppercase opacity-70">
            Prototype
          </span>
        </div>
        <div className="mt-4 grid grid-cols-2 rounded-xl bg-black/10 p-1">
          <RoleButton
            active={role === "event-admin"}
            label="Event Admin"
            onClick={() => setRole("event-admin")}
          />
          <RoleButton
            active={role === "pitch-manager"}
            label="Pitch Manager"
            onClick={() => setRole("pitch-manager")}
          />
        </div>
        <p
          className={cn(
            "mt-1.5 text-center text-[10px] font-medium",
            tone === "slate" ? "text-slate-400" : "text-white/50",
          )}
        >
          Prototype access lens · real access comes from separate grants
        </p>
      </header>
      {children}
    </div>
  );
}

function RoleButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "min-h-9 rounded-lg px-3 text-xs font-semibold transition-colors",
        active ? "bg-white text-slate-950 shadow-sm" : "text-current opacity-70 hover:opacity-100",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function StatusLabel({ status }: { status: GameStatus }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap rounded-full px-2 py-1 text-[10px] font-bold",
        status === "live" && "bg-emerald-100 text-emerald-800",
        status === "handoff" && "bg-amber-100 text-amber-800",
        status === "ready" && "bg-blue-100 text-blue-800",
        status === "upcoming" && "bg-slate-100 text-slate-600",
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function GrantReveal({
  game,
  role,
  revealedCode,
  rotatedGames,
  rotateGrant,
  dark = false,
}: VariantProps & { game: PrototypeGame; dark?: boolean }) {
  if (revealedCode !== game.id) {
    return null;
  }

  const code = rotatedGames.has(game.id) ? "NOVA-64" : game.code;
  return (
    <div
      className={cn(
        "mt-3 rounded-xl border p-3",
        dark ? "border-white/20 bg-white/10" : "border-slate-200 bg-white",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p
            className={cn(
              "text-[10px] font-bold uppercase",
              dark ? "text-white/60" : "text-slate-500",
            )}
          >
            Verbal control code
          </p>
          <p className="mt-0.5 text-xl font-black tracking-[0.2em]">{code}</p>
        </div>
        <Button
          size="icon-sm"
          variant={dark ? "secondary" : "outline"}
          aria-label="Copy control code"
        >
          <Copy />
        </Button>
      </div>
      {role === "event-admin" ? (
        <button
          className={cn(
            "mt-3 flex items-center gap-2 text-xs font-semibold",
            dark ? "text-white/80" : "text-slate-600",
          )}
          onClick={() => rotateGrant(game.id)}
        >
          {rotatedGames.has(game.id) ? (
            <Check className="size-3.5" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {rotatedGames.has(game.id) ? "Rotated for this handoff" : "Rotate compromised grant"}
        </button>
      ) : (
        <p className={cn("mt-3 text-xs", dark ? "text-white/60" : "text-slate-500")}>
          Event Admins manage and rotate this grant.
        </p>
      )}
    </div>
  );
}
