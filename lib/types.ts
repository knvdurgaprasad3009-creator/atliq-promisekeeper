export type ItemType =
  | "promise_by_atliq"
  | "client_deadline"
  | "client_request"
  | "new_lead"
  | "expansion_signal"
  | "revisit"
  | "lost_deal_active"
  | "status_signal"
  | "do_not_contact";

export const ITEM_TYPES: ItemType[] = [
  "promise_by_atliq", "client_deadline", "client_request", "new_lead", "expansion_signal",
  "revisit", "lost_deal_active", "status_signal", "do_not_contact",
];

export const TYPE_LABEL: Record<ItemType, string> = {
  promise_by_atliq: "Our promise",
  client_deadline: "Client deadline",
  client_request: "Client request",
  new_lead: "New lead",
  expansion_signal: "Cross-sell signal",
  revisit: "Revisit",
  lost_deal_active: "Lost deal active again",
  status_signal: "Deal stage change",
  do_not_contact: "Do not contact",
};

export type CrmStatus = "New" | "Contacted" | "Proposal Sent" | "Won" | "Lost";

/** One item exactly as the AI returned it (after server-side validation). */
export interface ExtractedItem {
  type: ItemType;
  summary: string;
  quote: string;
  company: string | null;
  person: string | null;
  contact_email: string | null;
  owner_hint: string | null;
  date_phrase: string | null;
  due_date: string | null;
  status: "open" | "done";
  value_usd: number | null;
  suggested_crm_status: CrmStatus | null;
  referrer: string | null;
  confidence: "high" | "low";
}

export interface DroppedItem {
  item: Partial<ExtractedItem>;
  reason: string;
}

export interface DocResult {
  docId: string;
  relevant: boolean;
  relevanceReason: string;
  suspicious: boolean;
  suspiciousReason: string | null;
  items: ExtractedItem[];
  dropped: DroppedItem[];
  models: string[];
  usage: { input_tokens: number; output_tokens: number };
  error?: string;
}

export interface RunResult {
  ranAt: string;
  asOf: string;
  results: Record<string, DocResult>;
}

export interface CrmRecord {
  lead_id: string;
  company: string;
  contact_name: string;
  contact_email: string;
  source: string;
  service_interest: string;
  status: string;
  est_value_usd: number | null;
  owner: string;
  created_date: string;
  last_contact_date: string;
  next_followup_date: string;
  notes: string;
}

export interface Doc {
  id: string;
  kind: "email" | "note";
  file: string;
  synthetic: boolean;
  date: string;
  title: string;
  emails: string[];
  text: string;
  editorialNotesRemoved: number;
}

export interface TeamMember {
  name: string;
  role: string;
  email: string;
  seller: boolean;
}

export interface Dataset {
  asOf: string;
  team: TeamMember[];
  crm: CrmRecord[];
  docs: Doc[];
}
