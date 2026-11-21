---------------------------- MODULE Recovery ----------------------------
(* Переполнение окна: попытки сжатия, обрыв ответа и остановка работы. *)
EXTENDS Naturals
CONSTANT MaxAttempts, Bound, Bug
VARIABLES attempts, physical, paused, continued, bad, phase
vars == <<attempts, physical, paused, continued, bad, phase>>

(* Переполнение: физический эпизод растёт всегда, попытки считает расширение. *)
Counted(next) ==
    /\ attempts' = next
    /\ physical' = physical + 1
    /\ paused' = ((next > MaxAttempts) /\ (Bug # "noPauseAfterCap"))
    /\ phase' = IF next > MaxAttempts THEN "paused" ELSE "recovering"

Init == /\ attempts = 0 /\ physical = 0 /\ paused = FALSE
        /\ continued = FALSE /\ bad = "" /\ phase = "healthy"

(* Переполнение окна: Pi сообщает об ошибке, расширение считает попытку. *)
Overflow ==
    /\ phase \in {"healthy", "recovering"}
    /\ physical < Bound
    /\ Counted(attempts + 1)
    /\ UNCHANGED <<continued, bad>>

(* Обрыв по length без ответа — то же переполнение, только без текста ошибки. *)
LengthOverflow ==
    /\ phase \in {"healthy", "recovering"}
    /\ physical < Bound
    /\ IF Bug = "lengthIsSuccess"
       THEN /\ attempts' = 0 /\ physical' = physical + 1
            /\ paused' = FALSE /\ phase' = "healthy"
       ELSE Counted(attempts + 1)
    /\ UNCHANGED <<continued, bad>>

(* Обычный обрыв ответа: переполнения нет, попытки сжатия не обнуляются. *)
LengthTurn ==
    /\ attempts' = IF Bug = "lengthResets" THEN 0 ELSE attempts
    /\ paused' = IF Bug = "lengthResets" THEN FALSE ELSE paused
    /\ phase' = IF Bug = "lengthResets" /\ attempts = 0 THEN "healthy" ELSE phase
    /\ UNCHANGED <<physical, continued, bad>>

(* Ход закончился с ответом или владелец написал сам: эпизод закрыт. *)
Closed ==
    /\ attempts' = 0 /\ physical' = 0 /\ paused' = FALSE /\ phase' = "healthy"
    /\ UNCHANGED <<continued, bad>>

SuccessTurn == Closed
OwnerInput == Closed

(* Скрытое продолжение: только вне эпизода переполнения. *)
Continue ==
    /\ ~continued
    /\ (physical = 0 \/ Bug = "continueWhileRecovering")
    /\ continued' = TRUE /\ phase' = "continued"
    /\ bad' = IF physical > 0 THEN "continued-while-recovering" ELSE bad
    /\ UNCHANGED <<attempts, physical, paused>>

Next == Overflow \/ LengthOverflow \/ LengthTurn \/ SuccessTurn \/ OwnerInput \/ Continue
Spec == Init /\ [][Next]_vars

(* Скрытое продолжение не появляется, пока эпизод переполнения открыт. *)
P18_NoContinueWhileRecovering == bad # "continued-while-recovering"
(* Обрыв по length не обнуляет счётчик попыток сжатия. *)
P19_LengthKeepsAttempts == physical = 0 \/ attempts > 0
(* Больше MaxAttempts переполнений подряд без успеха заканчиваются паузой. *)
P20_RecoveryCapped == physical <= MaxAttempts \/ paused
=============================================================================
