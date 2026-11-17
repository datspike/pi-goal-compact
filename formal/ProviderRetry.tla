-------------------------- MODULE ProviderRetry --------------------------
(* Повтор запроса на границе хода (решение 0020). Обычные билеты и удержания
   остаются в Continuation. Здесь различаем выбор модели и отправку запроса:
   отмена может прийти между ними, а выбор Pi завершается асинхронно. *)
EXTENDS Naturals
CONSTANT Bug
ASSUME Bug \in {"none", "raceEsc", "doubleOwner", "ignoreDeadline", "doubleSwitch"}

VARIABLES phase, epoch, admittedEpoch, now, holds, native, cancelled, model,
          switchCount, nextModel, bad
vars == <<phase, epoch, admittedEpoch, now, holds, native, cancelled, model,
          switchCount, nextModel, bad>>
Deadline == 2

Init ==
    /\ phase = "native"
    /\ epoch = 0 /\ admittedEpoch = 0 /\ now = 0
    /\ holds = FALSE /\ native = TRUE /\ cancelled = FALSE
    /\ model = "astra" /\ nextModel = "none" /\ switchCount = 0
    /\ bad = ""

Boundary ==
    /\ phase = "native"
    /\ phase' = "waiting" /\ native' = (Bug = "doubleOwner")
    /\ UNCHANGED <<epoch, admittedEpoch, now, holds, cancelled, model,
                   switchCount, nextModel, bad>>

Tick ==
    /\ now < Deadline + 1
    /\ now' = now + 1
    /\ UNCHANGED <<phase, epoch, admittedEpoch, holds, native, cancelled,
                   model, switchCount, nextModel, bad>>

Cancel ==
    /\ ~cancelled
    /\ cancelled' = TRUE /\ holds' = TRUE /\ epoch' = epoch + 1
    /\ UNCHANGED <<phase, admittedEpoch, now, native, model, switchCount, nextModel, bad>>

Live == ~cancelled /\ ~holds /\ epoch = admittedEpoch

ReserveAstra ==
    /\ phase = "waiting" /\ Live
    /\ model = "astra" /\ (now < Deadline \/ Bug = "ignoreDeadline")
    /\ phase' = "reserved" /\ nextModel' = "astra"
    /\ bad' = IF bad = "" /\ now >= Deadline THEN "late-astra" ELSE bad
    /\ UNCHANGED <<epoch, admittedEpoch, now, holds, native, cancelled, model, switchCount>>

SelectSol ==
    /\ phase = "waiting" /\ Live /\ now >= Deadline
    /\ (model = "astra" /\ switchCount = 0) \/ (Bug = "doubleSwitch" /\ switchCount = 1)
    /\ phase' = "selecting" /\ nextModel' = "sol"
    /\ UNCHANGED <<epoch, admittedEpoch, now, holds, native, cancelled, model, switchCount, bad>>

SelectionDone ==
    /\ phase = "selecting"
    /\ IF Live \/ Bug = "raceEsc"
       THEN /\ phase' = "reserved" /\ model' = "sol"
       ELSE /\ phase' = "finished" /\ model' = model
    /\ UNCHANGED <<epoch, admittedEpoch, now, holds, native, cancelled, switchCount, nextModel, bad>>

Send ==
    /\ phase = "reserved" /\ (Live \/ Bug = "raceEsc")
    /\ phase' = "native" /\ native' = TRUE /\ nextModel' = "none"
    /\ switchCount' = switchCount + (IF nextModel = "sol" THEN 1 ELSE 0)
    /\ bad' = IF bad # "" THEN bad
              ELSE IF ~Live THEN "stale"
              ELSE IF native THEN "two-owners"
              ELSE ""
    /\ UNCHANGED <<epoch, admittedEpoch, now, holds, cancelled, model>>

Next == Boundary \/ Tick \/ Cancel \/ ReserveAstra \/ SelectSol \/ SelectionDone \/ Send
Spec == Init /\ [][Next]_vars

RetryCancellation == bad # "stale"
RetryOneOwner == bad # "two-owners"
RetryDeadline == bad # "late-astra"
RetryOnlyOneSwitch == switchCount <= 1
=============================================================================
