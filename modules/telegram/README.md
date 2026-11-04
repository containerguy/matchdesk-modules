# Telegram

Schickt Rundnachrichten und Erinnerungen zu Events über einen eigenen Telegram-Bot. Die Bot-API ist kostenlos.
Matchdesk fragt den Bot alle paar Sekunden nach neuen Nachrichten (Polling), braucht also keine öffentliche
Webhook-Adresse.

## Einrichten

1. In Telegram mit [@BotFather](https://t.me/BotFather) `/newbot` schreiben, Namen und Benutzernamen wählen
   (z. B. `MeineLanBot`). BotFather antwortet mit einem Token.
2. Den Token als Umgebungsvariable `MATCHDESK_TELEGRAM_BOT_TOKEN` setzen und Matchdesk neu starten.
3. Modul unter Admin › Module installieren. Unter Admin › Module › Telegram steht dann der Bot-Name.
4. Selbst im Menüpunkt **Telegram** auf „Telegram verknüpfen“ klicken, in Telegram „Starten“ tippen und
   unter Admin › Module › Telegram die Testnachricht schicken.

Benutzer verknüpfen ihr Konto genauso und schalten Telegram dann im Profil unter Benachrichtigungen ein.
Der Link gilt 15 Minuten und nur einmal. `/stop` im Bot-Chat oder „Verknüpfung lösen“ in Matchdesk trennt
wieder. Blockiert jemand den Bot, merkt Matchdesk das beim nächsten Versand und schickt nichts mehr, bis
neu verknüpft wird.

Ein Bot-Token gehört zu genau einer Matchdesk-Installation: Laufen zwei mit demselben Token oder ist für
den Bot ein Webhook gesetzt, meldet die Admin-Seite einen Fehler von Telegram.

## Rechte

- `telegram.receive`: Menüpunkt sehen, verknüpfen und Event-Infos bekommen (Vorgabe: alle Benutzer)
- `telegram.manage`: Admin-Seite mit Stand und Testnachricht (nur Admins)

## Einstellungen

- **Link anhängen** zur App, wenn `MATCHDESK_PUBLIC_URL` gesetzt ist
- **Abfrage alle … Sekunden** (Vorgabe 3)

Gespeichert werden nur Matchdesk-Konto, Telegram-Chat-ID, Telegram-Benutzername und Zeitpunkte.
