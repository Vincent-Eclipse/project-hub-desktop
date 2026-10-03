// Meilenstein 4.5 - Capabilities/Permissions-Vertragsschicht.
//
// Dies ist ein deterministisches, default-deny COARSE CAPABILITY GATE - es
// existiert BEVOR es eine allgemeine Ausfuehrungs-Engine gibt. Es fuehrt
// NICHTS aus, persistiert nichts und erteilt keine Freigabe.
//
// KRITISCHE UNTERSCHEIDUNG - diese vier Begriffe sind NICHT dasselbe:
//   CAPABILITY GATE   != OPERATION AUTHORIZATION != USER APPROVAL != EXECUTION
//
// Ein ALLOW-Ergebnis bedeutet AUSSCHLIESSLICH:
//   "Diese grobe Capability-Policy verlangt unter diesem Policy-Snapshot
//    keine zusaetzliche Freigabe."
// Es bedeutet NIEMALS:
//   "Diese Operation ist sicher und darf jetzt ausgefuehrt werden."
// Weitere verpflichtende Pruefungen (Pfad-Containment, Rule-Parsing,
// Command-Sandboxing, Nutzerfreigabe pro Operation, ...) existieren noch
// nicht und werden diese Schicht NIEMALS ersetzen, nur ergaenzen.
//
// Vorrangreihenfolge (eingefroren):
// Technische Faehigkeiten/Berechtigungen > Projekt-Regeln > explizite
// Nutzer-Entscheidungen > Work-Request-Absicht > aktueller Plan >
// Aufgaben-Anweisungen > Projekt-Kontext.
//
// Ein Work Request ist keine Berechtigung. Ein Plan ist keine Berechtigung.
// Ein Task ist keine Berechtigung. Ein ControllerTaskDraft ist keine
// Berechtigung. Agent-Ausgabe ist keine Berechtigung. Ein AgentDescriptor
// ist kein Sicherheits-Principal. Legacy Actor/AiRole/NextActor-Werte sind
// keine authentifizierte Autoritaet. Eine im Text behauptete Freigabe ist
// keine Freigabe. Planung ist keine Ausfuehrung. Validierung ist keine
// Autorisierung.

/**
 * V1-Taxonomie. Kanonische Reihenfolge - wird von resolveCapabilityRequest()
 * fuer eine stabile, eingabereihenfolge-unabhaengige Ausgabe verwendet.
 *
 * KEINE Vererbung zwischen Capabilities:
 *   filesystem.write impliziert NICHT filesystem.read.
 *   git.write impliziert NICHT git.read.
 *   command.execute impliziert KEINEN Dateisystem-, Git-, Netzwerk- oder
 *   sonstigen Zugriff.
 * Jede Capability wird unabhaengig bewertet.
 */
export const CAPABILITY_IDS = ['filesystem.read', 'filesystem.write', 'git.read', 'git.write', 'command.execute'] as const

export type CapabilityId = (typeof CAPABILITY_IDS)[number]

// Enge Bedeutung je Capability - absichtlich schmal, kein generisches ACL:
//   filesystem.read    = Eignung fuer explizit implementierte, lesende
//                         Projektdatei-Zugriffe.
//   filesystem.write   = Eignung fuer explizit implementierte, aendernde
//                         Projektdatei-Zugriffe.
//   git.read           = Eignung fuer feste, lesende Repository-Inspektions-
//                         Operationen.
//   git.write          = Eignung fuer explizit implementierte, lokale
//                         Git-Mutationsoperationen (niemals beliebige
//                         Git-Befehle, reset/clean/Hooks/push/Remote-
//                         Aenderungen).
//   command.execute    = Eignung fuer eine zukuenftige, eingeschraenkte
//                         Prozessoperation. M4.5 liefert dafuer KEINE
//                         produktive Ausfuehrungsunterstuetzung.

export const CAPABILITY_POLICY_MODES = ['DENY', 'REQUIRES_APPROVAL', 'ALLOW'] as const

export type CapabilityPolicyMode = (typeof CAPABILITY_POLICY_MODES)[number]

// DENY               = das Capability-Gate lehnt diese Anfrage unter diesem
//                       Policy-Snapshot ab.
// REQUIRES_APPROVAL  = die Standard-Policy erlaubt kein Fortfahren. Eine
//                       zukuenftige, operations-spezifische, revisions-
//                       gebundene Freigabe waere noetig.
// ALLOW              = das grobe Capability-Gate verlangt keine zusaetzliche
//                       Freigabe. Dies ist NICHT die vollstaendige
//                       Operations-Autorisierung.
// Fehlender Policy-Eintrag = DENY. Kein vierter Zustand.

export const CAPABILITY_EVALUATION_REASONS = [
  'PROJECT_MISMATCH',
  'UNSUPPORTED',
  'PROJECT_ARCHIVED',
  'RULE_RESTRICTION',
  'POLICY_DENIED',
  'POLICY_UNSET',
  'APPROVAL_REQUIRED',
  'POLICY_ALLOWED'
] as const

export type CapabilityEvaluationReason = (typeof CAPABILITY_EVALUATION_REASONS)[number]

/**
 * Angefragte Capability-Bewertung - NICHTS weiter. Verleiht KEINE Autoritaet.
 *
 * Bewusst OHNE: agentId, agent, provider, model, approved, approval,
 * granted, permissions, supportedCapabilities, policy, policyMode,
 * autonomy, root, path, command, arguments, tools.
 *
 * WICHTIGE ZUKUENFTIGE INVARIANTE: eine zukuenftige, vertrauenswuerdige
 * Operations-Implementierung bestimmt ihre PFLICHT-Capabilities
 * UNABHAENGIG selbst. Ein Agent kann ein Sicherheits-Gate nicht dadurch
 * umgehen, dass er eine Capability einfach aus diesem Request weglaesst -
 * dieses Objekt ist nur die angefragte Teilmenge, niemals die vollstaendige
 * Definition dessen, was eine Operation tatsaechlich braucht.
 *
 * `projectId` allein begruendet ebenfalls KEINE Projekt-Autoritaet - es muss
 * gegen den vertrauenswuerdigen, Main-eigenen Kontext abgeglichen werden
 * (siehe resolveCapabilityRequest: PROJECT_MISMATCH).
 */
export interface CapabilityRequest {
  projectId: number
  capabilities: CapabilityId[]
}

/**
 * Vertrauenswuerdiger, Main-eigener Policy-Snapshot. TypeScript macht dieses
 * Objekt NICHT vertrauenswuerdig - das ist ausschliesslich Aufgabe des
 * Aufrufers. Produktive Aufrufer MUESSEN dieses Objekt aus vertrauens-
 * wuerdigem Anwendungszustand aufbauen, NIEMALS aus: Repository-Text,
 * Tasks, Work Requests, Agent-Ausgabe, vom Renderer gelieferter Policy,
 * oder Prompt-Inhalt.
 *
 * - supportedCapabilities: Capabilities, die die vertrauenswuerdige
 *   Operations-/Tool-Umgebung tatsaechlich unterstuetzt.
 * - policy: expliziter, grober Policy-Snapshot.
 * - ruleDeniedCapabilities: vertrauenswuerdige, GROBE DENY-NUR-
 *   Einschraenkungen aus maschinell durchsetzbaren Regel-/System-
 *   Constraints.
 *
 * WICHTIG: M4.5 parst KEIN beliebiges Markdown der Projekt-Regeln.
 * ruleDeniedCapabilities = [] bedeutet "es wurde keine grobe, maschinell
 * durchsetzbare Capability-Ablehnung geliefert" - es bedeutet NICHT "alle
 * Markdown-Projekt-Regeln sind erfuellt". Projekt-Regeln bleiben weiterhin
 * verpflichtend UEBER expliziten Nutzer-Entscheidungen. Ein Capability-ALLOW
 * kann eine bindende Regel-Einschraenkung niemals aufheben.
 */
export interface CapabilityPolicyContext {
  projectId: number
  isArchived: boolean
  supportedCapabilities: CapabilityId[]
  policy: Partial<Record<CapabilityId, CapabilityPolicyMode>>
  ruleDeniedCapabilities: CapabilityId[]
}

/**
 * Ergebnis-Snapshot fuer GENAU EINE Capability EINER Anfrage. Bewusst KEIN
 * wiederverwendbares Ausfuehrungs-Credential - kein Grant-Objekt, kein
 * Token, keine Session (siehe capabilityPolicy.ts). Enthaelt niemals
 * Rohprompts, Befehle, Pfade, Secrets oder interne Umgebungsdaten.
 */
export interface CapabilityEvaluation {
  projectId: number
  capability: CapabilityId
  decision: CapabilityPolicyMode
  reason: CapabilityEvaluationReason
}
