----------------------------- MODULE Agreement -----------------------------
(***************************************************************************)
(* Модель 2. Договорённость в окне модели и закрытие цели.                 *)
(*                                                                         *)
(* Договорённость — текст, который модель написала при создании цели и     *)
(* переписывает по реплике владельца. После сжатия расширение кладёт в     *)
(* начало окна одну копию договорённости той цели, что была открыта при    *)
(* сжатии, в редакции на момент сжатия (решение 0012): начало окна до      *)
(* следующего сжатия не меняется, иначе провайдер заново пишет кэш всего    *)
(* хвоста. Новая редакция остаётся в конце окна — в вызове и ответе        *)
(* amend_goal, — а закрытие цели — пометкой в ответе update_goal. Другая   *)
(* открытая цель сразу встаёт в начало окна. Раздел «Цель» в сводке при    *)
(* договорённости в начале окна вырезается: сводку пишет модель, и она     *)
(* может пересказать цель своими словами.                                  *)
(*                                                                         *)
(* Закрытие идёт в два шага: первая попытка возвращает договорённость,     *)
(* вторая закрывает, если с тех пор не менялись ни договорённость, ни план *)
(* и есть отчёт verifying по тем же версиям.                               *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Bug, MaxRev

Bugs == {"none", "noStrip", "liveHead", "noTailCopy", "noCloseNote",
         "ignoreRevisions", "noVerifying", "noOwnerCheck"}

MaxGen == 2
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
    gen,         \* какая по счёту цель поставлена
    headOpen,    \* при последнем сжатии цель была открыта
    headGen,     \* какая цель была открыта при последнем сжатии
    cachedRev,   \* её редакция договорённости на момент сжатия
    tailRev,     \* редакция, показанная в конце окна после сжатия (0 — нет)
    closedNote,  \* в конце окна есть пометка о закрытии цели
    bad

vars == <<goal, agRev, planRev, returned, verifying, running, ownerTurn,
          compacted, summaryCopy, gen, headOpen, headGen, cachedRev, tailRev,
          closedNote, bad>>

\* Переменные окна, которые не трогают действия прогона и цели.
win == <<compacted, summaryCopy, headOpen, headGen, cachedRev>>

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
    /\ gen = 0
    /\ headOpen = FALSE
    /\ headGen = 0
    /\ cachedRev = 0
    /\ tailRev = 0
    /\ closedNote = FALSE
    /\ bad = ""

Flag(name) == bad' = IF bad = "" THEN name ELSE bad

\* Начало окна держит цель, открытую при сжатии, пока не поставлена другая.
SameGoal == headOpen /\ headGen = gen
\* Что стоит после сводки: договорённость (и какой редакции) или ничего.
TopShown == SameGoal \/ goal = "open"
TopRev == IF SameGoal /\ Bug # "liveHead" THEN cachedRev
          ELSE IF goal = "open" THEN agRev ELSE 0

-----------------------------------------------------------------------------

OwnerInput ==
    /\ running' = TRUE
    /\ ownerTurn' = TRUE
    /\ UNCHANGED <<goal, agRev, planRev, returned, verifying, gen, tailRev,
                   closedNote, bad>>
    /\ UNCHANGED win

AutonomousStart ==
    /\ ~running
    /\ goal = "open"
    /\ running' = TRUE
    /\ ownerTurn' = FALSE
    /\ UNCHANGED <<goal, agRev, planRev, returned, verifying, gen, tailRev,
                   closedNote, bad>>
    /\ UNCHANGED win

EndRun ==
    /\ running
    /\ running' = FALSE
    /\ ownerTurn' = FALSE
    /\ UNCHANGED <<goal, agRev, planRev, returned, verifying, gen, tailRev,
                   closedNote, bad>>
    /\ UNCHANGED win

CreateGoal ==
    /\ running /\ ownerTurn
    /\ goal \in {"none", "complete"}
    /\ gen < MaxGen
    /\ goal' = "open"
    /\ gen' = gen + 1
    /\ agRev' = 1
    /\ planRev' = 0
    /\ returned' = NoRev
    /\ verifying' = NoRev
    /\ tailRev' = 1          \* договорённость в вызове create_goal
    /\ closedNote' = FALSE
    /\ UNCHANGED <<running, ownerTurn, bad>>
    /\ UNCHANGED win

\* Новая редакция договорённости или смена состояния пункта «Решаю сам».
EditAgreement ==
    /\ running
    /\ goal = "open"
    /\ agRev < MaxRev
    /\ (ownerTurn \/ Bug = "noOwnerCheck")
    /\ agRev' = agRev + 1
    \* Полный текст новой редакции — в вызове и ответе amend_goal, в конце окна.
    /\ tailRev' = IF Bug = "noTailCopy" THEN tailRev ELSE agRev + 1
    /\ IF ownerTurn THEN UNCHANGED bad ELSE Flag("P9_AutonomousEdit")
    /\ UNCHANGED <<goal, planRev, returned, verifying, running, ownerTurn,
                   gen, closedNote>>
    /\ UNCHANGED win

UpdatePlan ==
    /\ running
    /\ goal = "open"
    /\ planRev < MaxRev
    /\ planRev' = planRev + 1
    /\ UNCHANGED <<goal, agRev, returned, verifying, running, ownerTurn,
                   gen, tailRev, closedNote, bad>>
    /\ UNCHANGED win

ReportVerifying ==
    /\ running
    /\ goal = "open"
    /\ verifying' = Cur
    /\ UNCHANGED <<goal, agRev, planRev, returned, running, ownerTurn,
                   gen, tailRev, closedNote, bad>>
    /\ UNCHANGED win

\* Попытка закрыть. Ядро сравнивает версии; поломки упрощают сравнение.
ReturnedOk == IF Bug = "ignoreRevisions" THEN returned # NoRev ELSE returned = Cur
VerifyingOk == IF Bug = "noVerifying" THEN TRUE ELSE verifying = Cur

CompleteAttempt ==
    /\ running
    /\ goal = "open"
    /\ IF ReturnedOk /\ VerifyingOk
       THEN /\ goal' = "complete"
            \* Ответ update_goal говорит, что договорённость в начале окна больше не действует.
            /\ closedNote' = (Bug # "noCloseNote")
            /\ IF returned = Cur /\ verifying = Cur
               THEN UNCHANGED bad ELSE Flag("P8_StaleClose")
            /\ UNCHANGED returned
       ELSE /\ returned' = Cur          \* вернуть договорённость модели
            /\ UNCHANGED <<goal, bad, closedNote>>
    /\ UNCHANGED <<agRev, planRev, verifying, running, ownerTurn, gen, tailRev>>
    /\ UNCHANGED win

\* Сжатие: модель пишет сводку и может пересказать в ней цель. Начало окна
\* фиксируется по цели на этот момент; конец окна начинается заново.
Compact ==
    /\ compacted' = TRUE
    /\ summaryCopy' \in BOOLEAN
    /\ headOpen' = (goal = "open")
    /\ headGen' = gen
    /\ cachedRev' = agRev
    /\ tailRev' = 0
    /\ closedNote' = FALSE
    /\ UNCHANGED <<goal, agRev, planRev, returned, verifying, running,
                   ownerTurn, gen, bad>>

\* Запрос к модели: сборщик окна строит его из сводки и состояния цели.
Request ==
    /\ running
    /\ compacted
    /\ LET stripped == TopShown /\ Bug # "noStrip"
           copies   == (IF summaryCopy /\ ~stripped THEN 1 ELSE 0)
                       + (IF TopShown THEN 1 ELSE 0)
           current  == TopRev = agRev \/ tailRev = agRev
       IN CASE goal = "open" /\ ~(copies = 1 /\ current) ->
                  Flag("P7_OneCurrentAgreement")
            [] SameGoal /\ TopRev # cachedRev ->
                  Flag("P14_StableHead")
            [] goal = "complete" /\ SameGoal /\ ~closedNote ->
                  Flag("P15_ClosedNoted")
            [] OTHER -> UNCHANGED bad
    /\ UNCHANGED <<goal, agRev, planRev, returned, verifying, running,
                   ownerTurn, gen, tailRev, closedNote>>
    /\ UNCHANGED win

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
    /\ gen \in 0..MaxGen

\* П7. После сжатия при незакрытой цели в начале окна ровно одна
\* договорённость, а последняя редакция видна в начале или в конце окна.
P7_OneCurrentAgreement == bad # "P7_OneCurrentAgreement"

\* П14. Пока в начале окна та же цель, оно не меняется до следующего сжатия.
P14_StableHead == bad # "P14_StableHead"

\* П15. Договорённость закрытой цели в начале окна идёт с пометкой о закрытии.
P15_ClosedNoted == bad # "P15_ClosedNoted"

\* П8. Цель закрывается только после возврата договорённости и отчёта
\* verifying для текущих версий договорённости и плана.
P8_NoStaleClose == bad # "P8_StaleClose"

\* П9. Договорённость и «Решаю сам» меняются только в прогоне владельца.
P9_OwnerOnlyEdits == bad # "P9_AutonomousEdit"

=============================================================================
