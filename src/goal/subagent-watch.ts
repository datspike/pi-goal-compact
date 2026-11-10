import { SUBAGENT_RPC_TIMEOUT_MS, SUBAGENT_WAIT_TIMEOUT_MS } from "./runtime-config.js";

/** Часть `pi.events`, через которую видны фоновые запуски сабагентов. */
export interface SubagentEventBus {
  on: (channel: string, handler: (payload: unknown) => void) => () => void;
  emit: (channel: string, payload: unknown) => void;
}

const SUBAGENT_RPC_REQUEST_CHANNEL = "subagents:rpc:v1:request";
const SUBAGENT_RPC_READY_CHANNEL = "subagents:rpc:v1:ready";
const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
/** Состояния запуска в снимке, которые ещё работают; `paused` ждёт владельца. */
const ACTIVE_SNAPSHOT_STATES = new Set(["queued", "running"]);

interface SnapshotRun {
  id: string;
  active: boolean;
  startedAt: number | null;
}

interface StatusSnapshot {
  runs: SnapshotRun[];
  /** pi-subagents обрезал список, и последний запуск в нём активен: активные могли не попасть в ответ. */
  maybeIncomplete: boolean;
}

/**
 * Снимок `asyncSnapshot` из ответа pi-subagents на `status` или null для любого другого ответа.
 * pi-subagents перечисляет работающие, затем ждущие, затем завершённые запуски, поэтому обрезанный
 * список (`omitted`) прячет активные запуски, только если последний в нём сам активен.
 */
function parseStatusSnapshot(reply: unknown): StatusSnapshot | null {
  const envelope = reply as { success?: unknown; data?: { asyncSnapshot?: { runs?: unknown; omitted?: { runs?: unknown; byteLimitExceeded?: unknown } } } } | null;
  const snapshot = envelope?.success === true ? envelope.data?.asyncSnapshot : undefined;
  if (!snapshot || !Array.isArray(snapshot.runs)) return null;
  const runs: SnapshotRun[] = [];
  for (const node of snapshot.runs as unknown[]) {
    const { id, state, startedAt } = (node ?? {}) as { id?: unknown; state?: unknown; startedAt?: unknown };
    if (typeof id !== "string" || id.length === 0) continue;
    runs.push({
      id,
      active: typeof state === "string" && ACTIVE_SNAPSHOT_STATES.has(state),
      startedAt: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : null,
    });
  }
  const cut = (typeof snapshot.omitted?.runs === "number" && snapshot.omitted.runs > 0) || snapshot.omitted?.byteLimitExceeded === true;
  return { runs, maybeIncomplete: cut && (runs.at(-1)?.active ?? false) };
}

interface SubagentWatchDeps {
  /** Сабагенты больше не держат продолжение: последний завершился, истёк срок или пришёл ответ о статусе. */
  onRelease: () => void;
  now?: () => number;
  waitTimeoutMs?: number;
  rpcTimeoutMs?: number;
}

/**
 * Следит за фоновыми сабагентами сессии (строка реестра Ц30).
 *
 * Пока сабагент работает, продолжение цели ждёт: его завершение само разбудит сессию, а
 * продолжение в это время только заставит модель опрашивать статус и сбросит кэш провайдера.
 * Запуски до загрузки расширения (например, до `/reload`) неизвестны, пока pi-subagents не ответит
 * на запрос статуса; всё это время продолжение тоже ждёт. Потерянное событие о завершении не
 * держит цель дольше предельного срока.
 */
export function createSubagentWatch(deps: SubagentWatchDeps) {
  const now = deps.now ?? Date.now;
  const waitTimeoutMs = deps.waitTimeoutMs ?? SUBAGENT_WAIT_TIMEOUT_MS;
  const rpcTimeoutMs = deps.rpcTimeoutMs ?? SUBAGENT_RPC_TIMEOUT_MS;

  // id запуска → время начала.
  const activeRuns = new Map<string, number>();
  let sessionKey: string | null = null;
  const unsubscribes: Array<() => void> = [];
  let events: SubagentEventBus | undefined;
  let rpcAvailable = false;
  let syncPending = false;
  // Прошлый снимок мог спрятать активные запуски: перепроверить, когда перечисленные закончатся.
  let snapshotMaybeIncomplete = false;
  // Завершились, пока шёл запрос статуса: ответ ещё может назвать их работающими.
  const completedDuringSync = new Set<string>();
  let cancelSync: (() => void) | null = null;
  let syncCounter = 0;
  // Продолжение отложено ради сабагентов и ждёт освобождения.
  let waiting = false;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  // Таймер срока помечает свой запуск напрямую: таймер может сработать чуть раньше часов.
  const dueRuns = new Set<string>();

  const clearWaitTimer = (): void => {
    if (waitTimer) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
  };

  const isExpired = (id: string, startedAt: number, current: number): boolean =>
    dueRuns.has(id) || current - startedAt >= waitTimeoutMs;

  const hasExpiredRuns = (): boolean => {
    const current = now();
    for (const [id, startedAt] of activeRuns) if (isExpired(id, startedAt, current)) return true;
    return false;
  };

  /**
   * Спрашивает pi-subagents, какие фоновые запуски сессии ещё работают, и сверяет с ответом.
   * Нет ответа за отведённое время — pi-subagents нет, остаётся знание из событий. Запуски дольше
   * предельного срока остаются, пока pi-subagents называет их активными; без подтверждения они
   * отпускаются, чтобы потерянное завершение не держало цель вечно.
   */
  const sync = (): void => {
    cancelSync?.();
    syncPending = true;
    completedDuringSync.clear();
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    const cleanup = (): void => {
      finished = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      cancelSync = null;
    };
    const finish = (reply: unknown): void => {
      if (finished) return;
      cleanup();
      syncPending = false;
      const current = now();
      const snapshot = parseStatusSnapshot(reply);
      snapshotMaybeIncomplete = snapshot?.maybeIncomplete ?? false;
      const listed = new Map<string, SnapshotRun>();
      for (const run of snapshot?.runs ?? []) listed.set(run.id, run);
      for (const [id, run] of listed) {
        if (!run.active) activeRuns.delete(id);
        else if (!activeRuns.has(id) && !completedDuringSync.has(id)) activeRuns.set(id, run.startedAt ?? current);
      }
      for (const [id, startedAt] of activeRuns) {
        if (!isExpired(id, startedAt, current)) continue;
        if (listed.get(id)?.active) activeRuns.set(id, current);
        else activeRuns.delete(id);
      }
      dueRuns.clear();
      completedDuringSync.clear();
      resume();
    };
    cancelSync = () => {
      cleanup();
      syncPending = false;
    };
    if (!events || !rpcAvailable) {
      finish(null);
      return;
    }
    const requestId = `goal-compact-${++syncCounter}-${now()}`;
    unsubscribe = events.on(`${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`, finish);
    timer = setTimeout(() => finish(null), rpcTimeoutMs);
    timer.unref?.();
    events.emit(SUBAGENT_RPC_REQUEST_CHANNEL, { version: 1, requestId, method: "status", source: "goal-compact" });
  };

  /** Известен ли работающий запуск; запуск дольше срока сначала перепроверяется. */
  const hasActiveRuns = (): boolean => {
    if (!syncPending && hasExpiredRuns()) sync();
    return activeRuns.size > 0;
  };

  /** Нужно ли ждать: известен работающий запуск или ответ о статусе ещё может его назвать. */
  const mustHold = (): boolean => {
    const active = hasActiveRuns();
    if (!active && !syncPending && snapshotMaybeIncomplete) sync();
    return active || syncPending;
  };

  /** Откладывает продолжение до освобождения; таймер страхует только потерянное событие о завершении. */
  const hold = (): void => {
    clearWaitTimer();
    waiting = true;
    // Ждущий запрос статуса сам снимет ожидание, самое позднее по своему таймеру.
    if (syncPending) return;
    let oldestId = "";
    let oldestStart = Number.POSITIVE_INFINITY;
    for (const [runId, startedAt] of activeRuns) {
      if (startedAt < oldestStart) {
        oldestId = runId;
        oldestStart = startedAt;
      }
    }
    if (oldestStart === Number.POSITIVE_INFINITY) return;
    waitTimer = setTimeout(() => {
      waitTimer = null;
      dueRuns.add(oldestId);
      resume();
    }, Math.max(0, oldestStart + waitTimeoutMs - now()));
    waitTimer.unref?.();
  };

  // Снимает ожидание, когда запусков не осталось; иначе взводит таймер по следующему старейшему.
  const resume = (): void => {
    if (!waiting) return;
    if (mustHold()) {
      hold();
      return;
    }
    waiting = false;
    clearWaitTimer();
    deps.onRelease();
  };

  const isForeign = (payload: unknown): boolean => {
    const eventSessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
    return sessionKey !== null && typeof eventSessionId === "string" && eventSessionId !== sessionKey;
  };

  const runIdOf = (payload: unknown): string | null => {
    const id = (payload as { id?: unknown } | null)?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  };

  const noteStarted = (payload: unknown): void => {
    const runId = runIdOf(payload);
    if (runId === null || isForeign(payload) || activeRuns.has(runId)) return;
    activeRuns.set(runId, now());
  };

  const noteCompleted = (payload: unknown): void => {
    const runId = runIdOf(payload);
    if (runId === null || isForeign(payload)) return;
    activeRuns.delete(runId);
    if (syncPending) completedDuringSync.add(runId);
    resume();
  };

  const unwatch = (): void => {
    cancelSync?.();
    events = undefined;
    rpcAvailable = false;
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  };

  return {
    mustHold,
    hold,
    hasActiveRuns,
    /**
     * Начинает следить за запусками одной сессии и заменяет прежнюю подписку.
     * С `withRpc` (инструмент `subagent` зарегистрирован) запуски, начатые раньше, запрашиваются
     * у pi-subagents, и продолжение ждёт ответа.
     */
    watch(bus: SubagentEventBus | undefined, key: string | null, withRpc: boolean): void {
      unwatch();
      sessionKey = key;
      if (!bus) return;
      events = bus;
      rpcAvailable = withRpc;
      unsubscribes.push(
        bus.on("subagent:async-started", noteStarted),
        bus.on("subagent:async-complete", noteCompleted),
        // pi-subagents сообщает о готовности отвечать; запрос до этого потерялся.
        bus.on(SUBAGENT_RPC_READY_CHANNEL, () => {
          rpcAvailable = true;
          sync();
        }),
      );
      if (withRpc) sync();
    },
    /** Забывает запуски и подписку: сессия закрыта или сменилась. */
    clear(): void {
      unwatch();
      sessionKey = null;
      activeRuns.clear();
      dueRuns.clear();
      completedDuringSync.clear();
      snapshotMaybeIncomplete = false;
      waiting = false;
      clearWaitTimer();
    },
    /** Продолжение больше не ждёт сабагентов: его отменили или отправили другим путём. */
    cancelWait(): void {
      waiting = false;
      clearWaitTimer();
    },
  };
}
