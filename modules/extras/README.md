# Event-Extras

Alles, was neben Anmeldung und Abstimmungen zur Vorbereitung eines Events gehört. Menüpunkt „Event-Extras“,
oben das Event auswählen, darunter die Reiter:

- **Mitbringen**: Verwalter legen fest, was gebraucht wird (optional mit Anzahl), alle tragen ein, was sie
  mitbringen. Wer selbst etwas ergänzt, bringt es automatisch mit.
- **Installieren**: Download- und Installationsliste mit Links (nur http/https), jeder hakt für sich ab.
- **Verleih**: Jeder bietet eigene Sachen an (Monitor, Controller, Headset), andere leihen sie aus. Besitzer
  und Verwalter können auch an jemanden verleihen. „Zurückgegeben“ geht auch nach dem Event; jedes Ausleihen
  und Zurückgeben steht im Audit-Log.
- **Beitrag**: Unkostenbeitrag pro Person mit optionalem PayPal-Link und Frist. Teilnehmer melden „per PayPal
  bezahlt“ oder „bar bezahlt“, Verwalter bestätigen (auch bar vor Ort ohne Meldung) und sehen, wer von den
  Zugesagten noch offen ist.
- **Fahrten**: Fahrer bieten Hin-, Rück- oder beide Fahrten mit freien Plätzen an, Mitfahrer tragen sich ein.
- **Fragen**: Zusatzfragen pro Event (Freitext, Ja/Nein, Auswahl), z. B. „bringe eigenen PC mit“ oder „Ankunft“.
  Verwalter laden die Antworten als CSV herunter.

Nach dem Eventende ist alles nur noch lesbar, außer Zurückgeben und dem Beitrag.

## Rechte

- `extras.view`: Menüpunkt sehen und mitmachen (Vorgabe: alle Benutzer)
- `extras.manage`: Listen pflegen, Beitrag festlegen und Zahlungen bestätigen, Fragen anlegen (Vorgabe: ab
  Organisator, auch pro Event vergebbar)

Private Events sehen wie im Kern nur Eingeladene und wer Events verwalten darf.

## Admin › Module › Event-Extras

Zeigt einen Kurzüberblick je laufendem Event (Anzahl Mitbringen/Installieren/Verleih/Fahrten/Fragen, ob ein
Beitrag gesetzt ist) mit einem Link direkt zur Modulseite. Die eigentliche Verwaltung (Listen pflegen,
Beitrag festlegen, Zahlungen bestätigen, Fragen anlegen) passiert dort, nicht auf der Admin-Seite.
