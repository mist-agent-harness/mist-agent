/** Correlation metadata is not a credential. Settlement identity is checked by its issuer. */
export interface DispatchSettlement {
  readonly kind: "dispatch_settlement";
}
