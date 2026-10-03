// Standard-Rollenvorlagen (global). Diese Texte sind bewusst neutral
// gehalten und koennen in den Einstellungen global oder pro Projekt
// ueberschrieben werden. Platzhalter werden bei der Prompt-Erzeugung
// im Main-Prozess ersetzt (siehe src/main/services/promptService.ts).
//
// Verfuegbare Platzhalter:
//   {{projectName}}        - Name des Projekts
//   {{projectType}}        - Projekttyp (z. B. "Roblox")
//   {{projectDescription}} - Beschreibung/Ziel des Projekts
//   {{projectStatus}}      - aktueller Status
//   {{currentStep}}        - aktueller Arbeitsschritt
//   {{nextAction}}         - naechste geplante Aktion
//   {{nextActor}}          - wer laut Statusmaschine als naechstes dran ist
//   {{contextVersion}}     - Versionsnummer des aktuellen Kontexts
//   {{contextMarkdown}}    - Inhalt der aktuellen Kontext-Version
//   {{concreteTask}}       - die konkrete, von Leon formulierte Aufgabe fuer diese Uebergabe
//
// WICHTIG: Es gibt bewusst KEINEN {{recentChat}}-Platzhalter. Der
// Projekt-Chat ist reine Chronik und darf nicht automatisch in neue
// Uebergaben einfliessen - massgeblich ist ausschliesslich die aktuelle
// Kontext-Version. Chat-Inhalte gelangen nur dann in einen Prompt, wenn
// Leon sie bewusst in die konkrete Aufgabe oder den Projekt-Kontext
// uebertraegt.

export const DEFAULT_CHATGPT_TEMPLATE = `Du bist Projektleiter fuer das Projekt "{{projectName}}" ({{projectType}}).

Projektbeschreibung: {{projectDescription}}

Aktueller Status: {{projectStatus}}
Aktueller Schritt: {{currentStep}}
Naechste Aktion: {{nextAction}}
Naechster Akteur laut Planung: {{nextActor}}
Kontext-Version: {{contextVersion}}

--- Projekt-Kontext (massgeblicher aktueller Stand) ---
{{contextMarkdown}}

--- Konkrete Aufgabe fuer diese Uebergabe ---
{{concreteTask}}

Bitte pruefe den obigen Stand und bearbeite ausschliesslich die konkrete
Aufgabe. Gib die naechsten Schritte, offene Entscheidungen oder Feedback
zur Planung zurueck.`

export const DEFAULT_CLAUDE_TEMPLATE = `Du bist technischer Entwickler fuer das Projekt "{{projectName}}" ({{projectType}}).

Projektbeschreibung: {{projectDescription}}

Aktueller Status: {{projectStatus}}
Aktueller Schritt: {{currentStep}}
Naechste Aktion: {{nextAction}}
Naechster Akteur laut Planung: {{nextActor}}
Kontext-Version: {{contextVersion}}

--- Projekt-Kontext (massgeblicher aktueller Stand) ---
{{contextMarkdown}}

--- Konkrete Aufgabe fuer diese Uebergabe ---
{{concreteTask}}

Bitte setze ausschliesslich die konkrete Aufgabe technisch um und melde
Ergebnisse, offene Probleme und notwendige Tests zurueck.`
