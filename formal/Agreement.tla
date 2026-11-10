----------------------------- MODULE Agreement -----------------------------
(***************************************************************************)
(* Модель 2. Договорённость в окне модели и закрытие цели.                 *)
(*                                                                         *)
(* Договорённость — текст, который модель написала при создании цели и     *)
(* переписывает по реплике владельца. Расширение хранит её редакции и при  *)
(* каждом запросе к модели после сжатия кладёт в окно одну копию последней *)
(* редакции. Раздел «Цель» в сводке сжатия при этом заменяется: сводку     *)
(* пишет модель, и она может пересказать цель своими словами.              *)
(*                                                                         *)
(* Закрытие идёт в два шага: первая попытка возвращает договорённость,     *)
(* вторая закрывает, если с тех пор не менялись ни договорённость, ни план *)
(* и есть отчёт verifying по тем же версиям.                               *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Bug, MaxRev

Bugs == {"none", "noStrip", "staleCache", "ignoreRevisions", "noVerifying",
         "noOwnerCheck"}
ASSUME Bug \in Bugs

NoRev == <<0, 0>>

VARIABLES
    goal,        \* "none" | "open" | "complete"
    agRev,       \* редакция договорённости (включая «Решаю сам»)
    planRev,     \* версия плана
    returned,    \* для каких версий договорённость уже возвращена при закрытии
    verifying,   \* для каких версий есть отчёт verifying
    running,     \* идёт прогон
    ownerTurn,   \* прогон начат или дополнен настоящей репликой владельца
    compacted,   \* было сжатие: в окне сводка, а не исходный разговор
    summaryCopy, \* модель пересказала цель в сводке
    cachedRev,   \* редакция, которую видит сборщик окна
    bad

vars == <<goal, agRev, planRev, returned, verifying, running, ownerTurn,
          compacted, summaryCopy, cachedRev, bad>>

Cur == <<agRev, planRev>>

Init ==
    /\ goal = "none"
    /\ agRev = 0
    /\ planRev = 0
    /\ returned = NoRev
    /\ verifying = NoRev
    /\ running = FALSE
    /\ ownerTurn = FALSE
    /\ compacted = FALSE
    /\ summaryCopy = FALSE
    /\ cachedRev = 0
    /\ bad = ""

Flag(name) == bad' = IF bad = "" THEN name ELSE bad

\* Сборщик окна берёт договорённость из состояния цели. С поломкой
\* staleCache он держит снимок, сделанный при сжатии.
WindowRev == IF Bug = "staleCache" THEN cachedRev ELSE agRev

-----------------------------------------------------------------------------

OwnerInput ==
    /\ running' = TRUE
    /\ ownerTurn' = TRUE
    /\ UNCHANGED <<goal, agRev, planRev, returned, verifying, compacted,
                   summaryCopy, cachedRev, bad>>

AutonomousStart ==
    /\ ~running
    /\ goal = "open"
    /\ running' = TRUE
    /\ ownerTurn' = FALSE
    /\ UNCHANGED <<goal, agRev, planRev, returned, verifying, compacted,
                   summaryCopy, cachedRev, bad>>

EndRun ==
    /\ running
    /\ running' = FALSE
    /\ ownerTurn' = FALSE
    /\ UNCHANGED <<goal, agRev, planRev, returned, verifying, compacted,
                   summaryCopy, cachedRev, bad>>

CreateGoal ==
    /\ running /\ ownerTurn
    /\ goal \in {"none", "complete"}
    /\ goal' = "open"
    /\ agRev' = 1
    /\ planRev' = 0
    /\ returned' = NoRev
    /\ verifying' = NoRev
    /\ UNCHANGED <<running, ownerTurn, compacted, summaryCopy, cachedRev, bad>>

\* Новая редакция договорённости или смена состояния пункта «Решаю сам».
EditAgreement ==
    /\ running
    /\ goal = "open"
    /\ agRev < MaxRev
    /\ (ownerTurn \/ Bug = "noOwnerCheck")
    /\ agRev' = agRev + 1
    /\ IF ownerTurn THEN UNCHANGED bad ELSE Flag("P9_AutonomousEdit")
    /\ UNCHANGED <<goal, planRev, returned, verifying, running, ownerTurn,
                   compacted, summaryCopy, cachedRev>>

UpdatePlan ==
    /\ running
    /\ goal = "open"
    /\ planRev < MaxRev
    /\ planRev' = planRev + 1
    /\ UNCHANGED <<goal, agRev, returned, verifying, running, ownerTurn,
                   compacted, summaryCopy, cachedRev, bad>>

ReportVerifying ==
    /\ running
    /\ goal = "open"
    /\ verifying' = Cur
    /\ UNCHANGED <<goal, agRev, planRev, returned, running, ownerTurn,
                   compacted, summaryCopy, cachedRev, bad>>

\* Попытка закрыть. Ядро сравнивает версии; поломки упрощают сравнение.
ReturnedOk == IF Bug = "ignoreRevisions" THEN returned # NoRev ELSE returned = Cur
VerifyingOk == IF Bug = "noVerifying" THEN TRUE ELSE verifying = Cur

CompleteAttempt ==
    /\ running
    /\ goal = "open"
    /\ IF ReturnedOk /\ VerifyingOk
       THEN /\ goal' = "complete"
            /\ IF returned = Cur /\ verifying = Cur
               THEN UNCHANGED bad ELSE Flag("P8_StaleClose")
            /\ UNCHANGED returned
       ELSE /\ returned' = Cur          \* вернуть договорённость модели
            /\ UNCHANGED <<goal, bad>>
    /\ UNCHANGED <<agRev, planRev, verifying, running, ownerTurn, compacted,
                   summaryCopy, cachedRev>>

\* Сжатие: модель пишет сводку и может пересказать в ней цель.
Compact ==
    /\ compacted' = TRUE
    /\ summaryCopy' \in BOOLEAN
    /\ cachedRev' = agRev
    /\ UNCHANGED <<goal, agRev, planRev, returned, verifying, running,
                   ownerTurn, bad>>

\* Запрос к модели: сборщик окна строит его из сводки и состояния цели.
Request ==
    /\ running
    /\ compacted
    /\ LET stripped == goal = "open" /\ Bug # "noStrip"
           copies   == (IF summaryCopy /\ ~stripped THEN 1 ELSE 0)
                       + (IF goal = "open" THEN 1 ELSE 0)
           injected == IF goal = "open" THEN WindowRev ELSE 0
       IN IF goal = "open" => (copies = 1 /\ injected = agRev)
          THEN UNCHANGED bad
          ELSE Flag("P7_OneCurrentAgreement")
    /\ UNCHANGED <<goal, agRev, planRev, returned, verifying, running,
                   ownerTurn, compacted, summaryCopy, cachedRev>>

Next ==
    \/ OwnerInput \/ AutonomousStart \/ EndRun
    \/ CreateGoal \/ EditAgreement \/ UpdatePlan \/ ReportVerifying
    \/ CompleteAttempt \/ Compact \/ Request

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Свойства *)

TypeOK ==
    /\ goal \in {"none", "open", "complete"}
    /\ agRev \in 0..MaxRev
    /\ planRev \in 0..MaxRev

\* П7. После сжатия при незакрытой цели в окне ровно одна договорённость,
\* и это последняя редакция.
P7_OneCurrentAgreement == bad # "P7_OneCurrentAgreement"

\* П8. Цель закрывается только после возврата договорённости и отчёта
\* verifying для текущих версий договорённости и плана.
P8_NoStaleClose == bad # "P8_StaleClose"

\* П9. Договорённость и «Решаю сам» меняются только в прогоне владельца.
P9_OwnerOnlyEdits == bad # "P9_AutonomousEdit"

=============================================================================
