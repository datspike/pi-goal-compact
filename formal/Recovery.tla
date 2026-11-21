---------------------------- MODULE Recovery ----------------------------
(* Переполнение окна: попытки сжатия, обрыв ответа, пауза и возобновление. *)
EXTENDS Naturals
CONSTANT MaxAttempts, Bound, Bug
VARIABLES attempts, physical, status, continued, bad, phase
vars == <<attempts, physical, status, continued, bad, phase>>

(* Переполнение: физический эпизод растёт всегда, попытки считает расширение. *)
Counted(next) ==
    /\ attempts' = next
    /\ physical' = physical + 1
    /\ status' = IF (next > MaxAttempts) /\ (Bug # "noPauseAfterCap") THEN "paused" ELSE status
    /\ phase' = IF next > MaxAttempts THEN "paused" ELSE "recovering"

Init == /\ attempts = 0 /\ physical = 0 /\ status = "active"
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
            /\ status' = status /\ phase' = "healthy"
       ELSE Counted(attempts + 1)
    /\ UNCHANGED <<continued, bad>>

(* Обычный обрыв ответа: переполнения нет, попытки сжатия не обнуляются. *)
LengthTurn ==
    /\ attempts' = IF Bug = "lengthResets" THEN 0 ELSE attempts
    /\ phase' = IF Bug = "lengthResets" /\ attempts = 0 THEN "healthy" ELSE phase
    /\ UNCHANGED <<physical, status, continued, bad>>

(* Эпизод закрыт: ход закончился с ответом или владелец написал сам. *)
Closed ==
    /\ attempts' = 0 /\ physical' = 0 /\ phase' = "healthy"
    /\ UNCHANGED <<status, continued, bad>>

SuccessTurn == Closed
OwnerInput == Closed

(* Возобновление после паузы — отдельное явное действие владельца. *)
Resume ==
    /\ attempts' = 0 /\ physical' = 0 /\ status' = "active" /\ phase' = "healthy"
    /\ UNCHANGED <<continued, bad>>

(* Скрытое продолжение: только по активной цели и вне эпизода переполнения. *)
Continue ==
    /\ ~continued
    /\ (status = "active" \/ Bug = "continueWhilePaused")
    /\ (physical = 0 \/ Bug = "continueWhileRecovering")
    /\ continued' = TRUE /\ phase' = "continued"
    /\ bad' = IF physical > 0 THEN "continued-while-recovering"
              ELSE IF status = "paused" THEN "continued-while-paused" ELSE bad
    /\ UNCHANGED <<attempts, physical, status>>

Next == Overflow \/ LengthOverflow \/ LengthTurn \/ SuccessTurn \/ OwnerInput \/ Resume \/ Continue
Spec == Init /\ [][Next]_vars

(* Скрытое продолжение не появляется, пока эпизод переполнения открыт. *)
P18_NoContinueWhileRecovering == bad # "continued-while-recovering"
(* Обрыв по length не обнуляет счётчик попыток сжатия. *)
P19_LengthKeepsAttempts == physical = 0 \/ attempts > 0
(* Больше MaxAttempts переполнений подряд без успеха заканчиваются паузой. *)
P20_RecoveryCapped == physical <= MaxAttempts \/ status = "paused"
(* Пауза снимается только явным возобновлением, а не репликой владельца. *)
P21_NoContinueWhilePaused == bad # "continued-while-paused"
=============================================================================
