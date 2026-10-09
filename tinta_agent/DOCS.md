# Tinta Agent

## Deutsch

### Einrichtung (ca. 5 Minuten)

1. **Add-on installieren und starten.** Unter *Konfiguration* den
   **Installationscode** von Tinta Lab eintragen. Sie können auch den ganzen
   Installationslink einfügen, der Code wird automatisch erkannt.
2. **Leistungsbeginn bestätigen.** Den Installationslink auf Handy oder
   Computer öffnen und bestätigen. Home Assistant zeigt dazu eine Meldung
   mit dem Link an (Glocke links unten).
3. **Fertig.** Der Agent verbindet sich automatisch, die Meldung
   verschwindet. Weitere Einstellungen sind nicht nötig. Router, Portfreigaben
   und Subnetze spielen keine Rolle, solange das Gerät ins Internet kommt.

### Wenn etwas nicht klappt

Der Agent zeigt den Grund als Meldung in Home Assistant an:

| Meldung | Was tun |
|---|---|
| *Fast fertig: bitte Link öffnen …* | Link öffnen und bestätigen (Schritt 2). |
| *Code ungültig oder abgelaufen* | Neuen Code bei Tinta Lab anfordern, eintragen, Add-on neu starten. |
| *Tinta Lab nicht erreichbar* | Internetverbindung des Geräts prüfen. Der Agent versucht es weiter. |
| *Kein Installationscode* | Code unter *Konfiguration* eintragen, Add-on neu starten. |

## English

### Setup (about 5 minutes)

1. **Install and start the add-on.** Under *Configuration*, enter the
   **install code** from Tinta Lab. Pasting the whole install link works too.
2. **Confirm the service start.** Open the install link on a phone or
   computer and confirm. Home Assistant shows a notification with the link
   (bell icon, bottom left).
3. **Done.** The Agent connects by itself and the notification disappears.
   No router, port forwarding or subnet setup is needed, as long as the
   device has internet access.

### Troubleshooting

The Agent reports the reason as a Home Assistant notification:

| Notification | What to do |
|---|---|
| *Almost done: open the install link …* | Open the link and confirm (step 2). |
| *Install code invalid or expired* | Ask Tinta Lab for a new code, enter it, restart the add-on. |
| *Tinta Lab can't be reached* | Check the device's internet connection. The Agent keeps retrying. |
| *No install code entered* | Enter the code under *Configuration*, restart the add-on. |
