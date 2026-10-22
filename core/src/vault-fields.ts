// The vault's kinds of entry and their fields (§15), shared with the app's form.

export type VaultKind = "login" | "card" | "key";

/** The fields each kind of entry holds, and the words for them. */
export const FIELDS: Record<VaultKind, Record<string, string>> = {
  login: { username: "Username or email", password: "Password", code: "Two-factor code (from its seed)" },
  card: { number: "Card number", expiry: "Expiry (MM/YY)", cvc: "Security code", name: "Name on card", zip: "Billing ZIP" },
  key: { key: "Key" },
};

/** An entry as the app sees it: which fields are set, never their values. */
export interface VaultView {
  id: string;
  name: string;
  kind: VaultKind;
  sites: string[];
  fields: string[];
  totp: boolean;
  allowed: string[];
  uses: number;
  last_used: number | null;
}
