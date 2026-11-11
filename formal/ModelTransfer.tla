---------------------------- MODULE ModelTransfer ----------------------------
(* Передача: сохранённое сжатие, применение модели и одно продолжение. *)
EXTENDS Naturals
CONSTANT Bug
VARIABLES phase, saved, switched, held, retry, resumes, bad
vars == <<phase, saved, switched, held, retry, resumes, bad>>
Init == /\ phase = "none" /\ saved = FALSE /\ switched = FALSE
        /\ held = FALSE /\ retry = FALSE /\ resumes = 0 /\ bad = ""
Request == /\ phase = "none"
           /\ phase' = "queued"
           /\ UNCHANGED <<saved, switched, held, retry, resumes, bad>>
Hold == /\ ~held /\ held' = TRUE
        /\ UNCHANGED <<phase, saved, switched, retry, resumes, bad>>
Compact == /\ phase = "queued"
           /\ phase' = "saved" /\ saved' = TRUE
           /\ retry' \in BOOLEAN
           /\ UNCHANGED <<switched, held, resumes, bad>>
Switch == /\ phase = "saved" \/ (Bug = "beforeSaved" /\ phase = "queued")
          /\ phase' = "applying"
          /\ bad' = IF ~saved THEN "unsaved" ELSE bad
          /\ UNCHANGED <<saved, switched, held, retry, resumes>>
Applied == /\ phase = "applying" /\ phase' = "ready" /\ switched' = TRUE
           /\ UNCHANGED <<saved, held, retry, resumes, bad>>
Failed == /\ phase \in {"queued", "saved", "applying"}
          /\ phase' = "failed"
          /\ UNCHANGED <<saved, switched, held, retry, resumes, bad>>
Resume == /\ phase = "ready" \/ (Bug = "earlyRequest" /\ phase = "applying")
          /\ (~held \/ Bug = "noHold")
          /\ resumes' = IF retry /\ Bug = "doubleResume" THEN 2 ELSE 1
          /\ bad' = IF ~switched THEN "oldModel" ELSE IF held THEN "hold" ELSE bad
          /\ phase' = "done"
          /\ UNCHANGED <<saved, switched, held, retry>>
Cancel == /\ phase \in {"queued", "saved", "applying", "ready"}
          /\ phase' = "cancelled"
          /\ UNCHANGED <<saved, switched, held, retry, resumes, bad>>
Next == Request \/ Hold \/ Compact \/ Switch \/ Applied \/ Failed \/ Resume \/ Cancel
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"none", "queued", "saved", "applying", "ready", "failed", "done", "cancelled"}
          /\ saved \in BOOLEAN /\ switched \in BOOLEAN /\ held \in BOOLEAN
          /\ retry \in BOOLEAN /\ resumes \in 0..2
P10_SavedBeforeSwitch == bad # "unsaved"
P11_SwitchedBeforeRequest == bad # "oldModel"
P12_OneTransferContinuation == resumes <= 1
P13_TransferRespectsHold == bad # "hold"
=============================================================================
