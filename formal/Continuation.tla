---------------------------- MODULE Continuation ----------------------------
(***************************************************************************)
(* Модель 1. Продолжение цели и удержание.                                 *)
(*                                                                         *)
(* Обычное продолжение решается в конце работы агента, на границе          *)
(* agent_before_settle: Pi сам делает ещё один запрос и сам отменяет его   *)
(* при обрыве. Очереди для него нет.                                       *)
(*                                                                         *)
(* Есть четыре пути, где работа начинается из простоя: после сжатия по     *)
(* запросу агента, после паузы на ошибку провайдера, после завершения      *)
(* сабагента и по команде возобновления. Каждый такой путь кладёт в        *)
(* очередь Pi «билет» с номером эпохи. Эпоха растёт на каждой реплике      *)
(* владельца, смене ветки и смене цели. При доставке билет сверяется:      *)
(* устаревший выбрасывается без запуска работы.                            *)
(*                                                                         *)
(* Неделимый шаг модели — обработчик события Pi до первого await.          *)
(*                                                                         *)
(* Bug выбирает намеренную поломку. Каждая поломка обязана нарушить своё   *)
(* свойство; это проверяет formal/check.ts.                                *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Bug, MaxEpoch, MaxQueue

Bugs == {"none", "noDedupe", "noHoldCheck", "noFreshGuard", "noWriteGuard",
         "noNotice", "noGoalCheckOnTicket", "completeRuns"}
ASSUME Bug \in Bugs

Goals == {"none", "active", "paused", "awaiting", "complete"}

VARIABLES
    goal,          \* состояние цели
    epoch,         \* эпоха: растёт на реплике владельца, смене ветки и цели
    agent,         \* "idle" | "running"
    outcome,       \* исход текущего прогона: "ok" | "error"
    queue,         \* билеты в очереди Pi: [e |-> эпоха, k |-> "goal" | "checkpoint"]
    ownerReplied,  \* после awaiting пришла настоящая реплика владельца
    writeUnknown,  \* исход записи состояния в журнал неизвестен
    checkpoint,    \* "none" | "pending" | "compacting"
    subagents,     \* число работающих фоновых сабагентов (0..1)
    errorTimer,    \* взведена пауза перед повтором после ошибки
    notice,        \* владелец видит уведомление, почему работа стоит
    bad            \* первое нарушение безопасности: "" или имя свойства

vars == <<goal, epoch, agent, outcome, queue, ownerReplied, writeUnknown,
          checkpoint, subagents, errorTimer, notice, bad>>

Init ==
    /\ goal = "none"
    /\ epoch = 0
    /\ agent = "idle"
    /\ outcome = "ok"
    /\ queue = <<>>
    /\ ownerReplied = FALSE
    /\ writeUnknown = FALSE
    /\ checkpoint = "none"
    /\ subagents = 0
    /\ errorTimer = FALSE
    /\ notice = FALSE
    /\ bad = ""

-----------------------------------------------------------------------------
(* Правила ядра. Именно их повторяет код в src/core.                       *)

NoTicket == [e |-> 0, k |-> "settle"]

Fresh(t) == t.e = epoch

FreshTickets == {i \in 1..Len(queue) : Fresh(queue[i])}

\* Цель разрешает работу без владельца.
GoalRuns == CASE Bug = "noHoldCheck"  -> goal \in {"active", "awaiting"}
              [] Bug = "completeRuns" -> goal \in {"active", "complete"}
              [] OTHER                -> goal = "active"

WriteBlocks == IF Bug = "noWriteGuard" THEN FALSE ELSE writeUnknown

\* Положить билет, если свежего ещё нет.
EnqueueKind(k) ==
    IF (Bug # "noDedupe" /\ FreshTickets # {}) \/ Len(queue) >= MaxQueue
    THEN queue
    ELSE Append(queue, [e |-> epoch, k |-> k])

Enqueue == EnqueueKind("goal")

\* Запуск работы без реплики владельца: фиксируем нарушения П2–П5.
\* Продолжение после сжатия по запросу агента законно и без цели, и после
\* закрытия цели: агент сам попросил сжать и продолжить.
CheckAutonomousStart(t) ==
    bad' = IF bad # "" THEN bad
           ELSE IF t # NoTicket /\ ~Fresh(t) THEN "P5_StaleTicket"
           ELSE IF goal \in {"awaiting", "paused"} THEN "P2_HoldBroken"
           ELSE IF goal \in {"complete", "none"} /\ ~(t # NoTicket /\ t.k = "checkpoint")
                THEN "P3_DeadGoalRevived"
           ELSE IF writeUnknown THEN "P4_UnknownWrite"
           ELSE ""

-----------------------------------------------------------------------------
(* События владельца *)

OwnerInput ==
    /\ epoch < MaxEpoch
    /\ epoch' = epoch + 1
    /\ agent' = "running"
    /\ outcome' = "ok"
    /\ ownerReplied' = (goal = "awaiting" \/ ownerReplied)
    /\ notice' = FALSE
    /\ errorTimer' = FALSE
    /\ UNCHANGED <<goal, queue, writeUnknown, checkpoint, subagents, bad>>

\* /gr: возобновление паузы командой. Билет, а не прямой запуск: команда
\* приходит в простое, работу начнёт доставка.
ResumeCommand ==
    /\ agent = "idle"
    /\ goal = "paused"
    /\ epoch < MaxEpoch
    /\ goal' = "active"
    /\ epoch' = epoch + 1
    /\ queue' = Append(queue, [e |-> epoch + 1, k |-> "goal"])
    /\ notice' = FALSE
    /\ UNCHANGED <<agent, outcome, ownerReplied, writeUnknown, checkpoint,
                   subagents, errorTimer, bad>>

\* /gc: очистка цели в любой момент.
ClearGoal ==
    /\ goal # "none"
    /\ epoch < MaxEpoch
    /\ goal' = "none"
    /\ epoch' = epoch + 1
    /\ errorTimer' = FALSE
    /\ UNCHANGED <<agent, outcome, queue, ownerReplied, writeUnknown,
                   checkpoint, subagents, notice, bad>>

\* Смена ветки или сессии: только в простое.
SwitchBranch ==
    /\ agent = "idle"
    /\ epoch < MaxEpoch
    /\ epoch' = epoch + 1
    /\ checkpoint' = "none"
    /\ errorTimer' = FALSE
    \* На новой ветке активная цель сама не продолжается: владелец видит,
    \* что она активна, и решает сам.
    /\ notice' = (goal = "active")
    /\ UNCHANGED <<goal, agent, outcome, queue, ownerReplied, writeUnknown,
                   subagents, bad>>

Abort ==
    /\ agent = "running"
    /\ agent' = "idle"
    /\ goal' = IF goal = "active" THEN "paused" ELSE goal
    /\ checkpoint' = "none"
    /\ notice' = TRUE
    /\ UNCHANGED <<epoch, outcome, queue, ownerReplied, writeUnknown,
                   subagents, errorTimer, bad>>

-----------------------------------------------------------------------------
(* Инструменты агента внутри прогона *)

CreateGoal ==
    /\ agent = "running"
    /\ goal \in {"none", "complete"}
    /\ epoch < MaxEpoch
    /\ goal' = "active"
    /\ epoch' = epoch + 1
    /\ ownerReplied' = FALSE
    /\ UNCHANGED <<agent, outcome, queue, writeUnknown, checkpoint,
                   subagents, errorTimer, notice, bad>>

ReportAwaiting ==
    /\ agent = "running"
    /\ goal = "active"
    /\ goal' = "awaiting"
    /\ ownerReplied' = FALSE
    /\ UNCHANGED <<epoch, agent, outcome, queue, writeUnknown, checkpoint,
                   subagents, errorTimer, notice, bad>>

\* Снять ожидание может только отчёт working после настоящей реплики.
ReportWorking ==
    /\ agent = "running"
    /\ goal = "awaiting"
    /\ ownerReplied
    /\ goal' = "active"
    /\ ownerReplied' = FALSE
    /\ UNCHANGED <<epoch, agent, outcome, queue, writeUnknown, checkpoint,
                   subagents, errorTimer, notice, bad>>

CompleteGoal ==
    /\ agent = "running"
    /\ goal = "active"
    /\ goal' = "complete"
    /\ UNCHANGED <<epoch, agent, outcome, queue, ownerReplied, writeUnknown,
                   checkpoint, subagents, errorTimer, notice, bad>>

RequestCheckpoint ==
    /\ agent = "running"
    /\ checkpoint = "none"
    /\ checkpoint' = "pending"
    /\ UNCHANGED <<goal, epoch, agent, outcome, queue, ownerReplied,
                   writeUnknown, subagents, errorTimer, notice, bad>>

StartSubagent ==
    /\ agent = "running"
    /\ subagents = 0
    /\ subagents' = 1
    /\ UNCHANGED <<goal, epoch, agent, outcome, queue, ownerReplied,
                   writeUnknown, checkpoint, errorTimer, notice, bad>>

ProviderError ==
    /\ agent = "running"
    /\ outcome' = "error"
    /\ UNCHANGED <<goal, epoch, agent, queue, ownerReplied, writeUnknown,
                   checkpoint, subagents, errorTimer, notice, bad>>

-----------------------------------------------------------------------------
(* Журнал *)

WriteBecomesUnknown ==
    /\ ~writeUnknown
    /\ writeUnknown' = TRUE
    /\ UNCHANGED <<goal, epoch, agent, outcome, queue, ownerReplied,
                   checkpoint, subagents, errorTimer, notice, bad>>

\* Исход выяснен. В простое с активной целью ядро ставит билет.
WriteResolved ==
    /\ writeUnknown
    /\ writeUnknown' = FALSE
    /\ queue' = IF agent = "idle" /\ goal = "active" THEN Enqueue ELSE queue
    /\ UNCHANGED <<goal, epoch, agent, outcome, ownerReplied, checkpoint,
                   subagents, errorTimer, notice, bad>>

-----------------------------------------------------------------------------
(* Граница agent_before_settle: главное решение ядра *)

ContinueAtSettle ==
    /\ GoalRuns
    /\ ~WriteBlocks
    /\ subagents = 0
    /\ checkpoint = "none"
    /\ outcome = "ok"

BeforeSettle ==
    /\ agent = "running"
    /\ IF ContinueAtSettle
       THEN /\ CheckAutonomousStart(NoTicket)
            /\ UNCHANGED <<agent, outcome, checkpoint, errorTimer, notice>>
       ELSE /\ agent' = "idle"
            /\ checkpoint' = IF checkpoint = "pending" THEN "compacting" ELSE checkpoint
            /\ errorTimer' = (outcome = "error" /\ goal = "active")
            \* Ядро объясняет любую остановку активной цели, кроме тех, что
            \* сами завершатся: сжатие, сабагент, пауза перед повтором.
            /\ notice' = IF Bug = "noNotice" THEN notice
                         ELSE (notice \/ (goal = "active" /\ writeUnknown))
            /\ UNCHANGED bad
            /\ outcome' = "ok"
    /\ UNCHANGED <<goal, epoch, queue, ownerReplied, writeUnknown, subagents>>

-----------------------------------------------------------------------------
(* Пути из простоя *)

CompactDone ==
    /\ agent = "idle"
    /\ checkpoint = "compacting"
    /\ checkpoint' = "none"
    /\ queue' = EnqueueKind("checkpoint")   \* продолжение сжатия нужно и без цели
    /\ UNCHANGED <<goal, epoch, agent, outcome, ownerReplied, writeUnknown,
                   subagents, errorTimer, notice, bad>>

SubagentDone ==
    /\ subagents = 1
    /\ subagents' = 0
    /\ queue' = IF agent = "idle" /\ goal = "active" THEN Enqueue ELSE queue
    /\ UNCHANGED <<goal, epoch, agent, outcome, ownerReplied, writeUnknown,
                   checkpoint, errorTimer, notice, bad>>

TimerFire ==
    /\ errorTimer
    /\ agent = "idle"
    /\ errorTimer' = FALSE
    /\ queue' = IF goal = "active" THEN Enqueue ELSE queue
    /\ UNCHANGED <<goal, epoch, agent, outcome, ownerReplied, writeUnknown,
                   checkpoint, subagents, notice, bad>>

\* Доставка билета. В простое билет запускает прогон, и before_agent_start
\* сверяет его: годный продолжает работу, негодный прерывает прогон до
\* запроса к модели. Во время прогона билет вливается в него как follow-up;
\* такой билет всегда устарел, и сборка окна заменяет его текст пустой
\* пометкой.
TicketAdmissible(t) ==
    /\ (Bug = "noFreshGuard" \/ Fresh(t))
    /\ (Bug = "noGoalCheckOnTicket" \/ GoalRuns
        \/ (t.k = "checkpoint" /\ goal \in {"none", "complete"}))
    /\ ~WriteBlocks

DeliverIdle ==
    /\ agent = "idle"
    /\ queue # <<>>
    /\ LET t == Head(queue) IN
       IF TicketAdmissible(t)
       THEN /\ agent' = "running"
            /\ outcome' = "ok"
            /\ CheckAutonomousStart(t)
            /\ UNCHANGED notice
       ELSE /\ UNCHANGED <<agent, outcome, bad>>
            \* Сброс годного по свежести билета из-за неизвестной записи
            \* объясняется владельцу.
            /\ notice' = (notice \/ (goal = "active" /\ writeUnknown))
    /\ queue' = Tail(queue)
    /\ UNCHANGED <<goal, epoch, ownerReplied, writeUnknown, checkpoint,
                   subagents, errorTimer>>

DeliverRunning ==
    /\ agent = "running"
    /\ queue # <<>>
    /\ LET t == Head(queue) IN
       bad' = IF bad = "" /\ Bug = "noFreshGuard" /\ ~Fresh(t)
              THEN "P5_StaleTicket" ELSE bad
    /\ queue' = Tail(queue)
    /\ UNCHANGED <<goal, epoch, agent, outcome, ownerReplied, writeUnknown,
                   checkpoint, subagents, errorTimer, notice>>

-----------------------------------------------------------------------------

Next ==
    \/ OwnerInput \/ ResumeCommand \/ ClearGoal \/ SwitchBranch \/ Abort
    \/ CreateGoal \/ ReportAwaiting \/ ReportWorking \/ CompleteGoal
    \/ RequestCheckpoint \/ StartSubagent \/ ProviderError
    \/ WriteBecomesUnknown \/ WriteResolved
    \/ BeforeSettle
    \/ CompactDone \/ SubagentDone \/ TimerFire \/ DeliverIdle \/ DeliverRunning

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Свойства *)

TypeOK ==
    /\ goal \in Goals
    /\ agent \in {"idle", "running"}
    /\ checkpoint \in {"none", "pending", "compacting"}
    /\ subagents \in 0..1

\* П1. В очереди не больше одного свежего билета.
P1_OneContinuation == Cardinality(FreshTickets) <= 1

\* П2–П5. Работа без владельца не начинается по ожидающей, закрытой,
\* очищенной цели, при неизвестной записи и по устаревшему билету.
P2_HoldHolds       == bad # "P2_HoldBroken"
P3_NoRevival       == bad # "P3_DeadGoalRevived"
P4_NoUnknownWrite  == bad # "P4_UnknownWrite"
P5_NoStaleTicket   == bad # "P5_StaleTicket"

\* П6. Активная цель в простое не стоит молча: есть свежий билет, сжатие,
\* сабагент, пауза перед повтором или уведомление владельцу.
P6_NoSilentStall ==
    (agent = "idle" /\ goal = "active")
        => \/ FreshTickets # {}
           \/ checkpoint # "none"
           \/ subagents > 0
           \/ errorTimer
           \/ notice

=============================================================================
