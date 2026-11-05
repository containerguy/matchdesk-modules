# SMS

Schickt Rundnachrichten und Erinnerungen zu Events per SMS. Versendet wird über ein Android-Handy mit der
App [SMS Gateway for Android](https://sms-gate.app), also über dessen Tarif (ohne SMS-Flatrate kostet das Geld).

## Einrichten

1. App „SMS Gateway for Android“ auf dem Handy installieren und starten.
2. **Cloud-Modus** (empfohlen, das Handy muss nicht im selben Netz wie Matchdesk sein):
   in der App „Cloud server“ einschalten. Die App zeigt Benutzername und Passwort.
   **Heimnetz-Modus**: „Local server“ einschalten; die App zeigt IP, Port, Benutzername und Passwort.
3. Modul unter Admin › Module installieren und in den Einstellungen den Benutzernamen eintragen.
   Für den Heimnetz-Modus die Adresse auf `http://<IP-des-Handys>:8080/message` ändern.
4. Darunter unter **Zugangsdaten** das Passwort bei `SMS_PASSWORD` eintragen (verschlüsselt gespeichert,
   das Modul startet sofort neu). Alternativ die Umgebungsvariable `MATCHDESK_SMS_PASSWORD` setzen (hat
   Vorrang, braucht einen Neustart; vor Matchdesk 0.21 der einzige Weg).
5. Unter Admin › Module › SMS „Test-SMS an meine Nummer“ drücken (braucht eine Handynummer im eigenen Profil).

Danach können Benutzer im Profil unter Benachrichtigungen den Kanal „SMS“ einschalten. Er ist nur
erreichbar, wenn im Profil eine Handynummer steht und der Benutzer das Recht `sms.receive` hat
(Vorgabe: alle Benutzer). Wer das wegen der Kosten einschränken will, nimmt das Recht der Rolle
„Benutzer“ weg und vergibt es einzeln.

## Einstellungen

- **Adresse**: Cloud `https://api.sms-gate.app/3rdparty/v1/messages`, Heimnetz `http://<IP>:8080/message`
- **Benutzername** aus der App, **Geräte-ID** nur bei mehreren Handys im Konto
- **Vorwahl** für Nummern ohne Ländervorwahl (Vorgabe `+49`, aus `0171…` wird `+49171…`)
- **Höchstlänge** pro Nachricht (Vorgabe 306 Zeichen, zwei SMS), **Tageslimit** (Vorgabe 100)
- **Link anhängen** zur App, wenn `MATCHDESK_PUBLIC_URL` gesetzt ist

Das Protokoll unter Admin › Module › SMS speichert nur Zeitpunkt, Empfänger-Konto und Ergebnis, keine
Nummern und keine Texte, und wird nach 90 Tagen gelöscht.
