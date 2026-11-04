# Abstimmungen

Abstimmungen über Spiele, Termine, Essen oder Freies, entweder allgemein oder für ein Event.

- **Spiele, Essen, Sonstiges**: eine oder (wenn erlaubt) mehrere Optionen ankreuzen.
- **Termin**: für jeden Vorschlag Ja, Vielleicht oder Nein.
- **Vorschläge**: auf Wunsch dürfen Teilnehmer eigene Optionen ergänzen. Eigene Vorschläge lassen sich
  zurückziehen, solange niemand anderes dafür gestimmt hat.
- **Geheim**: Namen sehen nur Verwalter, alle anderen nur die Zahlen.
- **Ende**: per Knopf, zu einem festen Zeitpunkt oder automatisch, wenn das Event beendet wird.
- Neue Abstimmungen melden sich per Push bei allen, die sie sehen (abschaltbar).

## Rechte

- `polls.view`: Menüpunkt und Abstimmungen sehen (Vorgabe: alle Benutzer)
- `polls.vote`: abstimmen und Vorschläge machen (Vorgabe: alle Benutzer, auch pro Event vergebbar)
- `polls.manage`: anlegen, schließen, Optionen entfernen, löschen (Vorgabe: ab Organisator, auch pro Event
  vergebbar, z. B. damit jemand nur für eine LAN die Abstimmungen betreut)

Abstimmungen privater Events sehen wie im Kern nur Eingeladene und wer Events verwalten darf.
